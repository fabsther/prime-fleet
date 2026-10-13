import { test, expect } from '@playwright/test';
// Native IPC is mocked only in tests; the shipped app never uses browser fetch.
test.beforeEach(async({page})=>{
 await page.addInitScript(()=>{
  const machines=[{id:'a',name:'ALIEN18',url:'https://alien18.example.ts.net'},{id:'b',name:'BAGUETTE',url:'https://baguette.example.ts.net'}];
  (window as any).__TAURI_INTERNALS__={invoke:async(cmd:string,args:any)=>{
   if(cmd==='machines')return machines;
   if(cmd!=='api')throw Error(`Unexpected native command ${cmd}`);
   if(args.method!=='GET')throw Error('Writes are forbidden in visual tests.');
   const m=machines.find(m=>m.id===args.machineId)!;
   const items=(items:any[])=>({items,nextOffset:null});
   if(args.path.endsWith('/machine'))return {machineId:`studio-${m.id}`,name:m.name,studioVersion:'4.3.1',capabilities:['projects','conversations','runs','roadmaps','files']};
   if(args.path.includes('/roadmap'))return {roadmap:{revision:3,vision:'A calm, direct fleet workspace.',plans:[{id:'plan',title:'Cooperative test',status:'active',summary:'Verify the same build on both machines.',steps:[{id:'host',text:'Prepare the host build',note:'@machine: ALIEN18',done:true,completion:{machineId:'studio-a',sessionId:'session',completedAt:1791900000000},children:[]},{id:'guest',text:'Join the lobby from the guest',note:'@machine: BAGUETTE',done:false,children:[]}]}]}};
   if(args.path.includes('/messages'))return items([{id:'u',role:'user',text:'Check the fleet connections and prepare the cooperative test.',timestamp:'2026-10-13T17:00:00Z'},{id:'v',role:'assistant',model:'gpt-6.1-sol',text:"## Connections are ready\nBoth machines have the project.\n\n| Machine | State |\n| --- | --- |\n| ALIEN18 | Ready |\n| BAGUETTE | Ready |\n\nContinue from either machine after Studio synchronizes.\n\n```sh\nprime-fleet machines\n```",timestamp:'2026-10-13T17:01:00Z'}]);
   if(args.path.includes('/files'))return items([]);
   if(args.path.includes('/sessions'))return items([{id:'session',title:'Prepare the cooperative test',machineId:`studio-${m.id}`,projectId:`p-${m.id}`,updatedAt:m.id==='a'?'2026-10-13T17:01:00Z':'2026-10-13T17:00:00Z'}]);
   if(args.path.includes('/runs'))return items([]);
   if(args.path.includes('/projects'))return items([{id:`p-${m.id}`,name:'Pieton',syncId:'shared',machineId:`studio-${m.id}`,exists:true}]);
   throw Error(`Unmocked path ${args.path}`);
  }};
 });
});
for(const [name,width,height,theme] of [['desktop-dark',1440,900,'dark'],['desktop-light',1440,900,'light'],['tablet-landscape',1100,800,'dark'],['tablet-portrait',800,1100,'dark'],['phone',390,844,'dark']] as const){
 test(name,async({page})=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.setViewportSize({width,height});await page.goto(`/?theme=${theme}`);
  await expect(page.getByRole('heading',{name:'ALIEN18'})).toBeVisible();
  if(width<=1250)await page.getByRole('button',{name:'Open projects'}).click();
  await page.locator('.ps-row').filter({hasText:'Pieton'}).click();
  if(width<=1250)await page.getByRole('button',{name:'Open projects'}).click();
  await page.locator('.ps-subrow').filter({hasText:'Prepare the cooperative test'}).click();
  await expect(page.getByRole('heading',{name:'Connections are ready'})).toBeVisible();
  await expect(page.getByLabel('Machine',{exact:true})).toHaveValue('studio-a');
  if(width<=760)await expect(page.locator('.ps-sidebar')).toHaveCSS('transform','matrix(1, 0, 0, 1, -245, 0)');
  const zones=page.locator('.fleet-zone');
  await expect(zones.nth(1))[width<=760?'toBeHidden':'toBeVisible']();
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
  expect(overflow).toBe(false);expect(errors).toEqual([]);
  await page.screenshot({path:`../.local/screenshots/${name}.png`});
 });
}

