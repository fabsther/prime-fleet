import { describe, expect, it } from 'vitest';
import { assertCampaignReplaceable, campaignActivity, launchCampaign, refreshCampaignPlayer, type Api, type CampaignPlayerResult, type WorkAccepted } from './api';
import { validateCampaign, type ComputerState, type FleetProject, type Machine, type Plan, type Run } from './logic';

const a: Machine = { id: 'transport-a', machineId: 'studio-a', name: 'A', url: '', online: true, capabilities: [] };
const b: Machine = { ...a, id: 'transport-b', machineId: 'studio-b', name: 'B' };
const gui: Machine = { ...a, capabilities: ['computer-use'] };
const project: FleetProject = { key: 'game', name: 'Game', syncId: 'shared', copies: [a, b].map(m => ({ id: `p-${m.name}`, name: 'Game', syncId: 'shared', machineId: m.machineId! })) };
const plan: Plan = { id: 'plan', summary: '@campaign', steps: [{ id: 'one', text: 'One', note: '@machine: A', done: false }] };
const guiPlan: Plan = { ...plan, steps: [{ ...plan.steps[0], note: '@machine: A\n@gui' }] };
const two: Plan = { ...plan, steps: [...plan.steps, { id: 'two', text: 'Two', note: '@machine: A', done: false }] };
const run = (id: string, extra: Partial<Run> = {}): Run => ({ id, machineId: 'studio-a', projectId: 'p-A', sessionId: `s-${id}`, status: 'running', startedAt: '', ...extra });
const accepted = (id = 'one', sessionId: string | null = `s-${id}`): WorkAccepted => ({ accepted: true, queued: false, run: run(id, { sessionId }), sessionId, machineId: 'studio-a', projectId: 'p-A', requestId: `accepted-${id}` });
const state = (extra: Partial<ComputerState> = {}): ComputerState => ({ machineId: 'studio-a', revision: 1, supported: true, enabled: false, busy: false, owner: null, ownerHidden: false, cleanupPending: false, cleanupFailed: false, ...extra });
const page = (items: Run[] = []) => ({ items, nextOffset: null });
const roadmap = (p = plan) => ({ roadmap: { revision: 1, plans: [p] } });
const R = '/api/v1/runs?limit=200&offset=0', C = '/api/v1/computer-use', P = '/api/v1/projects/p-A/roadmap', W = `${P}/work`;
type Call = [string, string, unknown, string?];
function strict(calls: Call[]) {
  const seen: Call[] = [];
  const transport: Api = async (m, method, path, body) => {
    const next = calls.shift();
    expect(next, `Unexpected ${m} ${method} ${path}`).toBeDefined();
    expect([method, path, m]).toEqual([next![0], next![1], next![3] ?? a.id]);
    seen.push([method, path, body, m]);
    if (next![2] instanceof Error) throw next![2];
    return next![2];
  };
  return { transport, seen, done: () => expect(calls).toEqual([]) };
}
const options = (p = plan, machines = [a]) => ({ project, plan: p, machines, campaignId: 'abcdef012345' });
const row = (p = guiPlan, m = gui, work = accepted()): CampaignPlayerResult => ({ player: validateCampaign(p, [m]).players[0], campaignId: 'abcdef012345', requestId: 'request-one', status: 'accepted', accepted: work });

