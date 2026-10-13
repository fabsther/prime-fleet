import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { api, getRoadmap, listProjects, listSessions, listRuns } from './api';
import { defaultSession, groupProjects, mergeSessions, roadmapSessionLabels, type FleetProject, type Project, type Session, type Run, type Machine } from './logic';
import Machines, { type FleetMachine, machineColor } from './Machines';
import Conversation from './Conversation';
import Roadmap, { type Campaign } from './Roadmap';
import Icon from './Icon';
import { useI18n, setLanguage } from './i18n';
export default function App(){
 const {lang,t,error:localError}=useI18n();
 const [campaigns,setCampaigns]=useState<Record<string,Campaign|undefined>>({});
 const [machines,setMachines]=useState<FleetMachine[]>([]),[projects,setProjects]=useState<Project[]>([]),[sessions,setSessions]=useState<Session[]>([]),[runs,setRuns]=useState<Run[]>([]),[selected,setSelected]=useState(''),[sessionId,setSessionId]=useState<string>(),[screen,setScreen]=useState('Machines'),[error,setError]=useState(''),[loading,setLoading]=useState(false),[drawer,setDrawer]=useState(false),[search,setSearch]=useState(''),[views,setViews]=useState(['Conversation','Roadmap']);
 const selection=useRef({key:'',pendingDefault:false}),loadGeneration=useRef(0);
 const [loadedProject,setLoadedProject]=useState(''),[roadmaps,setRoadmaps]=useState<Record<string,{machineId:string;projectId:string;document:unknown}[]>>({});
 const onError=useCallback((error:unknown)=>{const value=error as any;setError(typeof error==='string'?error:value?.message ?? String(error));},[]);
 const refresh=useCallback(async()=>{
  setLoading(true);
  try{
   const configured=await invoke<FleetMachine[]>('machines');
   const next=await Promise.all(configured.map(async(m)=>{
    try{
     const info=await api(m.id,'GET','/machine');
     const [ps,rs,computer]=await Promise.all([listProjects(m.id),listRuns(m.id),info.capabilities.includes('computer-use')?api(m.id,'GET','/computer-use').catch((e)=>({error:e.message})):Promise.resolve(undefined)]);
     return {machine:{...m,...info,id:m.id,url:m.url,online:true,error:undefined,runs:rs.filter((r)=>!r.endedAt&&!['completed','stopped','failed'].includes(r.status)).length,computer},projects:ps,runs:rs};
    }catch(error){return {machine:{...m,online:false,error:(error as any)?.message ?? String(error)},projects:[] as Project[],runs:[] as Run[]};}
   }));
   await Promise.all(next.map(async(n)=>{n.machine.authDebug=await invoke<FleetMachine['authDebug']>('auth_diagnostics',{machineId:n.machine.id}).catch(()=>undefined);}));
   setMachines(next.map(n=>n.machine));setProjects(next.flatMap(n=>n.projects));setRuns(next.flatMap(n=>n.runs));
  }catch(error){onError(error);}finally{setLoading(false);}
 },[onError]);
 useEffect(()=>{void refresh();},[refresh]);
 const groups=groupProjects(projects),project=groups.find(p=>p.key===selected);
 const findMachine=(id:string)=>machines.find(m=>m.machineId===id || m.id===id);
 const loadSessions=useCallback(async(p:FleetProject)=>{
   if(selection.current.key!==p.key)return;
   const generation=++loadGeneration.current;
   const pages=await Promise.all(p.copies.map(async(copy)=>{
    const machine=machines.find(m=>m.machineId===copy.machineId || m.id===copy.machineId);
    if(!machine?.online)return {sessions:[] as Session[],machineId:copy.machineId,projectId:copy.id,document:undefined};
    const [items,roadmap]=await Promise.all([
     listSessions(machine.id,copy.id).catch(error=>{onError(error);return [] as Session[];}),
     machine.capabilities?.includes('roadmaps')?getRoadmap(machine.id,copy.id).catch(error=>{onError(error);return undefined;}):Promise.resolve(undefined),
    ]);
    return {sessions:items,machineId:copy.machineId,projectId:copy.id,document:roadmap?.roadmap};
   }));
   if(generation!==loadGeneration.current || selection.current.key!==p.key)return;
   setSessions(old=>[...old.filter(s=>!p.copies.some(c=>c.machineId===s.machineId&&c.id===s.projectId)),...pages.flatMap(page=>page.sessions)]);
   setRoadmaps(old=>({...old,[p.key]:pages}));
   setLoadedProject(p.key);
 },[machines,onError]);
 useEffect(()=>{if(project)void loadSessions(project);},[selected,projects,loadSessions]);
 const fleetSessions=mergeSessions(sessions,runs);
 const projectSessions=fleetSessions.filter(s=>s.copies.some(c=>project?.copies.some(pc=>pc.id===c.projectId&&pc.machineId===c.machineId)));
 const current=projectSessions.find(s=>s.id===sessionId);
 useEffect(()=>{
  if(!selection.current.pendingDefault || loadedProject!==selected)return;
  const candidate=current ?? defaultSession(projectSessions);
  selection.current.pendingDefault=false;
  if(candidate)setSessionId(candidate.id);
 },[selected,loadedProject,sessions,runs,sessionId]);
 const roadmapLabels=Object.fromEntries(Object.entries(roadmaps).map(([key,copies])=>[key,roadmapSessionLabels(
  {plans:copies.flatMap(copy=>{const doc=copy.document as {plans?:unknown[]} | undefined;return Array.isArray(doc?.plans)?doc.plans:[];})},
  runs.filter(run=>copies.some(copy=>run.projectId===copy.projectId && run.machineId===copy.machineId)),
 )]));
 function sessionLabel(key:string,id:string,title:string){
  const campaign=campaigns[key],player=campaign?.players.find(player=>player.run?.sessionId===id);
  return player?`${player.player.step.text} · ${campaign!.id}`:roadmapLabels[key]?.[id] ?? (title || t("Untitled conversation"));
 }
 const adapted:Machine[]=machines.map(m=>({...m,status:m.online?'online':m.error?'error':'offline',address:m.url,capabilities:m.capabilities ?? [],syncAllowed:localStorage.getItem(`sync:${m.id}`)==='true'}));
 const currentMachine=findMachine(current?.activeRun?.machineId ?? current?.lastAgentMachineId ?? project?.copies[0]?.machineId ?? '');
 function selectProject(p:FleetProject){if(selection.current.key!==p.key){selection.current={key:p.key,pendingDefault:true};++loadGeneration.current;setLoadedProject('');setSelected(p.key);setSessionId(undefined);}setScreen('Workspace');setDrawer(false);}
 function onRun(machineId:string,run:Run){setRuns(old=>[...old.filter(r=>r.id!==run.id),run]);if(selection.current.key===selected){selection.current.pendingDefault=false;setSessionId(run.sessionId ?? undefined);setScreen('Workspace');}void refresh();if(project && selection.current.key===project.key)void loadSessions(project);}
 function pane(view:string,index:number){
  if(!project)return <section className="ps-pane"><div className="fleet-empty"><Icon name="folder" size={28}/><h2>{t("Choose a project")}</h2><p className="ps-help">{t("Projects with the same sync ID share their conversations.")}</p></div></section>;
  const copy=project.copies.find(c=>c.machineId===currentMachine?.machineId) ?? project.copies[0],machine=findMachine(copy.machineId);
  return <div className={`fleet-zone ${index===1?'fleet-tools':''}`} key={`${index}:${view}`}><div className="fleet-zonebar"><select className="ps-select ps-select--bare" aria-label={t("Pane {number}",{number:index+1})} value={view} onChange={e=>setViews(old=>old.map((v,i)=>i===index?e.target.value:v))}>{['Conversation','Roadmap','Files','Machines'].map(v=><option key={v} value={v}>{t(v as "Conversation"|"Roadmap"|"Files"|"Machines")}</option>)}</select><span className="ps-help">{machine?.name}</span></div>{view==='Machines'?<Machines machines={machines} onRefresh={refresh} onError={onError}/>:view==='Roadmap'?machine?<Roadmap machineId={machine.id} projectId={copy.id} machines={adapted} projectCopies={project.copies} onRun={onRun} onError={onError} campaign={campaigns[selected]} onCampaign={update=>setCampaigns(old=>({...old,[selected]:typeof update==='function'?update(old[selected]):update}))}/>:<p className="ps-help">{t("Machine is not configured.")}</p>:selection.current.pendingDefault&&(loadedProject!==selected || !current && projectSessions.length>0)?<section className="ps-pane-content"><p className="ps-help">{t("Loading history…")}</p></section>:<Conversation project={project} session={current} machines={adapted} onRun={onRun} onRefresh={async()=>{await refresh();await loadSessions(project);}} onError={onError} view={view}/>}</div>;
 }
 return <div className="ps-app fleet-app"><button className={`fleet-sidebar-backdrop ${drawer?'is-open':''}`} aria-label={t("Close projects")} onClick={()=>setDrawer(false)}/><nav className={`ps-sidebar ${drawer?'is-open':''}`} aria-label={t("Projects")}><a className="ps-brand" href="#" onClick={e=>{e.preventDefault();setScreen('Machines');}}><span className="ps-brand-mark"><Icon name="brand" size={30}/></span><span className="ps-brand-name">prime<span className="ps-brand-sub">Fleet</span></span><span className="ps-tag">{t("Remote")}</span></a><div className="ps-sidebar-top"><button className="ps-btn ps-btn--tinted" disabled={!project} onClick={()=>{selection.current.pendingDefault=false;setSessionId(undefined);setScreen('Workspace');setViews(['Conversation','Roadmap']);setDrawer(false);}}><Icon name="plus"/>{t("New conversation")}</button><button className="ps-btn ps-btn--quiet" onClick={()=>{setScreen('Machines');setDrawer(false);}}><Icon name="machine"/>{t("Machines")}</button><label className="ps-search"><Icon name="search"/><input placeholder={t("Search projects")} aria-label={t("Search projects")} value={search} onChange={e=>setSearch(e.target.value)}/></label></div><div className="ps-sidebar-heading"><span className="ps-section-label">{t("Projects")}</span><button className="ps-icon-btn ps-icon-btn--sm" aria-label={t("Refresh fleet")} title={t("Refresh fleet")} disabled={loading} onClick={refresh}><Icon name="refresh"/></button></div><div className="ps-sidebar-scroll">
 {groups.filter(p=>p.name.toLowerCase().includes(search.toLowerCase())).map(p=>{const children=fleetSessions.filter(s=>s.copies.some(c=>p.copies.some(pc=>pc.id===c.projectId&&pc.machineId===c.machineId)));return <div className="ps-tree" key={p.key}><div className="ps-tree-head"><button className="ps-disclosure" aria-label={t("Open {name}",{name:p.name})} aria-expanded={selected===p.key} onClick={()=>selectProject(p)}><Icon name="chevron"/></button><button className={`ps-row ${selected===p.key?'is-active':''}`} onClick={()=>selectProject(p)}><span className="ps-folder"><Icon name="folder"/></span><span className="ps-truncate">{p.name}</span><span className="ps-count">{p.copies.length}</span></button></div>{selected===p.key&&<div className="ps-tree-children">{children.map(s=>{const machine=findMachine(s.lastAgentMachineId),i=machines.findIndex(m=>m.id===machine?.id);return <button className={`ps-subrow ${s.id===sessionId?'is-active':''}`} key={s.id} title={t("Last agent: {name}",{name:machine?.name ?? t("Unknown")})} onClick={()=>{selection.current.pendingDefault=false;setSessionId(s.id);setScreen('Workspace');setDrawer(false);}}><span className="ps-dot" style={{background:machineColor(i)}}/><span className="ps-truncate">{sessionLabel(p.key,s.id,s.title)}</span>{s.activeRun&&<span className="ps-dot ps-dot--running"/>}</button>;})}{!children.length&&<p className="ps-help">{t("No conversations read yet.")}</p>}</div>}</div>;})}
 {!groups.length&&<p className="ps-help fleet-sidebar-empty">{loading?t("Connecting…"):t("Add a machine to read its projects.")}</p>}
 </div><div className="ps-sidebar-footer"><div className="fleet-toolbar"><span className={`ps-dot ${machines.some(m=>m.online)?'ps-dot--connected':''}`}/><span className="ps-help">{t("{online}/{total} connected",{online:machines.filter(m=>m.online).length,total:machines.length})}</span></div><button className="ps-nav-item" onClick={()=>{const root=document.documentElement;const theme=root.dataset.theme==='dark'?'light':'dark';root.dataset.theme=theme;localStorage.setItem('theme',theme);}}><Icon name="settings"/>{t("Switch theme")}</button></div></nav>
 <main className="ps-main"><header className="ps-header"><div className="ps-breadcrumb"><button className="ps-icon-btn fleet-mobile-menu" aria-label={t("Open projects")} title={t("Open projects")} onClick={()=>setDrawer(true)}><Icon name="menu"/></button><Icon name={screen==='Machines'?'machine':'folder'}/><span className="ps-breadcrumb-parent">{screen==='Machines'?'Prime Fleet':project?.name ?? t("Projects")}</span><span className="ps-breadcrumb-sep">/</span><span className="ps-breadcrumb-current">{screen==='Machines'?t("Machines"):current?sessionLabel(selected,current.id,current.title):t("New conversation")}</span></div><div className="ps-header-actions"><select className="ps-select ps-select--bare" aria-label={t("Language")} value={lang} onChange={e=>setLanguage(e.target.value as 'fr'|'en')}><option value="fr">FR</option><option value="en">EN</option></select>{currentMachine&&screen==='Workspace'&&<span className="ps-pill-btn ps-pill-btn--sm"><span className="ps-dot" style={{background:machineColor(machines.indexOf(currentMachine))}}/>{currentMachine.name}</span>}<button className="ps-icon-btn ps-icon-btn--header" aria-label={t("Refresh fleet")} title={t("Refresh fleet")} disabled={loading} onClick={refresh}><Icon name="refresh"/></button></div></header>
 {error&&<div className="ps-banner ps-banner--error"><span>{localError(error)} {t("Read the latest state before trying again.")}</span><button className="ps-text-btn" onClick={()=>setError('')}>{t("Dismiss")}</button></div>}
 <div className="ps-body">{screen==='Machines'?<Machines machines={machines} onRefresh={refresh} onError={onError}/>:<>{pane(views[0],0)}{pane(views[1],1)}</>}</div></main></div>;
}
