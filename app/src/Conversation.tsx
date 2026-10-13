import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { api, listMessages, listFiles, continueConversation, sameLastMessage } from './api';
import { type FleetProject, type FleetSession, type Machine, type Run, type MessageItem, isActiveRun } from './logic';
import Icon from './Icon';
export type ConversationProps={project:FleetProject;session?:FleetSession;machines:Machine[];onRun:(machineId:string,run:Run)=>void;onRefresh:()=>Promise<void>;onError:(error:unknown)=>void;view?:string};
export default function Conversation({project,session,machines,onRun,onRefresh,onError,view='Conversation'}:ConversationProps) {
 const findMachine=(id:string)=>machines.find(m=>m.machineId===id || m.id===id);
 const [items,setItems]=useState<MessageItem[]>([]),[files,setFiles]=useState<any[]>([]),[draft,setDraft]=useState(''),[target,setTarget]=useState(''),[mode,setMode]=useState('follow_up'),[busy,setBusy]=useState(false),[loading,setLoading]=useState(false),[streamError,setStreamError]=useState('');
 const [run,setRun]=useState<Run|undefined>(session?.activeRun),[answer,setAnswer]=useState<Record<string,string>>({}),[ready,setReady]=useState(true);
 const after=useRef(0),generation=useRef(0),[resume,setResume]=useState(0);
 const migrateDialog=useRef<HTMLDialogElement>(null),[migrationTarget,setMigrationTarget]=useState(''),[waitingTarget,setWaitingTarget]=useState('');
 const active=run && isActiveRun(run) ? run : undefined;
 const source=findMachine(session?.newest.machineId ?? target), owner=findMachine(active?.machineId ?? target);
 const available=machines.filter(m=>m.status==='online' && project.copies.some(c=>c.machineId===m.machineId));
 useEffect(()=>{setRun(session?.activeRun);},[session?.activeRun]);
 useEffect(()=>{setTarget(session?.activeRun?.machineId ?? session?.lastAgentMachineId ?? available[0]?.machineId ?? '');setItems([]);setFiles([]);after.current=0;setStreamError('');},[session?.id,project.key]);
 useEffect(()=>{if(active)setTarget(active.machineId);else if(waitingTarget){setTarget(waitingTarget);setWaitingTarget('');}},[active?.id,waitingTarget]);
 useEffect(()=>{
   let cancelled=false; setLoading(true);
   if(!session || !source){setLoading(false);return;}
   Promise.all([listMessages(source.id ?? source.machineId,session.id),listFiles(source.id ?? source.machineId,session.id)]).then(([messages,refs])=>{if(!cancelled){setItems(messages);setFiles(refs);}}).catch(onError).finally(()=>{if(!cancelled)setLoading(false);});
   return ()=>{cancelled=true;};
 },[session?.id,source?.id]);
 useEffect(()=>{
  let cancelled=false;setReady(true);
  if(!session || !source || !target || target===source.machineId || active)return;
  const destination=findMachine(target);
  if(!destination){setReady(false);return;}
  if(source.capabilities?.includes('sync') && destination.capabilities?.includes('sync') && source.syncAllowed && destination.syncAllowed)return;
  setReady(false);
  Promise.all([listMessages(source.id ?? source.machineId,session.id),listMessages(destination.id ?? destination.machineId,session.id)]).then(([a,b])=>{
   if(!cancelled)setReady(sameLastMessage(a,b));
  }).catch(()=>{if(!cancelled)setReady(false);});
  return ()=>{cancelled=true;};
 },[target,session?.id,source?.id,active?.id,resume]);
 useEffect(()=>{
  if(!active || !owner)return;
  const machineId=owner.id ?? owner.machineId,path=`/runs/${encodeURIComponent(active.id)}/events`,epoch=++generation.current;
  let unlisten:(()=>void)|undefined,endListen:(()=>void)|undefined,id:string|undefined,cancelled=false;
  async function start(){
   unlisten=await listen<any>('fleet-stream',({payload})=>{
    if(cancelled || generation.current!==epoch || payload.machineId!==machineId || payload.path!==path)return;
    const e=payload.event;
    after.current=Math.max(after.current,payload.id ?? e.seq ?? 0);
    if(e.kind==='replay_truncated')void listMessages(machineId,session!.id).then(setItems).catch(onError);
    if(e.message)setItems(old=>{const key=e.message.id;return key && old.some(m=>m.id===key)?old.map(m=>m.id===key?{...m,...e.message}:m):[...old,e.message];});
    if(e.run)setRun({...e.run,machineId:owner!.machineId});
    if(/interaction|question/.test(e.kind ?? '')) void api(machineId,'GET',`/runs/${active!.id}`).then(setRun).catch(onError);
    if(/finished|completed|stopped|failed|ended/.test(e.kind ?? ''))void api(machineId,'GET',`/runs/${active!.id}`).then(r=>{setRun(r);void onRefresh();}).catch(onError);
   });
   endListen=await listen<any>('fleet-stream-end',({payload})=>{
    if(cancelled || payload.machineId!==machineId || payload.path!==path)return;
    if(payload.error)setStreamError(payload.error.message ?? 'Live stream ended. Resume to read new events.');
    void Promise.all([api(machineId,'GET',`/runs/${active!.id}`),listMessages(machineId,session!.id)]).then(([fresh,messages])=>{if(!cancelled){setRun(fresh);setItems(messages);void onRefresh();}}).catch(onError);
   });
   if(cancelled){unlisten();endListen();return;}
   try{id=await invoke<string>('stream',{machineId,path,after:after.current});if(cancelled)await invoke('stop_stream',{streamId:id});}catch(error){if(!cancelled){setStreamError('Live stream failed. Resume to reconnect.');onError(error);}}
  }
  void start();
  return ()=>{cancelled=true;unlisten?.();endListen?.();if(id)void invoke('stop_stream',{streamId:id});};
 },[active?.id,owner?.id,resume]);
 async function send(){
  if(!draft.trim() || busy)return;
  const destination=findMachine(target);if(!destination)return;
  setBusy(true);
  try{
   if(active){await api(destination.id ?? destination.machineId,'POST',`/sessions/${session!.id}/messages`,{requestId:crypto.randomUUID(),mode,message:draft});}
   else {
    const copy=project.copies.find(p=>p.machineId===destination.machineId);if(!copy)throw Error('This project is not on the selected machine.');
    if(session){
     const result=await continueConversation({machines,project,session,target:destination,message:draft,onSync:()=>setStreamError('Synchronizing…')});
     if(result.status==='blocked')throw Error(result.reason==='not-synced'?'Not yet synchronized on this machine. Refresh before sending.':'A run is still active. Wait for it to end or stop it on its machine.');
     if(result.status==='started'){setRun(result.run);onRun(destination.id,result.run);}
    }else{
     const newRun=await api(destination.id,'POST',`/projects/${encodeURIComponent(copy.id)}/runs`,{requestId:crypto.randomUUID(),message:draft,allowQuestions:true});
     setRun(newRun);onRun(destination.id,newRun);
    }
    setStreamError('');
   }
   setDraft('');void onRefresh();
  }catch(error){onError(error);}finally{setBusy(false);}
 }
 async function stop(){if(!active || !owner || !confirm(`Stop the run on ${owner.name}?`))return;try{await api(owner.id ?? owner.machineId,'POST',`/runs/${active.id}/stop`,{});const r=await api(owner.id ?? owner.machineId,'GET',`/runs/${active.id}`);setRun(r);await onRefresh();}catch(error){onError(error);}}
 async function migrate(stopFirst:boolean){
  const destination=findMachine(migrationTarget);if(!session||!destination)return;
  if(!stopFirst){setWaitingTarget(destination.machineId ?? destination.id);migrateDialog.current?.close();setStreamError('Waiting for the active run. The draft will not be sent automatically.');return;}
  setBusy(true);
  try{
   const result=await continueConversation({project,session:{...session,activeRun:active},machines,target:destination,message:draft,activeAction:'stop'});
   if(result.status==='blocked'){setWaitingTarget(destination.machineId ?? destination.id);setStreamError(result.reason==='not-synced'?'Not yet synchronized on the selected machine.':'Stop requested. Wait for the run to end, then send the draft.');await onRefresh();}
   else if(result.status==='started'){setRun(result.run);onRun(destination.id,result.run);setDraft('');}
   migrateDialog.current?.close();
  }catch(error){onError(error);}finally{setBusy(false);}
 }
 async function respond(interaction:any,response:unknown){if(!active || !owner)return;try{await api(owner.id ?? owner.machineId,'POST',`/runs/${active.id}/interactions`,{id:interaction.id,response});setRun(await api(owner.id ?? owner.machineId,'GET',`/runs/${active.id}`));}catch(error){onError(error);}}
 const content=view==='Files'?<div className="fleet-tab-content"><h2 className="ps-panel-title">Files</h2><p className="ps-help">{source?.name} · Files referenced by this conversation.</p>{files.map(file=><div className="fleet-file fleet-toolbar" key={file.id}><Icon name="files"/><span className="fleet-break">{file.name}</span><span className="ps-count">{file.size ? `${Math.round(file.size/1024)} KB`:'Unknown size'}</span><button className="ps-text-btn" disabled={!file.available} onClick={()=>invoke<any>('download',{machineId:source!.id ?? source!.machineId,path:`/sessions/${session!.id}/files/${file.id}`,filename:file.name}).then(r=>alert(`Saved to ${r.path}`)).catch(onError)}>Download</button></div>)}{!files.length&&<p className="ps-help">No files referenced yet.</p>}</div>:<>
  {streamError && <div className="ps-banner ps-banner--warning">{streamError}<button className="ps-text-btn" onClick={()=>{setStreamError('');setResume(n=>n+1);}}>Resume</button></div>}
  <div className="ps-pane-content"><div className="ps-thread">
  {loading&&<p className="ps-help">Loading history…</p>}
  {!items.length&&!loading&&<div className="fleet-empty"><Icon name="conversation" size={28}/><h2>{session?'Conversation':'New conversation'}</h2><p className="ps-help">Choose a machine and send a message.</p></div>}
  {items.map((m,i)=><article key={m.id ?? i} className={`ps-msg ${m.role==='user'?'ps-msg--user':''}`}><div className="ps-msg-head"><span className="ps-avatar"><Icon name={m.role==='user'?'user':'model'}/></span><span className="ps-msg-author">{m.role==='user'?'You':m.role==='assistant'?'Prime Agent':m.role}</span><span className="ps-msg-model">{String(m.model ?? '')}</span><span className="ps-msg-time">{m.timestamp?new Date(m.timestamp).toLocaleString():''}</span></div><div className="ps-msg-body ps-prose fleet-message-body">{m.thinking&&<details><summary className="ps-help">Thinking</summary><ReactMarkdown remarkPlugins={[remarkGfm]}>{m.thinking}</ReactMarkdown></details>}<ReactMarkdown remarkPlugins={[remarkGfm]}>{m.text ?? ''}</ReactMarkdown>{Array.isArray(m.tools)&&<details className="ps-activity"><summary>Agent activity</summary><pre>{JSON.stringify(m.tools,null,2)}</pre></details>}</div></article>)}
  {active?.interactions?.filter((q:any)=>!q.respondedAt&&!q.resolved&&!q.response).map((q:any)=><section className="ps-question" key={q.id}><span className="ps-help">Agent question</span><h3>{q.question ?? q.title ?? q.message ?? 'The agent needs your answer.'}</h3>{(q.options ?? q.choices ?? []).map((option:any,j:number)=><label className="ps-question-option" key={j}><input type="radio" name={q.id} checked={answer[q.id]===(option.label ?? option.value ?? option)} onChange={()=>setAnswer({...answer,[q.id]:option.label ?? option.value ?? option})}/><span>{option.label ?? option.value ?? option}<small>{option.description}</small></span></label>)}<input className="ps-question-input ps-input" value={answer[q.id]??''} placeholder="Or write another answer…" onChange={e=>setAnswer({...answer,[q.id]:e.target.value})}/><div className="fleet-toolbar"><button className="ps-btn ps-btn--primary" disabled={!answer[q.id]} onClick={()=>respond(q,{value:answer[q.id]})}>Send answer</button>{q.type==='confirm'&&<button className="ps-btn ps-btn--secondary" onClick={()=>respond(q,{confirmed:true})}>Confirm</button>}<button className="ps-btn ps-btn--secondary" onClick={()=>respond(q,{cancelled:true})}>Skip</button></div></section>)}
  </div></div>
  <div className="ps-composer-area"><form className="ps-composer fleet-composer" onSubmit={e=>{e.preventDefault();void send();}}><textarea aria-label="Message" placeholder="What would you like to build?" value={draft} onChange={e=>setDraft(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();void send();}}}/><div className="ps-composer-toolbar"><div className="fleet-toolbar"><Icon name="machine"/><select className="ps-select ps-select--bare" aria-label="Machine" value={target} disabled={!!active || busy} onChange={e=>setTarget(e.target.value)}>{available.map(m=><option key={m.machineId} value={m.machineId}>{m.name}</option>)}</select>{active&&<><Icon name="lock"/><select className="ps-select ps-select--bare" aria-label="Message mode" value={mode} onChange={e=>setMode(e.target.value)}><option value="follow_up">Follow up</option><option value="steer">Steer</option></select><button type="button" className="ps-text-btn fleet-error" onClick={stop}>Stop run</button><button type="button" className="ps-text-btn" onClick={()=>{setMigrationTarget(available.find(m=>m.machineId!==active.machineId)?.machineId ?? '');migrateDialog.current?.showModal();}}>Continue elsewhere</button></>}</div><button className="ps-send-btn" aria-label={`Send to ${findMachine(target)?.name ?? 'machine'}`} title={`Send to ${findMachine(target)?.name ?? 'machine'}`} disabled={!draft.trim()||busy||!target||!ready}><Icon name="arrow-up"/></button></div></form><div className="ps-composer-hint">{busy?'Sending…':!ready?`Not yet synchronized on ${findMachine(target)?.name}. Refresh after Studio synchronizes.`:active?`Run on ${owner?.name} · ${active.status}`:'Enter to send · Shift Enter for a new line'}</div></div>
 </>;
 return <section className="ps-pane fleet-conversation"><div className="ps-tabbar"><button className="ps-tab" aria-selected="true"><Icon name={view==='Files'?'files':'conversation'}/>{view==='Files'?'Files':session?.title ?? 'New conversation'}</button></div>{content}<dialog className="ps-dialog" ref={migrateDialog}><h2 className="ps-dialog-title">Continue on another machine?</h2><p className="ps-dialog-desc">The selector stays locked while the run is active. Wait without sending, or stop the run and send your draft to the selected machine.</p><label className="ps-label">Machine<select className="ps-select" value={migrationTarget} onChange={e=>setMigrationTarget(e.target.value)}>{available.filter(m=>m.machineId!==active?.machineId).map(m=><option value={m.machineId} key={m.id}>{m.name}</option>)}</select></label><div className="ps-dialog-actions"><button className="ps-btn ps-btn--secondary" onClick={()=>migrateDialog.current?.close()}>Cancel</button><button className="ps-btn ps-btn--secondary" disabled={!migrationTarget||busy} onClick={()=>migrate(false)}>Wait for the end</button><button className="ps-btn ps-btn--primary" disabled={!migrationTarget||!draft.trim()||busy} onClick={()=>migrate(true)}>Stop and continue</button></div></dialog></section>;
}
