import { invoke } from '@tauri-apps/api/core';
import {
  buildCampaignHeader, campaignRequestId, canSync, flattenSteps, hasCapability,
  isActiveRun, isOnline, newCampaignId, parseMarkup, resolveMachine, validateCampaign,
  type CampaignPlayer, type ComputerState, type FleetProject, type FleetSession,
  type Machine, type MessageItem, type Page, type Plan, type Project,
  type RoadmapEnvelope, type Run, type Session,
} from './logic';

// All network traffic goes through Rust: Studio rejects the WebView's Origin header.
// unknown/any ends at this public API boundary; controller models are typed below.
export type Api = (machine: string, method: string, path: string, body?: unknown) => Promise<any>;
export const api: Api = (machine, method, path, body) => invoke('api', {
  machineId: machine, method, path: path.startsWith('/api/v1/') ? path : `/api/v1${path.startsWith('/') ? '' : '/'}${path}`, body: body ?? null,
});
export const encodeId = encodeURIComponent;
export const projectPath = (id: string) => `/api/v1/projects/${encodeId(id)}`;
export const sessionPath = (id: string) => `/api/v1/sessions/${encodeId(id)}`;
export const runPath = (id: string) => `/api/v1/runs/${encodeId(id)}`;
export const newRequestId = () => crypto.randomUUID().replaceAll('-', '');
export const errorText = (error: unknown): string => error instanceof Error ? error.message : typeof error === 'string' ? error : error && typeof error === 'object' && 'message' in error ? String(error.message) : JSON.stringify(error) ?? 'Unknown error';
const isMissing = (error: unknown) => !!error && typeof error === 'object' && 'status' in error && error.status === 404 || /404|not_found|not found/i.test(errorText(error));

async function pages<T>(machine: string, path: string, transport: Api): Promise<T[]> {
  const items: T[] = [];
  let offset = 0;
  do {
    const page: Page<T> = await transport(machine, 'GET', `${path}?limit=200&offset=${offset}`);
    if (!Array.isArray(page.items)) throw new Error('Invalid API page.');
    items.push(...page.items);
    if (page.nextOffset === null || page.nextOffset === undefined) return items;
    if (!Number.isInteger(page.nextOffset) || page.nextOffset <= offset) throw new Error('Invalid API page cursor.');
    offset = page.nextOffset;
  } while (true);
}
export const listProjects = (machine: string, transport: Api = api) => pages<Project>(machine, '/api/v1/projects', transport);
export const listSessions = (machine: string, project: string, transport: Api = api) => pages<Session>(machine, `${projectPath(project)}/sessions`, transport);
export const listRuns = (machine: string, transport: Api = api) => pages<Run>(machine, '/api/v1/runs', transport);
export const listMessages = (machine: string, session: string, transport: Api = api) => pages<MessageItem>(machine, `${sessionPath(session)}/messages`, transport);
export const getRun = (machine: string, run: string, transport: Api = api): Promise<Run> => transport(machine, 'GET', runPath(run));
export const getRoadmap = (machine: string, project: string, transport: Api = api): Promise<RoadmapEnvelope> => transport(machine, 'GET', `${projectPath(project)}/roadmap`);
export interface FileRef { id: string; name?: string; path?: string; [key: string]: unknown }
export const listFiles = (machine: string, session: string, transport: Api = api) => pages<FileRef>(machine, `${sessionPath(session)}/files`, transport);
export const stopRun = (machine: string, run: string, transport: Api = api) => transport(machine, 'POST', `${runPath(run)}/stop`, {});
export const sendMessage = (machine: string, session: string, message: string, mode: 'steer' | 'follow_up' = 'steer', transport: Api = api) => transport(machine, 'POST', `${sessionPath(session)}/messages`, { requestId: newRequestId(), mode, message });
export const getComputerUse = async (machine: string, transport: Api = api): Promise<ComputerState> => {
  const state = await transport(machine, 'GET', '/api/v1/computer-use');
  const flags = ['supported', 'enabled', 'busy', 'ownerHidden', 'cleanupPending', 'cleanupFailed'];
  if (!state || typeof state !== 'object' || flags.some(key => typeof state[key] !== 'boolean') ||
    !Number.isInteger(state.revision) || state.revision < 0 || typeof state.machineId !== 'string' || !state.machineId.trim() ||
    !('owner' in state) || state.owner !== null && (typeof state.owner !== 'object' || Array.isArray(state.owner)))
    throw new Error('Computer Use state could not be verified. Inspect Studio before continuing.');
  return state;
};
export type ComputerMutation = { enabled: boolean; expectedRevision: number } & ({ runId: string; sessionId?: never } | { sessionId: string; runId?: never });
export const setComputerUse = (machine: string, body: ComputerMutation, transport: Api = api): Promise<ComputerState> => transport(machine, 'POST', '/api/v1/computer-use', body);
export const syncProject = (machine: Machine, projectId: string, sessionId?: string, transport: Api = api): Promise<unknown> => {
  if (!canSync(machine)) throw new Error(`${machine.name}: sync capability and sync:write permission are required.`);
  // Proposed route: never call it on machines that do not advertise sync.
  return transport(machine.id, 'POST', `${projectPath(projectId)}/sync`, sessionId ? { sessionId } : {});
};

