import { describe, expect, it, vi } from 'vitest';
import { assignMachine, buildCampaignHeader, campaignRequestId, groupProjects, layoutMode,
  mergeSessions, parseMarkup, validateCampaign, type Machine, type Plan, type Run } from './logic';
import { continueConversation, launchCampaign, launchStep, listSessions, sameLastMessage, stopCampaign,
  type Api, type CampaignPlayerResult, type WorkAccepted } from './api';

const machine = (id: string, extra: Partial<Machine> = {}): Machine => ({ id, machineId: `studio-${id}`, name: id.toUpperCase(), url: `https://${id}.ts.net`, online: true, capabilities: [], ...extra });
const a = machine('a'), b = machine('b');
const project = groupProjects([a, b].map(m => ({ id: `p-${m.id}`, name: 'Game', syncId: 'game', machineId: m.machineId! })))[0];
const session = mergeSessions([{ id: 's', title: 'Chat', machineId: a.machineId!, projectId: 'p-a', updatedAt: '2026-01-02' }, { id: 's', title: 'Chat', machineId: b.machineId!, projectId: 'p-b', updatedAt: '2026-01-01' }])[0];
const run = (id: string, machineId = a.machineId!): Run => ({ id, sessionId: 's', projectId: `p-${machineId.replace('studio-', '')}`, machineId, status: 'running', startedAt: '2026-01-03' });
const plan: Plan = { id: 'plan', summary: '@campaign\nSame build.', steps: [
  { id: 'host', text: 'Host', note: '@machine: A\n1. Open lobby.', done: false },
  { id: 'guest', text: 'Guest', note: '@machine: B\n1. Join lobby.', done: false },
  { id: 'bot', text: 'Bot', note: '@machine: A', done: false },
] };
const accepted = (stepId: string, m: string): WorkAccepted => ({ accepted: true, queued: false, run: run(`run-${stepId}`, `studio-${m}`), sessionId: `session-${stepId}`, requestId: `request_${stepId}`, projectId: `p-${m}`, machineId: `studio-${m}` });
const computer = (revision = 1) => ({ machineId: 'studio-a', revision, supported: true, enabled: false, busy: false, owner: null, ownerHidden: false, cleanupPending: false, cleanupFailed: false });