// Each mock consumes an exact call sequence: no unexpected writes, retries or scoped owner views.
describe('campaign project isolation and dispatch races', () => {
  it('batch-preflights all targets before any write, even when one has a conflict', async () => {
    const p = { ...plan, steps: [...plan.steps, { id: 'guest', text: 'Guest', note: '@machine: B', done: false }] };
    const mock = strict([['GET', R, page([run('old-guest')])], ['GET', R, page(), b.id]]);
    await expect(launchCampaign(options(p, [a, b]), mock.transport)).rejects.toThrow('old-guest');
    expect(mock.seen.every(c => c[0] === 'GET')).toBe(true); mock.done();
  });
  it('allows another project and excludes only the exact accepted campaign IDs on this machine', async () => {
    const unrelated = run('unrelated', { projectId: 'different-project' });
    const mock = strict([
      ['GET', R, page([unrelated])], ['GET', P, roadmap(two)], ['GET', R, page([unrelated])], ['POST', W, accepted()],
      ['GET', R, page([unrelated, run('one')])], ['GET', '/api/v1/runs/one', run('one')],
      ['GET', P, roadmap(two)], ['GET', R, page([unrelated, run('one')])], ['POST', W, accepted('two')],
      ['GET', R, page([unrelated, run('one'), run('two')])], ['GET', '/api/v1/runs/two', run('two')],
    ]);
    const rows = await launchCampaign(options(two), mock.transport);
    expect(rows.map(r => r.status)).toEqual(['accepted', 'accepted']);
    expect(rows.map(r => r.safety)).toEqual(['healthy', 'healthy']); mock.done();
  });
  it('filters exact machine and project IDs and terminal/cancelled runs, across pages', async () => {
    const first = '/api/v1/runs?limit=200&offset=0', second = '/api/v1/runs?limit=200&offset=200';
    const mock = strict([
      ['GET', first, { items: [run('other-machine', { machineId: 'studio-b' }), run('cancelled', { status: 'cancelled' })], nextOffset: 200 }],
      ['GET', second, page([run('canceled', { status: 'canceled' }), run('ended', { endedAt: 'today' }), run('running-other', { projectId: 'p-B' }), run('real-conflict')])],
    ]);
    expect(await campaignActivity(a, 'p-A', [], mock.transport)).toMatchObject({ conflictRunIds: ['real-conflict'] }); mock.done();
  });
  it.each([undefined, 'studio-foreign', 42, ''])('blocks malformed active machine identity %s without assuming a project conflict', async (machineId) => {
    const mock = strict([['GET', R, page([run('unknown-machine', { machineId: machineId as unknown as string })])]]);
    await expect(launchCampaign(options(), mock.transport)).rejects.toThrow('identities do not match this machine'); mock.done();
  });
  it('does not claim a missing project ID is a same-project conflict, but blocks unsafe launch', async () => {
    for (const projectId of [undefined, 42, '', ' ']) {
      const mock = strict([['GET', R, page([run('unknown', { projectId: projectId as unknown as string })])]]);
      await expect(launchCampaign(options(), mock.transport)).rejects.toThrow('unknown project IDs'); mock.done();
    }
  });
  it('catches a race after sync and fresh roadmap read, immediately before work POST', async () => {
    const syncA = { ...a, capabilities: ['sync'], syncAllowed: true };
    const mock = strict([
      ['GET', R, page()], ['POST', '/api/v1/projects/p-A/sync', {}],
      ['GET', P, roadmap(two)], ['GET', R, page([run('resumed')])],
    ]);
    const rows = await launchCampaign(options(two, [syncA]), mock.transport);
    expect(rows.map(r => r.status)).toEqual(['blocked', 'blocked']);
    expect(rows.some(r => r.sent)).toBe(false); mock.done();
  });
  it('preserves accepted run/session/request identity and blocks the next player after a postaccept race', async () => {
    const work = accepted('one', null);
    const mock = strict([
      ['GET', R, page()], ['GET', P, roadmap(two)], ['GET', R, page()], ['POST', W, work],
      ['GET', R, page([work.run, run('resumed-old-guest')])],
    ]);
    const rows = await launchCampaign(options(two), mock.transport);
    expect(rows[0]).toMatchObject({ status: 'degraded', accepted: work, conflictRunIds: ['resumed-old-guest'] });
    expect(rows[0].accepted).toBe(work); expect(rows[1]).toMatchObject({ status: 'blocked' });
    expect(mock.seen.filter(c => c[0] === 'POST')).toHaveLength(1); mock.done();
  });
  it('does not retry uncertain work and blocks the remaining campaign', async () => {
    const mock = strict([
      ['GET', R, page()], ['GET', P, roadmap(two)], ['GET', R, page()], ['POST', W, new Error('timeout')], ['GET', P, roadmap(two)],
    ]);
    const rows = await launchCampaign(options(two), mock.transport);
    expect(rows[0]).toMatchObject({ ambiguous: true, sent: true, status: 'error' });
    expect(rows[1].status).toBe('blocked'); mock.done();
  });
});