// Public work targets are shared by the launch controllers.
export type WorkTarget = { kind: 'plan'; planId: string; stepId?: string } | { kind: 'milestone'; milestoneId: string } | { kind: 'backlog'; number: number };
export interface RoadmapWork {
  requestId: string; expectedRevision: number; targets: WorkTarget[]; instructions?: string;
  sessionId?: string; model?: string; thinking?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}
export interface WorkAccepted { accepted: true; queued: boolean; linkWarning?: boolean; run: Run; sessionId: string | null; requestId: string; roadmap?: RoadmapEnvelope['roadmap']; machineId: string; projectId: string }
const needsReread = (error: unknown) => {
  const status = error && typeof error === 'object' && 'status' in error ? Number(error.status) : undefined;
  return status === undefined || status === 409 || status >= 500;
};
export async function workRoadmap(machine: string, project: string, body: RoadmapWork, transport: Api = api): Promise<WorkAccepted> {
  if (body.instructions && body.instructions.length > 4000) throw new Error('Instructions exceed 4000 characters.');
  if (!body.targets.length || body.targets.length > 20) throw new Error('Select 1–20 work targets.');
  try { return await transport(machine, 'POST', `${projectPath(project)}/roadmap/work`, body); }
  catch (error) { if (needsReread(error)) await getRoadmap(machine, project, transport).catch(() => undefined); throw error; }
}
export function projectCopy(project: FleetProject, machine: Machine): Project {
  const copy = project.copies.find(p => p.machineId === machine.id || p.machineId === machine.machineId);
  if (!copy || copy.exists === false) throw new Error(`${machine.name}: project is not present.`);
  return copy;
}
const belongsToMachine = (id: string, machine: Machine) => id === machine.id || id === machine.machineId;
const canonical = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? '';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`;
};
export const sameLastMessage = (a: MessageItem[], b: MessageItem[]) => canonical(a.at(-1) ?? null) === canonical(b.at(-1) ?? null);
export interface ContinueOptions {
  project: FleetProject; session: FleetSession; machines: Machine[]; target: Machine; message: string;
  activeAction?: 'wait' | 'stop'; mode?: 'steer' | 'follow_up';
}
export type ContinueResult = { status: 'started'; run: Run } | { status: 'sent'; machineId: string } | { status: 'blocked'; reason: 'active' | 'stopping' | 'not-synced'; run?: Run };
export async function continueConversation(options: ContinueOptions, transport: Api = api): Promise<ContinueResult> {
  const { project, session, machines, target, message } = options;
  if (!isOnline(target)) throw new Error(`${target.name}: machine is offline.`);
  let source = machines.find(m => belongsToMachine(session.newest.machineId, m));
  if (!source) throw new Error('Source machine is unknown.');
  const targetProject = projectCopy(project, target);
  let sourceProject = projectCopy(project, source);
  // Reread known activity, including a third machine, before deciding to migrate.
  let active = session.activeRun;
  if (active) {
    const owner = machines.find(m => belongsToMachine(active!.machineId, m));
    if (!owner) throw new Error('Active run machine is unknown.');
    const fresh = await getRun(owner.id, active.id, transport);
    active = isActiveRun(fresh) ? fresh : undefined;
  }
  const hosts = machines.filter(machine => project.copies.some(copy => belongsToMachine(copy.machineId, machine)));
  if (hosts.some(machine => !isOnline(machine))) throw new Error('A project machine is offline. Inspect its run before continuing elsewhere.');
  const visible = await Promise.all(hosts.map(machine => listRuns(machine.id, transport)));
  const live = visible.flat().filter(run => run.sessionId === session.id && isActiveRun(run));
  if (active && !live.some(run => run.id === active!.id && run.machineId === active!.machineId)) live.push(active);
  if (live.length > 1) throw new Error('This conversation has multiple active runs. Stop the extra runs in Studio before continuing.');
  active = live[0];
  if (active) {
    const owner = machines.find(m => belongsToMachine(active!.machineId, m));
    if (!owner) throw new Error('Active run machine is unknown.');
    if (owner.id === target.id) {
      await sendMessage(owner.id, session.id, message, options.mode ?? 'steer', transport);
      return { status: 'sent', machineId: owner.id };
    }
    if (options.activeAction !== 'stop') return { status: 'blocked', reason: 'active', run: active };
    await stopRun(owner.id, active.id, transport);
    const fresh = await getRun(owner.id, active.id, transport);
    if (isActiveRun(fresh)) return { status: 'blocked', reason: 'stopping', run: fresh };
    source = owner; sourceProject = projectCopy(project, source);
  }
  if (source.id !== target.id) {
    if (canSync(source) && canSync(target)) {
      await syncProject(source, sourceProject.id, session.id, transport);
      await syncProject(target, targetProject.id, session.id, transport);
    }
    // Also verify after sync: the proposed state vocabulary is not yet fixed.
    // This conservative check catches incomplete/failed sync without guessing states.
    try {
      const [a, b] = await Promise.all([listMessages(source.id, session.id, transport), listMessages(target.id, session.id, transport)]);
      if (!sameLastMessage(a, b)) return { status: 'blocked', reason: 'not-synced' };
    } catch (error) {
      if (isMissing(error)) return { status: 'blocked', reason: 'not-synced' };
      throw error;
    }
  }
  const run: Run = await transport(target.id, 'POST', `${projectPath(targetProject.id)}/runs`, { requestId: newRequestId(), sessionId: session.id, message });
  return { status: 'started', run };
}

export async function launchStep(options: { project: FleetProject; planId: string; stepId: string; machine: Machine; instructions?: string; requestId?: string; expectedStep?: CampaignPlayer['step']; expectedSummary?: string; beforeWork?: () => Promise<void>; onSending?: () => void }, transport: Api = api): Promise<WorkAccepted> {
  const { project, planId, stepId, machine } = options;
  if (!isOnline(machine)) throw new Error(`${machine.name}: machine is offline.`);
  const copy = projectCopy(project, machine);
  let roadmap = (await getRoadmap(machine.id, copy.id, transport)).roadmap;
  const find = () => flattenSteps(roadmap.plans?.find(plan => plan.id === planId)?.steps ?? []).find(step => step.id === stepId);
  if (!find() && canSync(machine)) {
    await syncProject(machine, copy.id, undefined, transport);
    roadmap = (await getRoadmap(machine.id, copy.id, transport)).roadmap;
  }
  const step = find();
  if (!step) throw new Error('Step is not yet synchronized on this machine.');
  const plan = roadmap.plans?.find(p => p.id === planId);
  if (options.expectedSummary !== undefined && (plan?.summary ?? '') !== options.expectedSummary) throw new Error('Campaign summary changed. Review it before launching.');
  if (step.done) throw new Error('Step is already complete.');
  if (options.expectedStep && (step.text !== options.expectedStep.text || (step.note ?? '') !== (options.expectedStep.note ?? ''))) throw new Error('Player instructions changed. Review the campaign before launching.');
  const markup = parseMarkup(step.note);
  if (markup.assignments.length !== 1 || resolveMachine(markup.machine, [machine])?.id !== machine.id) throw new Error('Step must be assigned to this machine.');
  await options.beforeWork?.();
  options.onSending?.();
  return workRoadmap(machine.id, copy.id, { requestId: options.requestId ?? newRequestId(), expectedRevision: roadmap.revision,
    targets: [{ kind: 'plan', planId, stepId }], ...(options.instructions === undefined ? {} : { instructions: options.instructions }) }, transport);
}

export interface CampaignPlayerResult {
  player: CampaignPlayer; campaignId: string; requestId: string; sent?: boolean; ambiguous?: boolean; status: 'pending' | 'launching' | 'accepted' | 'error' | 'stopped' | 'blocked' | 'degraded';
  accepted?: WorkAccepted; computer?: ComputerState; computerStatus?: 'manual' | 'authorized' | 'revoked'; error?: string;
  safety?: 'healthy' | 'blocked' | 'degraded' | 'manual'; notice?: string; conflictRunIds?: string[];
}
export interface CampaignOptions {
  project: FleetProject; plan: Plan; machines: Machine[]; campaignId?: string; sourceMachine?: Machine;
  onUpdate?: (result: CampaignPlayerResult) => void;
}
const controlBlocked = (state: ComputerState) => state.owner !== null || state.ownerHidden || state.enabled || state.busy || state.cleanupPending || state.cleanupFailed;
const ownsComputer = (state: ComputerState, accepted: WorkAccepted) => {
  // Grants target a run, not a session. A session-only owner cannot prove that an old
  // run in the same conversation did not resume. Legacy stop cleanup stays separate.
  return !state.ownerHidden && state.machineId === accepted.machineId && state.owner?.projectId === accepted.projectId &&
    state.owner.runId === accepted.run.id;
};
// IDs from the API are canonical. Never exclude a run by campaign label, session or project name.
export async function campaignActivity(machine: Machine, projectId: string, rows: CampaignPlayerResult[], transport: Api = api) {
  const active = (await listRuns(machine.id, transport)).filter(isActiveRun);
  const validId = (id: unknown): id is string => typeof id === 'string' && id.trim().length > 0;
  const identityUnknown = active.filter(run => !validId(run.id) || !validId(run.machineId) || run.machineId !== (machine.machineId ?? machine.id));
  const runs = active.filter(run => validId(run.id) && validId(run.machineId) && run.machineId === (machine.machineId ?? machine.id));
  const own = new Set(rows.filter(row => row.player.machine.id === machine.id && row.accepted?.projectId === projectId &&
    belongsToMachine(row.accepted.machineId, machine) && belongsToMachine(row.accepted.run.machineId, machine)).map(row => row.accepted!.run.id));
  const conflictRunIds = runs.filter(run => run.projectId === projectId && !own.has(run.id)).map(run => run.id);
  const unknown = runs.filter(run => !validId(run.projectId) && !own.has(run.id)).map(run => run.id);
  const error = conflictRunIds.length ? `Other active runs in this project: ${conflictRunIds.join(', ')}. Further dispatch is blocked. No unrelated run was stopped.`
    : identityUnknown.length ? `Active run identities do not match this machine: ${identityUnknown.map(run => run.id || '(missing run ID)').join(', ')}. Project safety cannot be verified. Further dispatch is blocked.`
    : unknown.length ? `Active runs have unknown project IDs: ${unknown.join(', ')}. Project safety cannot be verified. Further dispatch is blocked.` : undefined;
  return { conflictRunIds, error };
}
export async function refreshCampaignPlayer(previous: CampaignPlayerResult, rows: CampaignPlayerResult[], transport: Api = api,
  activity?: Awaited<ReturnType<typeof campaignActivity>>): Promise<CampaignPlayerResult> {
  const row = { ...previous }, accepted = row.accepted;
  if (!accepted) return row;
  try {
    const run = await getRun(row.player.machine.id, accepted.run.id, transport);
    if (run.id !== accepted.run.id || run.machineId !== accepted.machineId || run.projectId !== accepted.projectId) throw new Error('Accepted run identity could not be verified. Inspect Studio before continuing.');
    row.accepted = { ...accepted, run: { ...run, sessionId: run.sessionId ?? accepted.sessionId ?? accepted.run.sessionId } };
    const fresh = activity ?? await campaignActivity(row.player.machine, accepted.projectId, rows, transport);
    row.conflictRunIds = fresh.conflictRunIds;
    let issue = fresh.error;
    if (row.player.gui && hasCapability(row.player.machine, 'computer-use')) {
      // A session-filtered view can hide another global owner; always use the global route.
      row.computer = await getComputerUse(row.player.machine.id, transport);
      if (row.computer.ownerHidden) issue ??= 'Computer Use owner is hidden. Ownership cannot be verified. No takeover was attempted.';
      else if (row.computer.cleanupPending || row.computer.cleanupFailed) issue ??= 'Computer Use cleanup is pending or failed. Ownership cannot be verified.';
      else if (row.computer.owner && !ownsComputer(row.computer, accepted)) issue ??= 'Computer Use belongs to another run or session. No takeover was attempted.';
      else if (isActiveRun(run) && row.computer.supported && (!row.computer.enabled || !ownsComputer(row.computer, accepted))) issue ??= 'Computer Use authorization is not confirmed. Inspect Studio before continuing.';
      else if (!row.computer.supported && controlBlocked(row.computer)) issue ??= 'Computer Use is owned, busy or awaiting cleanup. No takeover was attempted.';
      else if (!row.computer.supported) row.computerStatus = 'manual';
    }
    row.safety = issue ? 'degraded' : row.player.gui && (!row.computer || !row.computer.supported) ? 'manual' : 'healthy';
    row.status = issue ? 'degraded' : isActiveRun(run) ? 'accepted' : 'stopped';
    row.error = issue;
    row.notice = issue ? undefined : row.safety === 'manual' ? 'Enable Computer Use manually in Studio. The player waits up to 2 minutes.'
      : row.player.gui && isActiveRun(run) ? 'Project activity and Computer Use ownership verified.' : 'No other active runs in this project at the last check.';
  } catch (error) {
    row.status = 'degraded'; row.safety = 'degraded'; row.notice = undefined;
    row.error = `Campaign safety check failed: ${errorText(error)}. No retry or takeover was attempted.`;
  }
  return row;
}
// Keep the old manifest and its cleanup controls until all accepted work and leases are resolved.
export async function assertCampaignReplaceable(rows: CampaignPlayerResult[], launching: boolean, transport: Api = api): Promise<void> {
  const blocked = () => new Error('Stop or resolve the current campaign before launching another.');
  if (launching || rows.some(row => row.ambiguous || row.accepted && isActiveRun(row.accepted.run))) throw blocked();
  const guiMachines = [...new Map(rows.filter(row => row.accepted && row.player.gui && hasCapability(row.player.machine, 'computer-use'))
    .map(row => [row.player.machine.id, row.player.machine])).values()];
  // Terminal runs can still hold Computer Use. A failed/hidden ownership read is not a release.
  for (const machine of guiMachines) {
    const state = await getComputerUse(machine.id, transport);
    if (state.machineId !== (machine.machineId ?? machine.id) || controlBlocked(state)) throw blocked();
  }
}
export async function launchCampaign(options: CampaignOptions, transport: Api = api): Promise<CampaignPlayerResult[]> {
  const { project, plan, machines } = options, campaignId = options.campaignId ?? newCampaignId();
  const validation = validateCampaign(plan, machines, campaignId);
  if (validation.errors.length) throw new Error(validation.errors.join('\n'));
  for (const player of validation.players) projectCopy(project, player.machine);
  if (options.sourceMachine) projectCopy(project, options.sourceMachine);
  const rows: CampaignPlayerResult[] = validation.players.map(player => ({ player, campaignId, requestId: campaignRequestId(campaignId, player.step.id), status: 'pending' }));
  const update = (row: CampaignPlayerResult) => options.onUpdate?.({ ...row });
  const targets = [...new Map(rows.map(row => [row.player.machine.id, row.player.machine])).values()];
  const checkActivity = async (machine: Machine) => {
    const activity = await campaignActivity(machine, projectCopy(project, machine).id, rows, transport);
    if (activity.error) throw new Error(`${machine.name}: ${activity.error}`);
  };
  // Read ALL target activity and global ownership before ANY write (including sync).
  const preflight = await Promise.allSettled(targets.map(checkActivity));
  const ownership = await Promise.allSettled(rows.filter(row => row.player.gui).map(async row => {
    if (!hasCapability(row.player.machine, 'computer-use')) { row.computerStatus = 'manual'; return; }
    row.computer = await getComputerUse(row.player.machine.id, transport);
    if (controlBlocked(row.computer)) throw new Error(`${row.player.machine.name}: Computer Use is owned, busy or awaiting cleanup. Cancel or release it in Studio.`);
    if (!row.computer.supported) row.computerStatus = 'manual';
  }));
  const failures = [...preflight, ...ownership].filter(result => result.status === 'rejected');
  if (failures.length) {
    const error = failures.map(result => errorText(result.reason)).join('\n');
    for (const row of rows) { row.status = 'blocked'; row.safety = 'blocked'; row.error = error; update(row); }
    throw new Error(error);
  }
  if (options.sourceMachine && canSync(options.sourceMachine)) await syncProject(options.sourceMachine, projectCopy(project, options.sourceMachine).id, undefined, transport);
  const syncFailures = new Map<string, string>();
  await Promise.all(targets.map(async machine => {
    try { if (canSync(machine) && machine.id !== options.sourceMachine?.id) await syncProject(machine, projectCopy(project, machine).id, undefined, transport); }
    catch (error) { syncFailures.set(machine.id, errorText(error)); }
  }));
  let blocked: string | undefined;
  // Serialize dispatch: a raced conflict/uncertain acceptance blocks every not-yet-sent player.
  // API v1 has no distributed lock; these snapshots cannot eliminate a later Studio resume race.
  for (const row of rows) {
    const machine = row.player.machine;
    if (blocked || syncFailures.has(machine.id)) {
      row.status = 'blocked'; row.safety = 'blocked'; row.error = blocked ?? syncFailures.get(machine.id); update(row); continue;
    }
    row.status = 'launching'; update(row);
    try {
      row.accepted = await launchStep({ project, planId: plan.id, stepId: row.player.step.id, machine,
        instructions: buildCampaignHeader(campaignId, row.player, validation.players, plan.summary),
        requestId: row.requestId, expectedStep: row.player.step, expectedSummary: plan.summary ?? '',
        beforeWork: async () => {
          try { await checkActivity(machine); }
          catch (error) { blocked = errorText(error); throw error; }
        }, onSending: () => { row.sent = true; update(row); } }, transport);
      row.status = 'accepted'; update(row);
      const canonicalMachine = machine.machineId ?? machine.id, localProject = projectCopy(project, machine).id;
      if (typeof row.accepted.run.id !== 'string' || !row.accepted.run.id.trim() || row.accepted.machineId !== canonicalMachine || row.accepted.run.machineId !== canonicalMachine ||
        row.accepted.projectId !== localProject || row.accepted.run.projectId !== localProject) throw new Error('Accepted run identity could not be verified. Inspect Studio before continuing.');
      // Preserve accepted run/session/request identities even if the next read or authorization fails.
      const activity = await campaignActivity(machine, projectCopy(project, machine).id, rows, transport);
      row.conflictRunIds = activity.conflictRunIds;
      if (activity.error) throw new Error(activity.error);
      if (row.player.gui && hasCapability(machine, 'computer-use')) {
        const current = await getComputerUse(machine.id, transport);
        row.computer = current;
        if (controlBlocked(current)) throw new Error('Computer Use ownership changed. No takeover was attempted.');
        if (!current.supported) row.computerStatus = 'manual';
        else if (row.computerStatus !== 'manual') {
          try {
            await setComputerUse(machine.id, { enabled: true, expectedRevision: current.revision, runId: row.accepted.run.id }, transport);
          } catch (error) {
            row.computer = await getComputerUse(machine.id, transport).catch(() => undefined);
            throw error; // Never retry an uncertain authorization write.
          }
          row.computerStatus = 'authorized';
        }
      }
      // Includes a GLOBAL owner reread after the grant, not just its mutation response.
      Object.assign(row, await refreshCampaignPlayer(row, rows, transport, row.computerStatus === 'authorized' ? undefined : activity));
      if (row.safety === 'degraded') blocked = row.error;
      update(row);
    } catch (error) {
      row.status = row.accepted ? 'degraded' : blocked ? 'blocked' : 'error';
      row.safety = row.accepted ? 'degraded' : blocked ? 'blocked' : undefined;
      row.error = errorText(error); row.notice = undefined;
      const status = error && typeof error === 'object' && 'status' in error ? Number(error.status) : undefined;
      row.ambiguous = !!row.sent && !row.accepted && (status === undefined || status >= 500);
      if (row.accepted || row.ambiguous) blocked = row.error;
      update(row);
    }
  }
  return rows;
}
export async function stopCampaign(rows: CampaignPlayerResult[], transport: Api = api): Promise<CampaignPlayerResult[]> {
  return Promise.all(rows.map(async previous => {
    const row = { ...previous }, accepted = row.accepted;
    if (!accepted) return row;
    try {
      await stopRun(row.player.machine.id, accepted.run.id, transport);
      row.status = 'stopped';
      if (row.player.gui && hasCapability(row.player.machine, 'computer-use')) {
        const current = await getComputerUse(row.player.machine.id, transport);
        const sessionId = accepted.sessionId ?? accepted.run.sessionId;
        const ours = current.owner?.projectId === accepted.projectId && (current.owner?.runId ? current.owner.runId === accepted.run.id : !!sessionId && current.owner?.sessionId === sessionId);
        if (ours && !current.ownerHidden) {
          row.computer = await setComputerUse(row.player.machine.id, { enabled: false, expectedRevision: current.revision,
            ...(sessionId ? { sessionId } : { runId: accepted.run.id }) }, transport);
          row.computerStatus = 'revoked';
        }
      }
    } catch (error) {
      if (row.player.gui && hasCapability(row.player.machine, 'computer-use') && needsReread(error)) {
        row.computer = await getComputerUse(row.player.machine.id, transport).catch(() => row.computer);
      }
      row.error = errorText(error);
    }
    return row;
  }));
}
export const messageCampaign = (rows: CampaignPlayerResult[], message: string, mode: 'steer' | 'follow_up' = 'steer', transport: Api = api) => Promise.allSettled(rows.filter(row => row.accepted?.sessionId).map(row => sendMessage(row.player.machine.id, row.accepted!.sessionId!, message, mode, transport)));
