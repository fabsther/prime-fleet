// Fleet DTOs keep API extension fields at the boundary, without guessing their shape.
export interface Machine {
  id: string; machineId?: string; name: string; url: string; address?: string; capabilities?: string[];
  status?: 'online' | 'offline' | 'error'; online?: boolean; syncAllowed?: boolean;
}
export interface Project { id: string; name: string; syncId: string | null; machineId: string; exists?: boolean }
export interface FleetProject { key: string; name: string; syncId: string | null; copies: Project[] }
export interface Session { id: string; title: string; machineId: string; projectId: string; updatedAt?: string; createdAt?: string }
export interface Run {
  id: string; sessionId: string | null; projectId: string; machineId: string;
  status: string; startedAt: string; endedAt?: string; interactions?: Record<string, unknown>[];
  error?: string | null;
}
export interface FleetSession {
  id: string; title: string; copies: Session[]; newest: Session;
  lastAgentMachineId: string; activeRun?: Run;
}
export interface MessageItem { id?: string; role?: string; text?: string; thinking?: string; timestamp?: string; [key: string]: unknown }
export interface Page<T> { items: T[]; nextOffset: number | null }
export interface Step {
  id: string; text: string; note?: string; done: boolean; children?: Step[];
  completion?: { machineId: string; sessionId?: string | null; completedAt?: number; [key: string]: unknown } | null;
}
export interface Plan { id: string; title?: string; summary?: string; steps: Step[]; [key: string]: unknown }
export interface Roadmap { revision: number; plans?: Plan[]; [key: string]: unknown }
export interface RoadmapEnvelope { machineId: string; projectId: string; roadmap: Roadmap }
export interface ComputerTarget { projectId: string; runId?: string; sessionId?: string }
export interface ComputerState {
  machineId: string; revision: number; supported: boolean; enabled: boolean; busy: boolean;
  owner: ComputerTarget | null; ownerHidden: boolean; cleanupPending: boolean; cleanupFailed: boolean;
  [key: string]: unknown;
}
export const hasCapability = (machine: Machine, name: string) => machine.capabilities?.includes(name) === true;
export const isOnline = (machine: Machine) => machine.status === 'online' || (machine.status === undefined && machine.online === true);
export const canSync = (machine: Machine) => hasCapability(machine, 'sync') && machine.syncAllowed === true;
const timestamp = (value?: string) => { const n = Date.parse(value ?? ''); return Number.isFinite(n) ? n : 0; };
export const isActiveRun = (run: Run) => !run.endedAt && !['done', 'completed', 'finished', 'failed', 'stopped', 'cancelled', 'canceled', 'error'].includes(run.status.toLowerCase());

