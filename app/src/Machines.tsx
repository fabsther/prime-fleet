import { useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import Icon from './Icon';
export type FleetMachine = {id:string; name:string; url:string; machineId?:string; capabilities?:string[]; studioVersion?:string; online?:boolean; error?:string; runs?:number; computer?:any};
export const machineColor = (i:number) => `var(--device-${['cyan','yellow','fuchsia','slate','brown'][i % 5]})`;
export default function Machines({machines,onRefresh,onError}:{machines:FleetMachine[],onRefresh:()=>Promise<void>,onError:(error:unknown)=>void}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [editing,setEditing] = useState<FleetMachine>();
  const [busy,setBusy] = useState(false);
  const [,setPreferenceRevision] = useState(0);
  const [name,setName] = useState(''), [url,setUrl] = useState('https://'), [token,setToken] = useState('');
  function edit(machine?:FleetMachine) { setEditing(machine);setName(machine?.name ?? '');setUrl(machine?.url ?? 'https://');setToken('');dialog.current?.showModal(); }
  async function save(event:React.FormEvent) {
    event.preventDefault();setBusy(true);
    try { await invoke('save_machine',{machine:{id:editing?.id ?? crypto.randomUUID(),name:name.trim(),url:url.trim()},token:token || null});setToken('');dialog.current?.close();await onRefresh(); }
    catch(error){onError(error);} finally{setBusy(false);}
  }
  async function remove(machine:FleetMachine) {
    if(!confirm(`Forget ${machine.name}? Its token will be removed from the system vault.`)) return;
    try {await invoke('remove_machine',{machineId:machine.id});await onRefresh();}catch(error){onError(error);}
  }
  return <section className="ps-pane"><div className="ps-tabbar"><button className="ps-tab" aria-selected="true"><Icon name="machine"/>Machines</button></div>
    <div className="ps-pane-content fleet-machine-page"><div className="fleet-toolbar"><div><h2 className="ps-panel-title">Machines</h2><p className="ps-help">Connect to Studio through Tailscale HTTPS.</p></div><button className="ps-btn ps-btn--primary" onClick={()=>edit()}><Icon name="plus"/>Add a machine</button></div>
    {!machines.length && <div className="fleet-empty"><Icon name="machine" size={28}/><h2>Add your PCs</h2><p className="ps-help">Create a remote access token in each Studio, then add its Tailscale address.</p></div>}
    <ul className="ps-machine-list fleet-machines">{machines.map((m,i)=><li key={m.id}><article className="ps-card fleet-machine" style={{'--machine-color':machineColor(i)} as React.CSSProperties}>
      <div className="fleet-toolbar"><span className="ps-machine-icon"><Icon name="machine" size={22}/></span><h3 className="ps-card-title">{m.name}</h3><span className={`ps-status ${m.online?'is-connected':m.error?'is-attention':''}`}>{m.online?'Connected':m.error?'Error':'Offline'}</span></div>
      <p className="ps-card-meta fleet-break">{m.url}</p><dl className="ps-kv"><dt>Studio</dt><dd>{m.studioVersion ?? 'Unknown'}</dd><dt>Runs in progress</dt><dd>{m.runs ?? 0}</dd><dt>Computer Use</dt><dd>{m.computer?.enabled ? 'Enabled' : m.capabilities?.includes('computer-use') ? 'Ready' : 'Unavailable'}</dd></dl>
      <p className="ps-help">{m.capabilities?.join(' · ') || 'No capabilities read.'}</p>{m.capabilities?.includes('sync') && <label className="ps-checkbox"><input type="checkbox" checked={localStorage.getItem(`sync:${m.id}`)==='true'} onChange={e=>{localStorage.setItem(`sync:${m.id}`,String(e.target.checked));setPreferenceRevision(n=>n+1);}}/>Token allows sync:write</label>}{m.error && <p className="ps-help fleet-error">{m.error}</p>}
      <div className="fleet-toolbar"><button className="ps-text-btn" onClick={()=>edit(m)}>Edit connection</button><button className="ps-text-btn fleet-error" onClick={()=>remove(m)}>Forget</button></div>
    </article></li>)}</ul></div>
    <dialog className="ps-dialog" ref={dialog}><form onSubmit={save}><div className="fleet-toolbar"><h2 className="ps-dialog-title">{editing?'Edit connection':'Add a machine'}</h2><button type="button" className="ps-icon-btn" aria-label="Close" title="Close" onClick={()=>dialog.current?.close()}><Icon name="x"/></button></div><p className="ps-dialog-desc">Tokens stay in your system vault. Fleet sends requests without a browser Origin header.</p>
      <label className="ps-label">Name<input className="ps-input" value={name} onChange={e=>setName(e.target.value)} required maxLength={100}/></label>
      <label className="ps-label">Tailscale address<input className="ps-input" type="url" value={url} onChange={e=>setUrl(e.target.value)} required placeholder="https://pc.tailnet.ts.net"/></label>
      <label className="ps-label">Token{editing && <small>Leave empty to keep it</small>}<input className="ps-input" type="password" autoComplete="off" value={token} onChange={e=>setToken(e.target.value)} required={!editing}/></label><div className="ps-dialog-actions"><button type="button" className="ps-btn ps-btn--secondary" onClick={()=>dialog.current?.close()}>Cancel</button><button className="ps-btn ps-btn--primary" disabled={busy}>Save connection</button></div>
    </form></dialog></section>;
}
