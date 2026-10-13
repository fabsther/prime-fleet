import { useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { FormEvent, Dispatch, SetStateAction } from 'react';
import { api, errorText, projectPath as path, launchCampaign as launchCampaignWork, launchStep, stopCampaign, messageCampaign } from './api';
import type { CampaignPlayerResult } from './api';
import { assignMachine, campaignRequestId, flattenSteps, isActiveRun, newCampaignId, parseMarkup, resolveMachine, validateCampaign } from './logic';
import type { CampaignPlayer, ComputerState, Machine, Plan, Roadmap as Document, Run, Step } from './logic';
import Icon from './Icon';
import { useI18n, setLanguage } from './i18n';
import './roadmap.css';

type FleetMachine = { id: string; name: string; url?: string; machineId?: string; capabilities?: string[]; online?: boolean; syncAllowed?: boolean; scopes?: string[] };
export type RoadmapProps = {
  machineId: string; projectId: string; machines: FleetMachine[];
  projectCopies: { machineId: string; id: string }[];
  onRun: (machineId: string, run: Run) => void; onError: (error: unknown) => void;
  campaign?: Campaign; onCampaign: Dispatch<SetStateAction<Campaign | undefined>>;
};
type Editor = { kind: 'plan' | 'step' | 'journal'; planId?: string; stepId?: string; parentId?: string; title: string; note: string; status: string; revision: number };
type Player = { ambiguous?: boolean; key: string; player: CampaignPlayer; machineId: string; projectId: string; requestId: string; status: string; run?: Run; computer?: ComputerState; error?: string; notice?: string; sent?: boolean };
export type Campaign = { launching?: boolean; id: string; planId: string; machineId: string; projectId: string; players: Player[] };

export default function Roadmap({ machineId, projectId, machines, projectCopies, onRun, onError, campaign, onCampaign: setCampaign }: RoadmapProps) {
 const {lang,t,error:localError,status:stateLabel,percent}=useI18n();
  const [document, setDocument] = useState<Document>();
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [expanded, setExpanded] = useState<string[]>([]);
  const [editor, setEditor] = useState<Editor>();
  const [broadcast, setBroadcast] = useState('');
  const lock = useRef(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const scope = useRef('');
  const documentScope = useRef('');
  scope.current = `${machineId}/${projectId}`;
  const fleet: Machine[] = useMemo(() => machines.map(m => ({ ...m, url: m.url ?? '', status: m.online ? 'online' : 'offline', syncAllowed: m.syncAllowed ?? m.scopes?.includes('sync:write') })), [machines]);
  const nativeMachine = (machine: Machine) => machines.find(m => m.id === machine.id)!;
  const fleetProject = { key: projectId, name: projectId, syncId: null, copies: projectCopies.map(copy => ({ ...copy, name: projectId, syncId: null })) };
  const report = (error: unknown) => { setMessage(errorText(error)); onError(error); };
  async function read(machine = machineId, project = projectId): Promise<Document> {
    const result = await api(machine, 'GET', `${path(project)}/roadmap`);
    return result.roadmap;
  }
  async function refresh() {
    const current = `${machineId}/${projectId}`;
    const fresh = await read();
    if (scope.current === current) { documentScope.current = current; setDocument(fresh); }
    return fresh;
  }
  useEffect(() => {
    let current = true;
    const currentScope = `${machineId}/${projectId}`;
    documentScope.current = '';
    setDocument(undefined); setLoading(true); setMessage(''); setEditor(undefined); setExpanded([]);
    read().then(doc => { if (current) { documentScope.current = currentScope; setDocument(doc); } }).catch(error => { if (current) report(error); }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [machineId, projectId]);
  useEffect(() => { if (editor && dialog.current && !dialog.current.open) dialog.current.showModal(); }, [editor]);
  async function action(work: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setMessage('');
    try { await work(); } catch (error) { report(error); }
    finally { lock.current = false; setBusy(false); }
  }
  async function mutate(body: Record<string, unknown>, revision = document?.revision) {
    const current = `${machineId}/${projectId}`;
    if (revision === undefined || documentScope.current !== current || scope.current !== current) throw new Error('Read this Roadmap before editing.');
    try {
      const result = await api(machineId, 'POST', `${path(projectId)}/roadmap/mutations`, { ...body, expectedRevision: revision });
      if (scope.current === current) setDocument(result.roadmap);
    } catch (error) {
      // A failed write may have applied. Reread but never resend it, including a 409.
      try { await refresh(); } catch { /* Keep the draft and original error. */ }
      throw error;
    }
  }
  function editPlan(plan?: Plan) {
    if (!document) return;
    setEditor({ kind: 'plan', planId: plan?.id, title: plan?.title ?? '', note: plan?.summary ?? '', status: String(plan?.status ?? 'active'), revision: document.revision });
  }
  function editStep(plan: Plan, step?: Step, parentId?: string) {
    if (!document) return;
    setEditor({ kind: 'step', planId: plan.id, stepId: step?.id, parentId, title: step?.text ?? '', note: step?.note ?? '', status: '', revision: document.revision });
  }
  async function saveEditor(event: FormEvent) {
    event.preventDefault();
    if (!editor || !editor.title.trim() || editor.revision !== document?.revision) return;
    const draft = editor;
    await action(async () => {
      const body = draft.kind === 'plan'
        ? { action: draft.planId ? 'plan.patch' : 'plan.create', ...(draft.planId ? { planId: draft.planId } : {}), title: draft.title.trim(), summary: draft.note, status: draft.status }
        : draft.kind === 'journal'
          ? { action: 'journal.add', planId: draft.planId, text: draft.title.trim() }
          : { action: draft.stepId ? 'step.edit' : 'step.add', planId: draft.planId, ...(draft.stepId ? { stepId: draft.stepId } : {}), ...(draft.parentId ? { parentId: draft.parentId } : {}), text: draft.title.trim(), note: draft.note };
      await mutate(body, draft.revision);
      setEditor(undefined);
      setMessage('Roadmap updated.');
    });
  }
  const targetCopy = (machine: FleetMachine) => projectCopies.find(copy => copy.machineId === machine.id || copy.machineId === machine.machineId);
  async function startStep(plan: Plan, step: Step) {
    const markup = parseMarkup(step.note);
    const machine = resolveMachine(markup.machine, fleet);
    if (markup.assignments.length !== 1 || !machine) throw new Error('Assign exactly one known machine before launching.');
    const target = nativeMachine(machine);
    if (!window.confirm(t("Launch “{step}” on {name}? This starts an agent run.",{step:step.text,name:target.name}))) return;
    try {
      const accepted = await launchStep({ project: fleetProject, planId: plan.id, stepId: step.id, machine, expectedStep: step, expectedSummary: plan.summary });
      onRun(target.id, { ...accepted.run, sessionId: accepted.sessionId ?? accepted.run.sessionId });
      setMessage(accepted.linkWarning ? 'Work accepted, but the Roadmap link could not be saved.' : `Work accepted on ${target.name}.`);
      await refresh();
    } catch (error) { try { await refresh(); } catch { /* No write retry. */ } throw error; }
  }
  function updatePlayer(key: string, values: Partial<Player>) {
    setCampaign(current => current ? { ...current, players: current.players.map(p => p.key === key ? { ...p, ...values } : p) } : current);
  }
  async function launchCampaign(plan: Plan) {
    if (campaign && (campaign.launching || campaign.players.some(p => !p.run ? p.ambiguous : isActiveRun(p.run)))) throw new Error('Stop or resolve the current campaign before launching another.');
    const id = newCampaignId();
    const validation = validateCampaign(plan, fleet, id);
    if (validation.errors.length) throw new Error(validation.errors.join('\n'));
    for (const player of validation.players) if (!targetCopy(nativeMachine(player.machine))) throw new Error(`${player.machine.name} does not have this project.`);
    if (!window.confirm(t("campaign launch",{count:validation.players.length,plan:plan.title ?? t("Campaign")},validation.players.length))) return;
    const players: Player[] = validation.players.map(p => {
      const machine = nativeMachine(p.machine);
      return { key: p.step.id, player: p, machineId: machine.id, projectId: targetCopy(machine)!.id, requestId: campaignRequestId(id, p.step.id), status: 'Waiting' };
    });
    setCampaign({ id, planId: plan.id, machineId, projectId, players, launching: true });
    const notified = new Set<string>();
    const onUpdate = (row: CampaignPlayerResult) => {
      const run = row.accepted && { ...row.accepted.run, sessionId: row.accepted.sessionId ?? row.accepted.run.sessionId };
      updatePlayer(row.player.step.id, {
        status: run ? run.status : row.status, ...(run ? { run } : {}),
        computer: row.computer, error: row.error, ambiguous: row.ambiguous,
        sent: row.sent,
        notice: row.computerStatus === 'manual' ? 'Enable Computer Use manually in Studio. The player waits up to 2 minutes.' : row.accepted?.linkWarning ? 'Run accepted, but its Roadmap link could not be saved.' : undefined,
      });
      if (run && !notified.has(run.id)) { notified.add(run.id); onRun(row.player.machine.id, run); }
    };
    try { await launchCampaignWork({ project: fleetProject, plan, machines: fleet, campaignId: id, sourceMachine: fleet.find(m => m.id === machineId), onUpdate }); }
    finally { setCampaign(current => current ? { ...current, launching: false } : current); }
    await refresh();
  }
  async function refreshPlayer(player: Player) {
    if (!player.run) return;
    const run: Run = await api(player.machineId, 'GET', `/api/v1/runs/${encodeURIComponent(player.run.id)}`);
    const computer = player.player.gui && machines.find(m => m.id === player.machineId)?.capabilities?.includes('computer-use')
      ? await api(player.machineId, 'GET', `/api/v1/computer-use?${run.sessionId ? `sessionId=${encodeURIComponent(run.sessionId)}` : `runId=${encodeURIComponent(run.id)}`}`) : undefined;
    updatePlayer(player.key, { run, status: run.status, ...(computer ? { computer } : {}) });
  }
  const activeCampaignRuns = campaign?.players.filter(p => p.run && isActiveRun(p.run)) ?? [];
  const activeCampaignKey = activeCampaignRuns.map(p => `${p.machineId}/${p.run!.id}`).sort().join(',');
  useEffect(() => {
    let cancelled = false;
    const streams: string[] = [], cleanup: (() => void)[] = [];
    async function follow() {
      const end = await listen<any>('fleet-stream-end', ({ payload }) => {
        if (cancelled) return;
        const player = activeCampaignRuns.find(p => p.machineId === payload.machineId && payload.path === `/api/v1/runs/${p.run!.id}/events`);
        if (player) void refreshPlayer(player).catch(error => updatePlayer(player.key, { error: errorText(error) }));
      });
      const events = await listen<any>('fleet-stream', ({ payload }) => {
        if (cancelled) return;
        const player = activeCampaignRuns.find(p => p.machineId === payload.machineId && payload.path === `/api/v1/runs/${p.run!.id}/events`);
        if (player && payload.event?.status) updatePlayer(player.key, { status: payload.event.status });
        if (player && /finished|completed|failed|stopped|ended/.test(payload.event?.kind ?? '')) void refreshPlayer(player).catch(error => updatePlayer(player.key, { error: errorText(error) }));
      });
      cleanup.push(end, events);
      if (cancelled) { cleanup.forEach(fn => fn()); return; }
      await Promise.all(activeCampaignRuns.map(async player => {
        try {
          const id = await invoke<string>('stream', { machineId: player.machineId, path: `/api/v1/runs/${player.run!.id}/events`, after: 0 });
          if (cancelled) await invoke('stop_stream', { streamId: id }); else streams.push(id);
        } catch (error) { if (!cancelled) updatePlayer(player.key, { error: errorText(error) }); }
      }));
    }
    if (activeCampaignRuns.length) void follow().catch(onError);
    return () => { cancelled = true; cleanup.forEach(fn => fn()); streams.forEach(streamId => { void invoke('stop_stream', { streamId }); }); };
  }, [activeCampaignKey]);
  function resultFor(player: Player): CampaignPlayerResult {
    return { campaignId: campaign!.id, player: player.player, requestId: player.requestId, status: 'accepted',
      accepted: player.run ? { accepted: true, queued: false, run: player.run, sessionId: player.run.sessionId,
        requestId: player.requestId, machineId: player.run.machineId, projectId: player.projectId } : undefined };
  }
  async function stopPlayer(player: Player) {
    if (!player.run) throw new Error('Acceptance is unknown. Inspect runs in Studio before starting or stopping a replacement.');
    const [row] = await stopCampaign([resultFor(player)]);
    updatePlayer(player.key, { status: row.status, computer: row.computer, error: row.error });
    if (row.error) throw new Error(row.error);
    await refreshPlayer(player);
  }
  async function forPlayers(work: (player: Player) => Promise<void>, selected = campaign?.players ?? []) {
    await Promise.all(selected.map(async player => { try { await work(player); } catch (error) { updatePlayer(player.key, { error: errorText(error) }); onError(error); } }));
  }
  async function messagePlayer(player: Player, text: string) {
    if (!player.run?.sessionId || !isActiveRun(player.run)) throw new Error(`${player.player.step.text}: no active conversation to message.`);
    const [result] = await messageCampaign([resultFor(player)], text);
    if (result?.status === 'rejected') throw result.reason;
    updatePlayer(player.key, { notice: 'Message accepted.' });
  }
  const steps = flattenSteps(document?.plans?.flatMap(plan => plan.steps) ?? []);
  const checked = steps.filter(step => step.done).length;
  const renderSteps = (plan: Plan, items: Step[], depth = 0) => <ul className="ps-steps">{items.map(step => {
    const markup = parseMarkup(step.note);
    const machine = resolveMachine(markup.machine, fleet);
    const completed = step.completion && machines.find(m => m.id === step.completion?.machineId || m.machineId === step.completion?.machineId);
    return <li className={`fleet-step-item ${step.done ? 'is-done' : ''}`} key={step.id}>
      <div className={`ps-step ${step.done ? 'is-done' : ''}`}>
        <input type="checkbox" checked={step.done} disabled={busy || loading} aria-label={t(step.done?"Mark {step} unfinished":"Mark {step} done",{step:step.text})} onChange={event => { const done = event.target.checked; void action(async () => { await mutate({ action: 'step.check', planId: plan.id, stepId: step.id, done }); }); }} />
        <span className="ps-step-title">{step.text}</span>
        <button className="ps-icon-btn ps-icon-btn--sm" disabled={busy} title={t("Edit step")} aria-label={t("Edit {name}",{name:step.text})} onClick={() => editStep(plan, step)}><Icon name="pencil" size={13} /></button>
      </div>
      <div className="fleet-step-meta">
        <select className="ps-select ps-select--bare" aria-label={t("Machine for {step}",{step:step.text})} value={machine?.machineId ?? machine?.id ?? ''} disabled={busy} onChange={event => { const value = event.target.value; void action(async () => { await mutate({ action: 'step.edit', planId: plan.id, stepId: step.id, note: assignMachine(step.note, value) }); }); }}>
          <option value="" disabled>{markup.machine ? t("Unknown: {name}",{name:markup.machine}) : t("Assign machine")}</option>
          {fleet.map(m => <option key={m.id} value={m.machineId ?? m.id}>{m.name}{m.status !== 'online' ? ` · ${t("Offline")}` : ''}</option>)}
        </select>
        {markup.gui && <span className="ps-help">Computer Use</span>}
        {step.done && <span className="ps-help">{t("Done")}{step.completion ? ` · ${completed?.name ?? step.completion.machineId}` : ` · ${t("Machine not recorded")}`}</span>}
        {!step.done && <button className="ps-text-btn" disabled={busy || !machine || machine.status !== 'online'} onClick={() => void action(() => startStep(plan, step))}>{t("Launch")}</button>}
        {depth < 2 && <button className="ps-text-btn" disabled={busy} onClick={() => editStep(plan, undefined, step.id)}>{t("Add substep")}</button>}
      </div>
      {step.note && <details className="fleet-step-note"><summary>{t("Note")}</summary><p>{step.note}</p></details>}
      {!!step.children?.length && renderSteps(plan, step.children, depth + 1)}
    </li>;
  })}</ul>;
  return <section className="fleet-roadmap ps-pane-content" aria-label={t("Project Roadmap")}>
    <div className="ps-pane-head fleet-roadmap-head"><div><h2 className="ps-panel-title">{t("Roadmap")}</h2><p className="ps-help">{t("Revision {number}",{number:document?.revision ?? '…'})}</p></div><button className="ps-icon-btn" aria-label={t("Refresh Roadmap")} disabled={busy || loading} onClick={() => void action(async () => { await refresh(); if (campaign) await forPlayers(refreshPlayer); })}><Icon name="refresh" /></button></div>
    {message && <div className="ps-banner ps-banner--quiet fleet-roadmap-message" role="status">{localError(message)}</div>}
    <div className="ps-pane-section"><div className="ps-progress-label"><span>{t("tasks checked",{checked,count:steps.length},steps.length)}</span><span className="ps-stat">{percent(steps.length ? Math.round(checked / steps.length * 100) : 0)}</span></div><progress className="ps-progress" value={checked} max={steps.length || 1} /></div>
    <div className="ps-pane-section fleet-roadmap-plans">
      {loading && <p className="ps-help" role="status">{t("Reading Roadmap…")}</p>}
      {!loading && document && !document.plans?.length && <p className="ps-help">{t(document.initialized === false ? "Initialize this Roadmap before adding a plan." : "Add a plan to organize work across your machines.")}</p>}
      {document?.plans?.map(plan => {
        const list = flattenSteps(plan.steps), done = list.filter(s => s.done).length, open = expanded.includes(plan.id), isCampaign = parseMarkup(plan.summary).campaign;
        return <article className="ps-plan" key={plan.id}>
          <div className="ps-plan-head"><button className="ps-plan-title" aria-expanded={open} onClick={() => setExpanded(old => open ? old.filter(id => id !== plan.id) : [...old, plan.id])}>{plan.title ?? t("Untitled plan")}</button><span className="ps-inline-count">{done}/{list.length}</span><button className="ps-icon-btn ps-icon-btn--sm" aria-label={t("Edit {name}",{name:plan.title ?? t("plan")})} disabled={busy} onClick={() => editPlan(plan)}><Icon name="pencil" size={13} /></button></div>
          <div className="ps-plan-meta">{stateLabel(String(plan.status ?? 'active'))}{isCampaign ? ` · ${t("Campaign")}` : ''}</div>
          {open && <><p className="fleet-plan-summary">{plan.summary}</p>{renderSteps(plan, plan.steps)}<div className="fleet-roadmap-actions"><button className="ps-text-btn" disabled={busy} onClick={() => editStep(plan)}>{t("Add step")}</button>{isCampaign && <button className="ps-btn ps-btn--secondary ps-btn--compact" disabled={busy} onClick={() => void action(() => launchCampaign(plan))}><Icon name="arrow-up-right" size={13} />{t("Launch campaign")}</button>}<button className="ps-text-btn" disabled={busy} onClick={() => setEditor({ kind: 'journal', planId: plan.id, title: '', note: '', status: '', revision: document.revision })}>{t("Add journal entry")}</button></div></>}
        </article>;
      })}
      {document?.initialized === false && <button className="ps-btn ps-btn--primary" disabled={busy || loading} onClick={() => void action(() => mutate({ action: 'init' }))}>{t("Initialize Roadmap")}</button>}
      <button className="ps-btn ps-btn--primary" disabled={busy || loading || !document || document.initialized === false} onClick={() => editPlan()}><Icon name="plus" size={13} />{t("Add a plan")}</button>
    </div>
    {campaign && <section className="ps-pane-section fleet-campaign" aria-label={t("Campaign panel")}>
      <div className="ps-plan-head"><h3 className="ps-heading">{t("Campaign")}</h3><span className="ps-inline-count">{campaign.id}</span></div>
      <p className="ps-help">{t("Results do not check steps. Read each report, then validate the checklist.")}</p>
      {campaign.players.map(player => <article className="fleet-campaign-player" key={player.key}>
        <div className="ps-plan-head"><strong>{player.player.index}. {player.player.step.text}</strong><span className={`ps-status ${player.run && isActiveRun(player.run) ? 'is-working' : ''}`}>{stateLabel(player.status)}</span></div>
        <p className="ps-help">{player.player.machine.name}{player.player.gui ? ` · ${t("Computer Use: {status}",{status:t(player.computer?.enabled ? "Enabled" : player.computer?.ownerHidden || player.computer?.owner ? "Other owner" : "Off")})}` : ''}</p>
        {player.notice && <p className="ps-help">{localError(player.notice)}</p>}
        {player.error && <p className="fleet-player-error" role="alert">{localError(player.error)}{player.ambiguous && !player.run ? ` ${t("Acceptance is unknown. Inspect Studio runs; do not relaunch blindly.")}` : ''}</p>}
        <code className="fleet-report-path">outputs/multitest/{campaign.id}/player-{player.player.index}.md</code>{player.ambiguous && <p className="ps-help">{t("Request ID:")} <code>{player.requestId}</code></p>}
        <div className="fleet-roadmap-actions"><button className="ps-text-btn" disabled={!player.run} onClick={() => { if (player.run) onRun(player.machineId, player.run); }}>{t("Open conversation")}</button><button className="ps-text-btn" disabled={busy || !player.run} onClick={() => void action(() => forPlayers(refreshPlayer, [player]))}>{t("Refresh")}</button><button className="ps-text-btn" disabled={busy || !player.run} onClick={() => { if (window.confirm(t("Stop {step} and revoke only its Computer Use?",{step:player.player.step.text}))) void action(() => forPlayers(stopPlayer, [player])); }}>{t("Stop player")}</button></div>
      </article>)}
      <label className="ps-label" htmlFor="campaign-message">{t("Message to players")}</label><textarea id="campaign-message" className="ps-input" rows={2} maxLength={262144} value={broadcast} onChange={event => setBroadcast(event.target.value)} placeholder={t("Give all active players an instruction.")} />
      <div className="fleet-roadmap-actions"><button className="ps-btn ps-btn--secondary ps-btn--compact" disabled={busy || !broadcast.trim() || !campaign.players.some(p => p.run && isActiveRun(p.run))} onClick={() => void action(async () => { await forPlayers(p => messagePlayer(p, broadcast.trim()), campaign.players.filter(p => p.run && isActiveRun(p.run))); })}>{t("Message all")}</button><button className="ps-btn ps-btn--secondary ps-btn--compact fleet-stop" disabled={busy || !campaign.players.some(p => p.run)} onClick={() => { if (window.confirm(t("Stop all accepted campaign runs, then revoke only their Computer Use? Unknown acceptances must be checked in Studio."))) void action(() => forPlayers(stopPlayer, campaign.players.filter(p => p.run))); }}>{t("Stop all")}</button></div>
    </section>}
    {editor && <dialog className="ps-dialog fleet-roadmap-dialog" ref={dialog} onCancel={event => { if (busy) event.preventDefault(); else setEditor(undefined); }}>
      <form onSubmit={saveEditor}><h2 className="ps-dialog-title">{t(editor.kind==='journal'?"Add journal entry":editor.kind==='plan'?editor.planId?"Edit plan":"Add plan":editor.stepId?"Edit step title":"Add step title")}</h2>
        <label className="ps-label" htmlFor="roadmap-title">{t(editor.kind === 'plan' ? "Title" : editor.kind === 'journal' ? "Result summary" : "Step")}</label>
        {editor.kind === 'journal' ? <textarea id="roadmap-title" className="ps-input" rows={5} required maxLength={16000} value={editor.title} onChange={e => setEditor({ ...editor, title: e.target.value })} /> : <input id="roadmap-title" className="ps-input" autoFocus required maxLength={editor.kind === 'plan' ? 300 : 8000} value={editor.title} onChange={e => setEditor({ ...editor, title: e.target.value })} />}
        {editor.kind !== 'journal' && <><label className="ps-label" htmlFor="roadmap-note">{t(editor.kind === 'plan' ? "Summary" : "Note")}</label><textarea id="roadmap-note" className="ps-input" rows={5} maxLength={16000} value={editor.note} onChange={e => setEditor({ ...editor, note: e.target.value })} /><p className="ps-help">{t(editor.kind === 'plan' ? "Put @campaign on its own line to define a multiplayer test." : "Use @machine: NAME to assign a machine and @gui for desktop control.")}</p></>}
        {editor.kind === 'plan' && <><label className="ps-label" htmlFor="roadmap-status">{t("Status")}</label><select id="roadmap-status" className="ps-select" value={editor.status} onChange={e => setEditor({ ...editor, status: e.target.value })}>{['active', 'paused', 'done', 'abandoned'].map(status => <option key={status} value={status}>{stateLabel(status)}</option>)}</select></>}
        {(message || editor.revision !== document?.revision) && <p className="fleet-player-error" role="alert">{message?localError(message):t("The Roadmap revision changed.")} {t("The draft is kept. Close and reopen the editor after reconciling any revision conflict.")}</p>}
        <div className="ps-dialog-actions"><select className="ps-select ps-select--bare" aria-label={t("Language")} value={lang} onChange={e=>setLanguage(e.target.value as 'fr'|'en')}><option value="fr">FR</option><option value="en">EN</option></select><button type="button" className="ps-btn ps-btn--secondary" disabled={busy} onClick={() => setEditor(undefined)}>{t("Cancel")}</button><button className="ps-btn ps-btn--primary" disabled={busy || !editor.title.trim() || editor.revision !== document?.revision}>{t(busy ? "Saving…" : "Save")}</button></div>
      </form>
    </dialog>}
  </section>;
}