export function groupProjects(projects: Project[]): FleetProject[] {
  const groups = new Map<string, FleetProject>();
  for (const project of projects) {
    const key = project.syncId ? `sync:${project.syncId}` : `name:${project.name}`;
    const group = groups.get(key) ?? { key, name: project.name, syncId: project.syncId, copies: [] };
    if (!group.copies.some(copy => copy.machineId === project.machineId && copy.id === project.id)) group.copies.push(project);
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
}
export function mergeSessions(sessions: Session[], runs: Run[] = []): FleetSession[] {
  const grouped = new Map<string, Session[]>();
  for (const session of sessions) {
    const copies = grouped.get(session.id) ?? [];
    const previous = copies.findIndex(copy => copy.machineId === session.machineId);
    if (previous < 0) copies.push(session);
    else if (timestamp(session.updatedAt ?? session.createdAt) >= timestamp(copies[previous].updatedAt ?? copies[previous].createdAt)) copies[previous] = session;
    grouped.set(session.id, copies);
  }
  return [...grouped.entries()].map(([id, copies]) => {
    copies.sort((a, b) => timestamp(b.updatedAt ?? b.createdAt) - timestamp(a.updatedAt ?? a.createdAt) || a.machineId.localeCompare(b.machineId));
    const history = runs.filter(run => run.sessionId === id).sort((a, b) => timestamp(b.endedAt ?? b.startedAt) - timestamp(a.endedAt ?? a.startedAt));
    const activeRun = history.find(isActiveRun);
    return { id, title: copies[0].title, copies, newest: copies[0], lastAgentMachineId: (activeRun ?? history[0])?.machineId ?? copies[0].machineId, activeRun };
  }).sort((a, b) => timestamp(b.newest.updatedAt ?? b.newest.createdAt) - timestamp(a.newest.updatedAt ?? a.newest.createdAt));
}
export function parseMarkup(text = '') {
  const assignments: string[] = [];
  let campaign = false, gui = false;
  const content = text.split(/\r?\n/).filter(line => {
    const machine = line.match(/^\s*@machine\s*:\s*(.*?)\s*$/i);
    if (machine) { assignments.push(machine[1]); return false; }
    if (/^\s*@campaign\s*$/i.test(line)) { campaign = true; return false; }
    if (/^\s*@gui\s*$/i.test(line)) { gui = true; return false; }
    return true;
  }).join('\n').trim();
  return { machine: assignments.at(-1), assignments, campaign, gui, content };
}
export function assignMachine(note: string | undefined, machine: string): string {
  if (!machine.trim() || /[\r\n]/.test(machine)) throw new Error('Machine must be a nonempty single line.');
  const content = (note ?? '').split(/\r?\n/).filter(line => !/^\s*@machine\s*:/i.test(line)).join('\n').trim();
  return `${content ? content + '\n' : ''}@machine: ${machine.trim()}`;
}
export const flattenSteps = (steps: Step[]): Step[] => steps.flatMap(step => [step, ...flattenSteps(step.children ?? [])]);
export const resolveMachine = (value: string | undefined, machines: Machine[]) => {
  if (!value) return undefined;
  const id = machines.find(machine => machine.id === value || machine.machineId === value);
  if (id) return id;
  const matches = machines.filter(machine => machine.name.toLowerCase() === value.toLowerCase());
  return matches.length === 1 ? matches[0] : undefined;
};
export interface CampaignPlayer { step: Step; machine: Machine; index: number; gui: boolean }
export interface CampaignValidation { players: CampaignPlayer[]; errors: string[] }
export function buildCampaignHeader(campaignId: string, player: CampaignPlayer, players: CampaignPlayer[], summary = ''): string {
  if (!/^[a-f0-9]{12}$/i.test(campaignId)) throw new Error('Campaign ID must contain 12 hex characters.');
  // Only @campaign is removed from common instructions; other text is preserved.
  const common = summary.split(/\r?\n/).filter(line => !/^\s*@campaign\s*$/i.test(line)).join('\n').trim();
  const roster = players.map(p => `${p.index}) ${p.machine.name} ${p.step.text}`).join(' ; ');
  const header = `Campagne de test ${campaignId} — joueur ${player.index}/${players.length} : ${player.step.text} (machine ${player.machine.name}).\nJoueurs : ${roster}\nConsignes communes :\n${common}\nRapport : outputs/multitest/${campaignId}/player-${player.index}.md (citer le chemin dans la réponse finale).${player.gui ? '\nComputer Use : attendre au plus 2 minutes son autorisation ; sinon signaler le blocage, sans prendre le contrôle d’une autre cible.' : ''}`;
  if (header.length > 4000) throw new Error('Campaign instructions exceed 4000 characters.');
  return header;
}
export function validateCampaign(plan: Plan, machines: Machine[], campaignId = '000000000000'): CampaignValidation {
  const errors: string[] = [], players: CampaignPlayer[] = [];
  if (!parseMarkup(plan.summary).campaign) errors.push('Plan must contain an @campaign line.');
  const steps = flattenSteps(plan.steps).filter(step => !step.done);
  if (!steps.length || steps.length > 8) errors.push('Campaign must have 1–8 unfinished players.');
  for (const [index, step] of steps.entries()) {
    const markup = parseMarkup(step.note), machine = resolveMachine(markup.machine, machines);
    if (markup.assignments.length !== 1 || !machine) { errors.push(`${step.text}: assign exactly one known machine.`); continue; }
    if (!isOnline(machine)) errors.push(`${machine.name}: machine is not online.`);
    players.push({ step, machine, index: index + 1, gui: markup.gui });
  }
  for (const machine of machines) {
    const assigned = players.filter(p => p.machine.id === machine.id);
    if (assigned.length > 2) errors.push(`${machine.name}: at most two players per machine.`);
    if (assigned.filter(p => p.gui).length > 1) errors.push(`${machine.name}: at most one @gui player.`);
  }
  for (const player of players) {
    try { buildCampaignHeader(campaignId, player, players, plan.summary); }
    catch (error) { errors.push(error instanceof Error ? error.message : String(error)); break; }
  }
  return { players, errors };
}
export function newCampaignId(): string {
  return [...crypto.getRandomValues(new Uint8Array(6))].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
export function campaignRequestId(campaignId: string, stepId: string): string {
  if (!/^[a-f0-9]{12}$/i.test(campaignId) || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(stepId)) throw new Error('Invalid campaign or step ID.');
  return `cmp_${campaignId}_${stepId}`.slice(0, 100);
}
export function layoutMode(width: number, height: number) {
  const mode = width <= 760 ? 'phone' : width <= 1250 ? 'tablet' : 'desktop';
  return { mode, drawer: mode !== 'desktop', maxPanes: mode === 'phone' ? 1 : 2,
    split: mode === 'tablet' && height > width ? 'horizontal' : 'vertical',
    density: width >= 1600 ? 'wide' : width <= 1250 ? 'compact' : 'normal' } as const;
}