async function runBridge(page:any,nullable=false){
 await page.evaluate((nullable:boolean)=>{
  const w=window as any,base=w.__TAURI_INTERNALS__.invoke,callbacks=new Map<number,any>(),events=new Map<string,number[]>();
  w.__calls=[];w.__run=undefined;w.__nullable=nullable;let next=1,runNumber=0;
  w.__TAURI_INTERNALS__.transformCallback=(fn:any)=>{const id=next++;callbacks.set(id,fn);return id;};
  w.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:(event:string,id:number)=>events.set(event,(events.get(event)??[]).filter(n=>n!==id))};
  w.__emit=(event:string,payload:any)=>(events.get(event)??[]).forEach(id=>callbacks.get(id)?.({payload}));
  w.__TAURI_INTERNALS__.invoke=async(cmd:string,args:any)=>{
   w.__calls.push({cmd,...args});
   if(cmd==='plugin:event|listen'){events.set(args.event,[...(events.get(args.event)??[]),args.handler]);return args.handler;}
   if(cmd==='plugin:event|unlisten'||cmd==='stop_stream')return;
   if(cmd==='stream')return `stream-${next++}`;
   const path=args?.path??'';
   if(cmd==='api'){
    if(args.method==='GET'&&path.startsWith('/api/v1/runs?'))return {items:args.machineId==='a'&&w.__run?[w.__run]:[],nextOffset:null};
    if(args.method==='GET'&&path.startsWith('/runs/'))return structuredClone(w.__run);
    if(args.method==='GET'&&path.startsWith('/api/v1/runs/'))return structuredClone(w.__run);
    if(args.method==='POST'&&path.endsWith('/runs')){w.__run={id:`r${++runNumber}`,sessionId:nullable?null:'session',projectId:'p-a',machineId:'studio-a',status:'running',startedAt:'2026-10-13T17:02:00Z',interactions:[]};return structuredClone(w.__run);}
    if(args.method==='POST'&&path.endsWith('/interactions')){w.__run.interactions=w.__run.interactions.map((q:any)=>q.id===args.body.id?{...q,status:'answered'}:q);return {};}
    if(args.method==='POST'&&path.endsWith('/messages'))return {};
    if(args.method==='GET'&&path.includes('/sessions')&&path.includes('?')&&w.__run?.sessionId==='new-s'&&!path.includes('/messages')&&!path.includes('/files'))return {items:[{id:'new-s',title:'New session',machineId:'studio-a',projectId:'p-a',updatedAt:'2026-10-13T17:03:00Z'}],nextOffset:null};
    if(args.method==='GET'&&path.includes('/sessions/new-s/messages'))return {items:[{id:'new-msg',role:'assistant',text:'New session history.'}],nextOffset:null};
   }
   return base(cmd,args);
  };
 },nullable);
}
async function workspace(page:any){
 await page.goto('/');await expect(page.getByRole('heading',{name:'ALIEN18'})).toBeVisible();
 await page.locator('.ps-row').filter({hasText:'Pieton'}).click();
 await page.locator('.ps-subrow').filter({hasText:'Prepare the cooperative test'}).click();
 await expect(page.getByRole('heading',{name:'Connections are ready'})).toBeVisible();
}
async function sendDraft(page:any,text='Continue'){
 await page.getByLabel('Message',{exact:true}).fill(text);await page.getByRole('button',{name:'Send to ALIEN18'}).click();
}
test('new run resets its cursor but explicit resume keeps its cursor',async({page})=>{
 await workspace(page);await runBridge(page);await sendDraft(page);
 await expect.poll(()=>page.evaluate(()=>(window as any).__calls.filter((c:any)=>c.cmd==='stream').length)).toBe(1);
 await page.evaluate(()=>{const w=window as any;w.__emit('fleet-stream',{machineId:'a',path:'/runs/r1/events',id:100,event:{kind:'message',seq:100,message:{id:'live',role:'assistant',text:'First run.'}}});w.__run={...w.__run,status:'completed',endedAt:'2026-10-13T17:03:00Z'};w.__emit('fleet-stream-end',{machineId:'a',path:'/runs/r1/events'});});
 await expect(page.getByLabel('Machine',{exact:true})).toBeEnabled();await sendDraft(page,'Next run');
 await expect.poll(()=>page.evaluate(()=>(window as any).__calls.filter((c:any)=>c.cmd==='stream').at(-1)?.path)).toBe('/runs/r2/events');
 expect(await page.evaluate(()=>(window as any).__calls.filter((c:any)=>c.cmd==='stream').at(-1).after)).toBe(0);
 await page.evaluate(()=>{const w=window as any;w.__emit('fleet-stream',{machineId:'a',path:'/runs/r2/events',id:3,event:{kind:'message',seq:3,message:{id:'live2',role:'assistant',text:'Second run.'}}});w.__emit('fleet-stream-end',{machineId:'a',path:'/runs/r2/events',error:{message:'Disconnected.'}});});
 await page.getByRole('button',{name:'Resume',exact:true}).click();
 await expect.poll(()=>page.evaluate(()=>(window as any).__calls.filter((c:any)=>c.cmd==='stream').at(-1).after)).toBe(3);
});
test('null session acceptance is promoted by the native session event',async({page})=>{
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await workspace(page);await runBridge(page,true);await page.getByRole('button',{name:'New conversation',exact:true}).click();await sendDraft(page);
 await expect.poll(()=>page.evaluate(()=>(window as any).__calls.filter((c:any)=>c.cmd==='stream').length)).toBe(1);
 await page.evaluate(()=>{const w=window as any;w.__emit('fleet-stream-end',{machineId:'a',path:'/runs/r1/events',error:{message:'Disconnected before session.'}});});
 await page.getByRole('button',{name:'Resume',exact:true}).click();
 await expect.poll(()=>page.evaluate(()=>(window as any).__calls.filter((c:any)=>c.cmd==='stream').length)).toBe(2);
 await page.evaluate(()=>{const w=window as any;w.__run.sessionId='new-s';w.__emit('fleet-stream',{machineId:'a',path:'/runs/r1/events',id:1,event:{kind:'session',sessionId:'new-s',seq:1}});});
 await expect(page.locator('.ps-breadcrumb-current')).toHaveText('New session');await expect(page.getByText('New session history.',{exact:true})).toBeVisible();
 await sendDraft(page,'Follow up');
 await expect.poll(()=>page.evaluate(()=>(window as any).__calls.filter((c:any)=>c.cmd==='api'&&c.method==='POST').at(-1).path)).toBe('/api/v1/sessions/new-s/messages');
 expect(errors).toEqual([]);
});
test('only pending questions can be answered and confirm sends a boolean',async({page})=>{
 await workspace(page);await runBridge(page);await sendDraft(page);
 await expect.poll(()=>page.evaluate(()=>(window as any).__calls.filter((c:any)=>c.cmd==='stream').length)).toBe(1);
 await page.evaluate(()=>{const w=window as any;w.__run.interactions=['pending','answered','cancelled','interrupted'].map((status,i)=>({id:`q${i}`,method:'confirm',title:`Question ${status}`,status}));w.__emit('fleet-stream',{machineId:'a',path:'/runs/r1/events',id:1,event:{kind:'interaction',seq:1}});});
 await expect(page.getByRole('heading',{name:'Question pending'})).toBeVisible();await expect(page.locator('.ps-question')).toHaveCount(1);
 await page.getByRole('button',{name:'Confirm',exact:true}).click();
 expect(await page.evaluate(()=>(window as any).__calls.filter((c:any)=>c.cmd==='api'&&c.method==='POST').at(-1).body)).toEqual({id:'q0',response:{confirmed:true}});
 await expect(page.locator('.ps-question')).toHaveCount(0);
});