describe('campaign global Computer Use ownership and later status checks', () => {
  const beforeGrant = (): Call[] => [
    ['GET', R, page()], ['GET', C, state()], ['GET', P, roadmap(guiPlan)], ['GET', R, page()],
    ['POST', W, accepted()], ['GET', R, page([run('one')])], ['GET', C, state({ revision: 7 })],
  ];
  it.each([
    ['unexpected run', state({ enabled: true, owner: { projectId: 'p-A', runId: 'old-guest', sessionId: 's-one' } })],
    ['other session', state({ enabled: true, owner: { projectId: 'p-A', sessionId: 'old-session' } })],
    ['session-only owner', state({ enabled: true, owner: { projectId: 'p-A', sessionId: 's-one' } })],
    ['foreign machine owner', state({ machineId: 'studio-other', enabled: true, owner: { projectId: 'p-A', runId: 'one' } })],
    ['hidden owner', state({ enabled: true, ownerHidden: true })],
    ['failed reread', new Error('global reread failed')],
  ])('rereads global owner after grant: %s preserves acceptance and displays degraded', async (_name, response) => {
    const mock = strict([...beforeGrant(), ['POST', C, state()], ['GET', '/api/v1/runs/one', run('one')], ['GET', R, page([run('one')])], ['GET', C, response]]);
    const [result] = await launchCampaign(options(guiPlan, [gui]), mock.transport);
    expect(result).toMatchObject({ status: 'degraded', safety: 'degraded', accepted: { run: { id: 'one' }, sessionId: 's-one', requestId: 'accepted-one' } });
    expect(result.notice).toBeUndefined();
    expect(mock.seen.filter(c => c[0] === 'POST' && c[1] === C)).toHaveLength(1); mock.done();
  });
  it('displays healthy only after independent global ownership reread, using run ID with null session', async () => {
    const calls = beforeGrant(); calls[4][2] = accepted('one', null);
    const mock = strict([...calls, ['POST', C, state()], ['GET', '/api/v1/runs/one', run('one', { sessionId: null })], ['GET', R, page([run('one')])], ['GET', C, state({ enabled: true, busy: true, owner: { projectId: 'p-A', runId: 'one' } })]]);
    const [result] = await launchCampaign(options(guiPlan, [gui]), mock.transport);
    expect(result).toMatchObject({ safety: 'healthy', status: 'accepted', notice: 'Project activity and Computer Use ownership verified.' });
    expect(mock.seen.find(c => c[0] === 'POST' && c[1] === C)?.[2]).toEqual({ enabled: true, expectedRevision: 7, runId: 'one' }); mock.done();
  });
  it('rereads activity after the CU grant and blocks next player when another run raced the grant', async () => {
    const p = { ...two, steps: [{ ...guiPlan.steps[0] }, two.steps[1]] };
    const calls = beforeGrant(); calls[2][2] = roadmap(p);
    const mock = strict([...calls, ['POST', C, state()], ['GET', '/api/v1/runs/one', run('one')],
      ['GET', R, page([run('one'), run('raced-during-grant')])], ['GET', C, state({ enabled: true, owner: { projectId: 'p-A', runId: 'one' } })]]);
    const rows = await launchCampaign(options(p, [gui]), mock.transport);
    expect(rows[0]).toMatchObject({ status: 'degraded', conflictRunIds: ['raced-during-grant'], accepted: { run: { id: 'one' } } });
    expect(rows[1].status).toBe('blocked'); expect(rows[0].notice).toBeUndefined(); mock.done();
  });
  it('never grants on an ownership race before authorization and blocks the next player', async () => {
    const p = { ...two, steps: [{ ...guiPlan.steps[0] }, two.steps[1]] };
    const calls = beforeGrant(); calls[2][2] = roadmap(p); calls[6][2] = state({ ownerHidden: true });
    const mock = strict(calls);
    const rows = await launchCampaign(options(p, [gui]), mock.transport);
    expect(rows.map(r => r.status)).toEqual(['degraded', 'blocked']);
    expect(mock.seen.filter(c => c[0] === 'POST')).toHaveLength(1); mock.done();
  });
  it('allows manual unsupported CU only when the global state is clear', async () => {
    const calls = beforeGrant(); calls[1][2] = state({ supported: false }); calls[6][2] = state({ supported: false });
    const mock = strict([...calls, ['GET', '/api/v1/runs/one', run('one')], ['GET', C, state({ supported: false })]]);
    const [result] = await launchCampaign(options(guiPlan, [gui]), mock.transport);
    expect(result).toMatchObject({ status: 'accepted', safety: 'manual', computerStatus: 'manual' }); mock.done();
  });
  it('blocks legacy ownership even if unsupported, before any write', async () => {
    const mock = strict([['GET', R, page()], ['GET', C, state({ supported: false, owner: { projectId: 'other', sessionId: 'legacy' } })]]);
    await expect(launchCampaign(options(guiPlan, [gui]), mock.transport)).rejects.toThrow('owned'); mock.done();
  });
  it('never retries an uncertain grant, even if reread shows it applied', async () => {
    const mock = strict([...beforeGrant(), ['POST', C, new Error('grant timed out')], ['GET', C, state({ enabled: true, owner: { projectId: 'p-A', runId: 'one' } })]]);
    const [result] = await launchCampaign(options(guiPlan, [gui]), mock.transport);
    expect(result.status).toBe('degraded'); expect(result.accepted?.run.id).toBe('one'); mock.done();
  });
  it('detects a resumed old guest and other-session global owner on later read-only refresh', async () => {
    const previous = row();
    const mock = strict([
      ['GET', '/api/v1/runs/one', run('one')], ['GET', R, page([run('one'), run('old-guest')])],
      ['GET', C, state({ enabled: true, owner: { projectId: 'p-A', sessionId: 'old-session' } })],
    ]);
    const result = await refreshCampaignPlayer(previous, [previous], mock.transport);
    expect(result).toMatchObject({ safety: 'degraded', status: 'degraded', conflictRunIds: ['old-guest'] });
    expect(result.computer?.owner?.sessionId).toBe('old-session');
    expect(mock.seen.every(c => c[0] === 'GET')).toBe(true); mock.done();
  });
  it('shows another-session owner on later refresh even without a project run conflict', async () => {
    const previous = row();
    const mock = strict([['GET', '/api/v1/runs/one', run('one')], ['GET', R, page([run('one')])], ['GET', C, state({ enabled: true, owner: { projectId: 'p-A', sessionId: 'old-session' } })]]);
    const result = await refreshCampaignPlayer(previous, [previous], mock.transport);
    expect(result).toMatchObject({ safety: 'degraded', conflictRunIds: [] });
    expect(result.error).toContain('another run or session'); mock.done();
  });
  it('cannot verify session-only ownership or another run in that same session', async () => {
    const previous = row();
    for (const [owner, expected] of [
      [{ projectId: 'p-A', sessionId: 's-one' }, 'degraded'],
      [{ projectId: 'p-A', sessionId: 's-one', runId: 'newer' }, 'degraded'],
    ] as const) {
      const mock = strict([['GET', '/api/v1/runs/one', run('one')], ['GET', R, page([run('one')])], ['GET', C, state({ enabled: true, owner })]]);
      expect((await refreshCampaignPlayer(previous, [previous], mock.transport)).safety).toBe(expected); mock.done();
    }
  });
});