describe('Fleet models and directives', () => {
  it('groups by syncId, with a separate exact-name fallback', () => {
    const groups = groupProjects([
      { id: '1', machineId: 'a', name: 'Game', syncId: 'shared' },
      { id: '2', machineId: 'b', name: 'Renamed', syncId: 'shared' },
      { id: '3', machineId: 'a', name: 'Game', syncId: null },
      { id: '4', machineId: 'b', name: 'Game', syncId: null },
      { id: '5', machineId: 'b', name: 'Game', syncId: 'different' },
    ]);
    expect(groups.map(g => g.copies.length).sort()).toEqual([1, 2, 2]);
  });
  it('dedupes copies, chooses newest history and last run machine', () => {
    const copies = [{ ...session.copies[0], updatedAt: '2026-01-04' }, ...session.copies];
    const result = mergeSessions(copies, [{ ...run('last', b.machineId), status: 'completed', endedAt: '2026-01-05' }])[0];
    expect(result.copies).toHaveLength(2);
    expect(result.newest.updatedAt).toBe('2026-01-04');
    expect(result.lastAgentMachineId).toBe(b.machineId);
    expect(result.activeRun).toBeUndefined();
  });
  it('recognizes standalone case-insensitive directives and replaces assignment', () => {
    const note = 'Actions mention @gui inline.\r\n @MACHINE: A \r\n@gUi\r\n@machine: B';
    expect(parseMarkup(note)).toMatchObject({ assignments: ['A', 'B'], machine: 'B', gui: true });
    const assigned = assignMachine(note, 'studio-a');
    expect(parseMarkup(assigned).assignments).toEqual(['studio-a']);
    expect(assigned.endsWith('@machine: studio-a')).toBe(true);
    expect(assignMachine(assigned, 'studio-a')).toBe(assigned);
    expect(parseMarkup('Mention @campaign inline').campaign).toBe(false);
  });
  it('validates limits, GUI ownership, headers and IDs before launching', () => {
    const valid = validateCampaign(plan, [a, b]);
    expect(valid.errors).toEqual([]);
    const header = buildCampaignHeader('abcdef012345', valid.players[0], valid.players, plan.summary);
    expect(header).toContain('outputs/multitest/abcdef012345/player-1.md');
    expect(header).not.toContain('@campaign');
    expect(validateCampaign({ ...plan, summary: '@campaign\n' + 'x'.repeat(4000) }, [a, b]).errors.join()).toContain('4000');
    const tooManyGui = { ...plan, steps: [plan.steps[0], plan.steps[2]].map(s => ({ ...s, note: s.note + '\n@gui' })) };
    expect(validateCampaign(tooManyGui, [a, b]).errors.join()).toContain('one @gui');
    expect(validateCampaign({ ...plan, steps: Array.from({ length: 9 }, (_, i) => ({ ...plan.steps[0], id: String(i) })) }, [a, b]).errors.join()).toContain('1–8');
    expect(campaignRequestId('abcdef012345', 'x'.repeat(200))).toHaveLength(100);
    expect(() => campaignRequestId('nothex', 'host')).toThrow();
  });
  it('uses viewport size and orientation, not device identity', () => {
    expect(layoutMode(760, 1000)).toMatchObject({ mode: 'phone', drawer: true, maxPanes: 1 });
    expect(layoutMode(800, 1200)).toMatchObject({ mode: 'tablet', split: 'horizontal' });
    expect(layoutMode(1250, 800)).toMatchObject({ mode: 'tablet', split: 'vertical' });
    expect(layoutMode(1600, 900)).toMatchObject({ mode: 'desktop', drawer: false, density: 'wide' });
  });
});