test('tablet connection token avoids password/form semantics and keeps required validation',async({page})=>{
 await page.setViewportSize({width:800,height:1100});await page.goto('/');
 await expect(page.getByRole('heading',{name:'ALIEN18'})).toBeVisible();
 await page.evaluate(()=>{
  const w=window as any,base=w.__TAURI_INTERNALS__.invoke;w.__connectionSaves=0;
  w.__TAURI_INTERNALS__.invoke=async(cmd:string,args:any)=>{
   if(cmd==='save_machine'){w.__connectionSaves++;return [];}
   return base(cmd,args);
  };
 });
 const dialog=page.getByRole('dialog'),save=dialog.getByRole('button',{name:'Save connection'});
 const name=dialog.getByLabel('Name',{exact:true}),url=dialog.getByLabel('Tailscale address'),token=dialog.getByLabel(/^Token/);
 const saves=()=>page.evaluate(()=>(window as any).__connectionSaves);
 await page.getByRole('button',{name:'Add a machine'}).click();
 for(const editing of [false,true]){
  if(editing)await page.getByRole('button',{name:'Edit connection'}).first().click();
  await expect(dialog.locator('form')).toHaveCount(0);
  await expect(token).toHaveAttribute('type','text');
  await expect(token).toHaveAttribute('autocomplete','off');
  await expect(token).toHaveAttribute('autocapitalize','off');
  await expect(token).toHaveAttribute('autocorrect','off');
  await expect(token).toHaveAttribute('spellcheck','false');
  await expect(token).toHaveCSS('-webkit-text-security','disc');
  expect(await token.evaluate((input:HTMLInputElement)=>input.form)).toBeNull();
  await expect(save).toHaveAttribute('type','button');
  await expect(name).toHaveAttribute('required','');await expect(url).toHaveAttribute('required','');
  expect(await token.evaluate((input:HTMLInputElement)=>input.required)).toBe(!editing);
  if(!editing){
   await save.click();await expect(name).toBeFocused();expect(await saves()).toBe(0);
   await name.fill('Tablet test');await save.click();await expect(url).toBeFocused();expect(await saves()).toBe(0);
   await url.fill('https://tablet.example.ts.net');await save.click();await expect(token).toBeFocused();expect(await saves()).toBe(0);
   await token.fill('pa_synthetic_test');await token.press('Enter');expect(await saves()).toBe(0);
  }
  await save.click();await expect(dialog).not.toBeVisible();expect(await saves()).toBe(editing?2:1);
 }
});