describe('campaign manifest replacement guard', () => {
  it('blocks active runs, in-flight launch and ambiguous acceptance without any API write', async () => {
    const mock = strict([]), live = row();
    await expect(assertCampaignReplaceable([live], false, mock.transport)).rejects.toThrow('current campaign');
    await expect(assertCampaignReplaceable([], true, mock.transport)).rejects.toThrow('current campaign');
    await expect(assertCampaignReplaceable([{ ...live, accepted: undefined, ambiguous: true }], false, mock.transport)).rejects.toThrow('current campaign');
    expect(live.accepted?.run.id).toBe('one'); mock.done();
  });
  it.each([
    state({ enabled: true, owner: { projectId: 'p-A', runId: 'one' } }),
    state({ ownerHidden: true }),
    state({ cleanupPending: true }),
    new Error('Ownership read failed'),
  ])('preserves terminal accepted IDs while a lease is unreleased or its read fails', async (response) => {
    const work = accepted(); work.run = { ...work.run, status: 'completed', endedAt: 'now' };
    const previous = row(guiPlan, gui, work);
    const mock = strict([['GET', C, response]]);
    await expect(assertCampaignReplaceable([previous], false, mock.transport)).rejects.toThrow();
    expect(previous.accepted).toBe(work); mock.done();
  });
  it('allows replacement only after terminal work and a clear global lease reread', async () => {
    const work = accepted(); work.run = { ...work.run, status: 'completed', endedAt: 'now' };
    const mock = strict([['GET', C, state()]]);
    await expect(assertCampaignReplaceable([row(guiPlan, gui, work)], false, mock.transport)).resolves.toBeUndefined(); mock.done();
  });
});

it.each(['supported', 'enabled', 'busy', 'ownerHidden', 'cleanupPending', 'cleanupFailed'])('unknown Computer Use %s flag blocks campaign before any write', async (flag) => {
 const unknown = { ...state(), [flag]: undefined };
 const fixture = strict([['GET', R, page()], ['GET', C, unknown]]);
 await expect(launchCampaign(options(guiPlan,[gui]),fixture.transport)).rejects.toThrow('Computer Use state could not be verified');
 expect(fixture.seen.every(call=>call[0] === 'GET')).toBe(true);
 fixture.done();
});