describe('Public API controllers (no write retries)', () => {
  it('reads every page and encodes path IDs', async () => {
    const transport = vi.fn(async (_m, _method, path) => ({ items: [path], nextOffset: path.endsWith('offset=0') ? 200 : null }));
    expect(await listSessions('a', 'id/with space', transport)).toHaveLength(2);
    expect(transport.mock.calls[0][2]).toContain('id%2Fwith%20space');
  });
  it('blocks migration when copies differ and sync capability is absent', async () => {
    const transport = vi.fn(async (m, method, path) => {
      expect(method).toBe('GET');
      return { items: path.includes('/messages') ? [{ id: m, role: 'assistant', text: 'different' }] : [], nextOffset: null };
    });
    const result = await continueConversation({ project, session, machines: [a, b], target: b, message: 'Continue' }, transport);
    expect(result).toEqual({ status: 'blocked', reason: 'not-synced' });
    expect(transport.mock.calls.some(c => c[2].endsWith('/sync'))).toBe(false);
    expect(sameLastMessage([{ text: 'same', role: 'assistant' }], [{ role: 'assistant', text: 'same' }])).toBe(true);
  });
  it('syncs source then target only with explicit capability and permission', async () => {
    const machines = [a, b].map(m => ({ ...m, capabilities: ['sync'], syncAllowed: true }));
    const calls: string[] = [];
    const transport: Api = async (m, method, path) => {
      calls.push(`${m}:${method}:${path}`);
      if (path.endsWith('/sync')) return { state: 'done', changed: true };
      if (method === 'POST') return run('new', b.machineId);
      return { items: path.includes('/messages') ? [{ id: 'same', text: 'synced' }] : [], nextOffset: null };
    };
    expect((await continueConversation({ project, session, machines, target: machines[1], message: 'Continue' }, transport)).status).toBe('started');
    expect(calls.filter(c => c.includes('POST'))).toEqual(['a:POST:/api/v1/projects/p-a/sync', 'b:POST:/api/v1/projects/p-b/sync', 'b:POST:/api/v1/projects/p-b/runs']);
  });
  it('routes live messages to the owner and does not migrate a running session', async () => {
    const liveSession = { ...session, activeRun: run('live') };
    const transport = vi.fn(async (_m, method) => method === 'GET' ? liveSession.activeRun : {});
    expect((await continueConversation({ project, session: liveSession, machines: [a, b], target: b, message: 'x' }, transport)).status).toBe('blocked');
    expect(transport.mock.calls.every(c => c[1] === 'GET')).toBe(true);
    await continueConversation({ project, session: liveSession, machines: [a, b], target: a, message: 'x' }, transport);
    expect(transport.mock.calls.at(-1)?.slice(0, 2)).toEqual(['a', 'POST']);
  });
  it('waits for stop acknowledgement to become terminal before source-owner sync and migration', async () => {
    const c = machine('c', { capabilities: ['sync'], syncAllowed: true });
    const machines: Machine[] = [...[a, b].map(m => ({ ...m, capabilities: ['sync'], syncAllowed: true })), c];
    const fullProject = groupProjects([...project.copies, { id: 'p-c', name: 'Game', syncId: 'game', machineId: c.machineId! }])[0];
    const activeSession = { ...session, activeRun: run('old-run', c.machineId) };
    const calls: string[] = [];
    let stopped = false;
    const transport: Api = async (m, method, path) => {
      calls.push(`${m}:${method}:${path}`);
      if (path.endsWith('/stop')) { stopped = true; return { stopped: true }; }
      if (path.endsWith('/old-run')) return { ...activeSession.activeRun, ...(stopped ? { endedAt: '2026-01-04', status: 'stopped' } : {}) };
      if (path.endsWith('/sync')) return { state: 'done', changed: true };
      if (method === 'POST') return run('new-run', b.machineId);
      return { items: [{ id: 'last', role: 'assistant', text: 'final' }], nextOffset: null };
    };
    const result = await continueConversation({ project: fullProject, session: activeSession, machines, target: machines[1], message: 'Continue', activeAction: 'stop' }, transport);
    expect(result.status).toBe('started');
    expect(calls.filter(c => c.includes(':POST:'))).toEqual([
      'c:POST:/api/v1/runs/old-run/stop', 'c:POST:/api/v1/projects/p-c/sync',
      'b:POST:/api/v1/projects/p-b/sync', 'b:POST:/api/v1/projects/p-b/runs',
    ]);
    const stillRunning: Api = async (_m, method) => method === 'GET' ? activeSession.activeRun : { stopped: true };
    expect(await continueConversation({ project: fullProject, session: activeSession, machines, target: machines[1], message: 'Continue', activeAction: 'stop' }, stillRunning)).toMatchObject({ status: 'blocked', reason: 'stopping' });
  });
  it('refuses an active run owned by an unknown machine without sending anything', async () => {
    const transport = vi.fn();
    await expect(continueConversation({ project, session: { ...session, activeRun: run('unknown', 'studio-unknown') }, machines: [a, b], target: b, message: 'Continue' }, transport)).rejects.toThrow('Active run machine is unknown');
    expect(transport).not.toHaveBeenCalled();
  });
  it('reads fresh revisions per machine and keeps other players after a 409', async () => {
    const calls: string[] = [], revisions: number[] = [];
    let rev = 10;
    const transport: Api = async (m, method, path, body) => {
      calls.push(`${m}:${method}`);
      if (method === 'GET') return { roadmap: { revision: rev++, plans: [plan] } };
      const request = body as { expectedRevision: number; targets: { stepId: string }[] };
      revisions.push(request.expectedRevision);
      if (request.targets[0].stepId === 'host') throw { status: 409, message: 'Revision conflict.' };
      return accepted(request.targets[0].stepId, m);
    };
    const rows = await launchCampaign({ project, plan, machines: [a, b], campaignId: 'abcdef012345' }, transport);
    expect(rows.map(r => r.status)).toEqual(['error', 'accepted', 'accepted']);
    expect(rows[0].ambiguous).toBe(false);
    expect(revisions).toHaveLength(3);
    expect(new Set(revisions).size).toBe(3);
    expect(calls.filter(c => c.startsWith('a'))).toEqual(['a:GET', 'a:POST', 'a:GET', 'a:GET', 'a:POST']); // One read after 409, never a replay.
  });
  it('blocks every launch if GUI is owned, even when reported unsupported', async () => {
    const guiPlan = { ...plan, steps: [{ ...plan.steps[0], note: plan.steps[0].note + '\n@gui' }, plan.steps[1]] };
    const transport = vi.fn(async () => ({ ...computer(), supported: false, owner: { projectId: 'other', runId: 'other' } }));
    await expect(launchCampaign({ project, plan: guiPlan, machines: [machine('a', { capabilities: ['computer-use'] }), b] }, transport)).rejects.toThrow('owned');
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it('rejects changed instructions and records ambiguous work without replay', async () => {
    await expect(launchStep({ project, planId: plan.id, stepId: 'host', machine: a, expectedStep: plan.steps[0] }, async () => ({ roadmap: { revision: 1, plans: [{ ...plan, steps: [{ ...plan.steps[0], note: '@machine: A\nChanged.' }] }] } }))).rejects.toThrow('changed');
    const transport: Api = async (m, method) => {
      if (method === 'GET') return { roadmap: { revision: 1, plans: [plan] } };
      if (m === 'a') throw new Error('Network timeout. Outcome unknown.');
      return accepted('guest', 'b');
    };
    const rows = await launchCampaign({ project, plan, machines: [a, b], campaignId: 'abcdef012345' }, transport);
    expect(rows[0]).toMatchObject({ sent: true, ambiguous: true, requestId: 'cmp_abcdef012345_host' });
    expect(rows[0].accepted).toBeUndefined();
  });
  it('authorizes a fresh accepted run and stops before exact-owner revocation', async () => {
    const guiPlan = { ...plan, steps: [{ ...plan.steps[0], note: plan.steps[0].note + '\n@gui' }] };
    const guiA = machine('a', { capabilities: ['computer-use'] });
    const posts: { path: string; body: any }[] = [];
    const transport: Api = async (m, method, path, body) => {
      if (path === '/api/v1/computer-use' && method === 'GET') return computer(7);
      if (method === 'GET') return { roadmap: { revision: 3, plans: [guiPlan] } };
      posts.push({ path, body });
      return path.endsWith('/work') ? accepted('host', m) : computer(8);
    };
    const rows = await launchCampaign({ project, plan: guiPlan, machines: [guiA, b], campaignId: 'abcdef012345' }, transport);
    expect(posts[1].body).toEqual({ enabled: true, expectedRevision: 7, runId: 'run-host' });
    const stops: string[] = [];
    const stopper: Api = async (_m, method, path, body) => {
      if (method === 'POST') stops.push(path);
      if (path === '/api/v1/computer-use' && method === 'GET') return { ...computer(9), enabled: true, owner: { projectId: 'p-a', runId: 'newer-run', sessionId: 'session-host' } };
      return body;
    };
    await stopCampaign(rows, stopper);
    expect(stops).toEqual(['/api/v1/runs/run-host/stop']); // Newer owner of same session is never revoked.
    const ours: Api = async (_m, method, path, body) => {
      if (method === 'POST') stops.push(path);
      if (method === 'GET') return { ...computer(10), enabled: true, owner: { projectId: 'p-a', runId: 'run-host', sessionId: 'session-host' } };
      if (path === '/api/v1/computer-use') expect(body).toEqual({ enabled: false, expectedRevision: 10, sessionId: 'session-host' });
      return computer(11);
    };
    expect((await stopCampaign(rows as CampaignPlayerResult[], ours))[0].computerStatus).toBe('revoked');
    expect(stops.slice(-2)).toEqual(['/api/v1/runs/run-host/stop', '/api/v1/computer-use']);
  });
});