test('new Roadmap requires an explicit revisioned initialization before plan creation',async({page})=>{
 await page.addInitScript(()=>{
  const w=window as any,base=w.__TAURI_INTERNALS__.invoke;let initialized=false;w.__initCalls=[];
  w.__TAURI_INTERNALS__.invoke=async(cmd:string,args:any)=>{
   if(cmd==='api'&&args.path.endsWith('/roadmap'))return {roadmap:{revision:initialized?1:0,initialized,plans:[]}};
   if(cmd==='api'&&args.path.endsWith('/roadmap/mutations')){
    w.__initCalls.push(args.body);
    if(args.body.action!=='init'||args.body.expectedRevision!==0)throw Error('Unexpected mutation');
    initialized=true;return {roadmap:{revision:1,initialized:true,plans:[]}};
   }
   return base(cmd,args);
  };
 });
 await page.goto('/');await page.locator('.ps-row').first().click();
 await expect(page.getByRole('button',{name:'Add a plan',exact:true})).toBeDisabled();
 await page.getByRole('button',{name:'Initialize Roadmap',exact:true}).click();
 await expect(page.getByRole('button',{name:'Add a plan',exact:true})).toBeEnabled();
 await expect(page.getByRole('button',{name:'Initialize Roadmap',exact:true})).toHaveCount(0);
 expect(await page.evaluate(()=>(window as any).__initCalls)).toEqual([{action:'init',expectedRevision:0}]);
});


test('token input rejects the Android trailing backtick and saves only completed valid input',async({page})=>{
 await page.goto('/');await expect(page.getByRole('heading',{name:'ALIEN18'})).toBeVisible();
 await page.evaluate(()=>{const w=window as any,base=w.__TAURI_INTERNALS__.invoke;w.__savedTokens=[];w.__TAURI_INTERNALS__.invoke=async(cmd:string,args:any)=>{if(cmd==='save_machine'){w.__savedTokens.push(args.token);return [];}return base(cmd,args);};});
 await page.getByRole('button',{name:'Add a machine'}).click();
 const dialog=page.getByRole('dialog'),token=dialog.getByLabel(/^Token/),save=dialog.getByRole('button',{name:'Save connection'});
 await dialog.getByLabel('Name',{exact:true}).fill('Tablet regression');await dialog.getByLabel('Tailscale address').fill('https://tablet.example.ts.net');
 for(const invalid of ['pa_synthetic`','pa_synthetic ','wrong-prefix']){
  await token.fill(invalid);await save.click();await expect(page.getByText('Token invalide : format pa_[A-Za-z0-9_-]+ requis, sans espace ni caractère ajouté.')).toBeVisible();
  expect(await page.evaluate(()=>(window as any).__savedTokens)).toEqual([]);await expect(dialog).toBeVisible();
 }
 await token.fill('');
 await token.evaluate((input:HTMLInputElement)=>{input.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));input.value='pa_synthetic_valid';input.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertCompositionText',data:'pa_synthetic_valid',isComposing:true}));});
 await expect(save).toBeDisabled();expect(await page.evaluate(()=>(window as any).__savedTokens)).toEqual([]);
 await token.evaluate((input:HTMLInputElement)=>{input.value='pa_synthetic_valid';input.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'pa_synthetic_valid'}));});
 await expect(save).toBeEnabled();await save.click();await expect(dialog).not.toBeVisible();
 expect(await page.evaluate(()=>(window as any).__savedTokens)).toEqual(['pa_synthetic_valid']);
});
