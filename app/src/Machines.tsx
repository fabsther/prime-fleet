import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import Icon from './Icon';
import { useI18n, setLanguage } from './i18n';
type AuthDiagnostics = {storageBackend:string; tokenBytes:number; tokenSha256:string; tokenFormatValid:boolean; readBackStable:boolean; saveRoundTripOk:boolean|null; authorization?:{bytes:number; sha256:string; tokenBytes:number; tokenSha256:string}|null; authorizationMatchesVault:boolean|null};
export type FleetMachine = {authDebug?:AuthDiagnostics; id:string; name:string; url:string; machineId?:string; capabilities?:string[]; studioVersion?:string; online?:boolean; error?:string; runs?:number; computer?:any};
export const machineColor = (i:number) => `var(--device-${['cyan','yellow','fuchsia','slate','brown'][i % 5]})`;
export default function Machines({machines,onRefresh,onError}:{machines:FleetMachine[],onRefresh:()=>Promise<void>,onError:(error:unknown)=>void}) {
 const {lang,t,error:localError}=useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const [composing,setComposing] = useState(false);
  const [editing,setEditing] = useState<FleetMachine>();
  const [busy,setBusy] = useState(false);
  const [,setPreferenceRevision] = useState(0);
  const [name,setName] = useState(''), [url,setUrl] = useState('https://'), [token,setToken] = useState('');
  function edit(machine?:FleetMachine) { setEditing(machine);setName(machine?.name ?? '');setUrl(machine?.url ?? 'https://');setToken('');setComposing(false);dialog.current?.showModal(); }
  const validationMessage=(input:HTMLInputElement)=>t(input.type==='url'?'Enter a valid HTTPS address.':input===dialog.current?.querySelector('.fleet-token-input')?'Enter a token.':'Enter a name.');
  useEffect(()=>{for(const input of dialog.current?.querySelectorAll('input') ?? [])if(input.validity.customError)input.setCustomValidity(validationMessage(input));},[lang]);
  async function save() {
    if(busy || composing || !dialog.current) return;
    if(token && (token.length>8192 || !/^pa_[A-Za-z0-9_-]+$/.test(token))) {
      onError(new Error('Invalid token: use pa_[A-Za-z0-9_-]+ without spaces or extra characters.'));return;
    }
    for(const input of dialog.current.querySelectorAll('input')) {
      input.setCustomValidity('');
      if(!input.validity.valid) { input.setCustomValidity(validationMessage(input));input.reportValidity();return; }
    }
    setBusy(true);
    try { await invoke('save_machine',{machine:{id:editing?.id ?? crypto.randomUUID(),name:name.trim(),url:url.trim()},token:token || null});setToken('');dialog.current?.close();await onRefresh(); }
    catch(error){onError(error);} finally{setBusy(false);}
  }
  async function remove(machine:FleetMachine) {
    if(!confirm(t("Forget {name}? Its token will be removed from the system vault.",{name:machine.name}))) return;
    try {await invoke('remove_machine',{machineId:machine.id});await onRefresh();}catch(error){onError(error);}
  }
  return <section className="ps-pane"><div className="ps-tabbar"><button className="ps-tab" aria-selected="true"><Icon name="machine"/>{t("Machines")}</button></div>
    <div className="ps-pane-content fleet-machine-page"><div className="fleet-toolbar"><div><h2 className="ps-panel-title">{t("Machines")}</h2><p className="ps-help">{t("Connect to Studio through Tailscale HTTPS.")}</p></div><button className="ps-btn ps-btn--primary" onClick={()=>edit()}><Icon name="plus"/>{t("Add a machine")}</button></div>
    {!machines.length && <div className="fleet-empty"><Icon name="machine" size={28}/><h2>{t("Add your PCs")}</h2><p className="ps-help">{t("Create a remote access token in each Studio, then add its Tailscale address.")}</p></div>}
    <ul className="ps-machine-list fleet-machines">{machines.map((m,i)=><li key={m.id}><article className="ps-card fleet-machine" style={{'--machine-color':machineColor(i)} as React.CSSProperties}>
      <div className="fleet-toolbar"><span className="ps-machine-icon"><Icon name="machine" size={22}/></span><h3 className="ps-card-title">{m.name}</h3><span className={`ps-status ${m.online?'is-connected':m.error?'is-attention':''}`}>{t(m.online?"Connected":m.error?"Error":"Offline")}</span></div>
      <p className="ps-card-meta fleet-break">{m.url}</p><dl className="ps-kv"><dt>Studio</dt><dd>{m.studioVersion ?? t("Unknown")}</dd><dt>{t("Runs in progress")}</dt><dd>{m.runs ?? 0}</dd><dt>Computer Use</dt><dd>{t(m.computer?.enabled ? "Enabled" : m.capabilities?.includes('computer-use') ? "Ready" : "Unavailable")}</dd></dl>
      <p className="ps-help">{m.capabilities?.map(cap => ({projects:t('Projects'),conversations:t('Conversations'),runs:t('Runs'),roadmaps:t('Roadmap'),files:t('Files'),'computer-use':'Computer Use'} as Record<string,string>)[cap] ?? cap).join(' · ') || t("No capabilities read.")}</p>{m.capabilities?.includes('sync') && <label className="ps-checkbox"><input type="checkbox" checked={localStorage.getItem(`sync:${m.id}`)==='true'} onChange={e=>{localStorage.setItem(`sync:${m.id}`,String(e.target.checked));setPreferenceRevision(n=>n+1);}}/>{t("Token allows sync:write")}</label>}{m.error && <p className="ps-help fleet-error">{localError(m.error)}</p>}
      {m.authDebug && <details className="ps-help"><summary>{t("Auth diagnostics · debug build")}</summary><dl className="ps-kv fleet-break"><dt>{t("Storage")}</dt><dd>{m.authDebug.storageBackend==='OS credential store'?t("OS credential store"):m.authDebug.storageBackend}</dd><dt>{t("Vault token")}</dt><dd>{t("{number} bytes · SHA-256 {hash}…",{number:m.authDebug.tokenBytes,hash:m.authDebug.tokenSha256.slice(0,16)})}</dd><dt>{t("Token format")}</dt><dd>{t(m.authDebug.tokenFormatValid?"Valid ASCII":"INVALID")}</dd><dt>{t("Read-back stable")}</dt><dd>{t(m.authDebug.readBackStable?"Yes":"NO")}</dd><dt>{t("Save round-trip")}</dt><dd>{t(m.authDebug.saveRoundTripOk===null?"Not saved in this app session":m.authDebug.saveRoundTripOk?"OK":"NO")}</dd><dt>{t("Authorization header")}</dt><dd>{m.authDebug.authorization?t("{number} bytes · SHA-256 {hash}…",{number:m.authDebug.authorization.bytes,hash:m.authDebug.authorization.sha256.slice(0,16)}):t("No request built in this app session")}</dd><dt>{t("Header token")}</dt><dd>{m.authDebug.authorization?t("{number} bytes · SHA-256 {hash}…",{number:m.authDebug.authorization.tokenBytes,hash:m.authDebug.authorization.tokenSha256.slice(0,16)}):t("Unknown")}</dd><dt>{t("Header matches vault")}</dt><dd>{t(m.authDebug.authorizationMatchesVault===null?"Not checked":m.authDebug.authorizationMatchesVault?"Yes":"NO")}</dd></dl></details>}
      <div className="fleet-toolbar"><button className="ps-text-btn" onClick={()=>edit(m)}>{t("Edit connection")}</button><button className="ps-text-btn fleet-error" onClick={()=>remove(m)}>{t("Forget")}</button></div>
    </article></li>)}</ul></div>
    <dialog className="ps-dialog" ref={dialog} onInput={e=>{if(e.target instanceof HTMLInputElement)e.target.setCustomValidity('');}}><div><div className="fleet-toolbar"><h2 className="ps-dialog-title">{t(editing?"Edit connection":"Add a machine")}</h2><button type="button" className="ps-icon-btn" aria-label={t("Close")} title={t("Close")} onClick={()=>dialog.current?.close()}><Icon name="x"/></button></div><p className="ps-dialog-desc">{t("Tokens stay in your system vault. Fleet sends requests without a browser Origin header.")}</p>
      <label className="ps-label">{t("Name")}<input className="ps-input" value={name} onChange={e=>setName(e.target.value)} required maxLength={100}/></label>
      <label className="ps-label">{t("Tailscale address")}<input className="ps-input" type="url" value={url} onChange={e=>setUrl(e.target.value)} required placeholder="https://pc.tailnet.ts.net"/></label>
      <label className="ps-label">{t("Token")}{editing && <small>{t("Leave empty to keep it")}</small>}<input className="ps-input fleet-token-input" type="text" autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false} value={token} onInput={e=>{if(!(e.nativeEvent as InputEvent).isComposing)setToken(e.currentTarget.value);}} onCompositionStart={()=>setComposing(true)} onCompositionEnd={e=>{setComposing(false);setToken(e.currentTarget.value);}} required={!editing}/></label><div className="ps-dialog-actions"><select className="ps-select ps-select--bare" aria-label={t("Language")} value={lang} onChange={e=>setLanguage(e.target.value as 'fr'|'en')}><option value="fr">FR</option><option value="en">EN</option></select><button type="button" className="ps-btn ps-btn--secondary" onClick={()=>dialog.current?.close()}>{t("Cancel")}</button><button type="button" className="ps-btn ps-btn--primary" disabled={busy||composing} onClick={save}>{t("Save connection")}</button></div>
    </div></dialog></section>;
}
