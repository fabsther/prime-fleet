import { test, expect, type Page } from '@playwright/test';
let pageErrors:string[]=[];
test.beforeEach(({page})=>{pageErrors=[];page.on('pageerror',error=>pageErrors.push(error.message));});
test.afterEach(()=>expect(pageErrors).toEqual([]));

// Mock the real app's native bridge. No Studio network calls or writes.
async function fixture(page:Page, options:{active?:boolean;hold?:boolean;labels?:boolean;requestLabel?:boolean;launch?:boolean;empty?:boolean}={}) {
 await page.addInitScript((options)=>{
  localStorage.setItem('locale','en');
  const w=window as any,machines=[{id:'a',name:'ALIEN18',url:'https://alien.example.ts.net'},{id:'b',name:'BAGUETTE',url:'https://baguette.example.ts.net'}];
  w.__calls=[];w.__active=options.active;w.__hold=options.hold;w.__waiting=[];w.__accepted=[];w.__empty=options.empty;
  w.__release=()=>{w.__hold=false;w.__waiting.splice(0).forEach((resolve:any)=>resolve());};
  const callbacks=new Map<number,any>();let next=1;
  w.__TAURI_INTERNALS__={transformCallback:(fn:any)=>{const id=next++;callbacks.set(id,fn);return id;},invoke:async(cmd:string,args:any)=>{
   w.__calls.push({cmd,...args});
   if(cmd==='machines')return machines;
   if(cmd==='auth_diagnostics')return undefined;
   if(cmd==='plugin:event|listen')return args.handler;
   if(cmd==='plugin:event|unlisten'||cmd==='stop_stream')return;
   if(cmd==='stream')return `stream-${next++}`;
   if(cmd!=='api')throw Error(`Unexpected native command ${cmd}`);
   if(options.launch && args.method==='POST' && args.path.endsWith('/roadmap/work')){
    const host=args.body.targets[0].stepId==='host',m=args.machineId;
    const run={id:`accepted-${m}`,sessionId:host?'alpha-old':'alpha-new',machineId:`studio-${m}`,projectId:`alpha-${m}`,status:'running',startedAt:'2026-01-03'};
    w.__accepted.push(run);
    return {accepted:true,queued:false,run,sessionId:run.sessionId,requestId:args.body.requestId,machineId:run.machineId,projectId:run.projectId};
   }
   if(args.method!=='GET')throw Error('Studio writes are forbidden in sidebar regression tests.');
   const m=machines.find(m=>m.id===args.machineId)!,path=args.path;
   const items=(items:any[])=>({items,nextOffset:null});
   if(path.endsWith('/machine'))return {machineId:`studio-${m.id}`,name:m.name,capabilities:['projects','conversations','runs','roadmaps','files']};
   if(path.startsWith('/api/v1/runs?') && options.launch)return items(w.__accepted.filter((r:any)=>r.machineId===`studio-${m.id}`));
   if(path.startsWith('/api/v1/runs?'))return items(m.id==='a' && (options.active || options.requestLabel)?[{id:'live',sessionId:'alpha-old',machineId:'studio-a',projectId:'alpha-a',status:w.__active?'running':'completed',startedAt:'2026-01-02',requestId:options.requestLabel?'cmp_abcdef012345_guest':undefined}]:[]);
   if(path.startsWith('/api/v1/projects?'))return items(['Alpha','Beta'].map(name=>({id:`${name.toLowerCase()}-${m.id}`,name,syncId:name.toLowerCase(),machineId:`studio-${m.id}`})));
   const project=path.includes('/projects/beta-')?'beta':'alpha';
   if(path.endsWith('/roadmap'))return {machineId:`studio-${m.id}`,projectId:`${project}-${m.id}`,roadmap:{revision:3,plans:options.labels || options.requestLabel?[
    {id:'campaign',title:'Campagne distante',summary:'@campaign',sessions:['alpha-old'],steps:[{id:'host',text:'Hôte distant',done:false,note:'@machine: ALIEN18'},{id:'guest',text:'Invité distant',done:false,note:'@machine: BAGUETTE',externalLinks:m.id==='b'?[{sessionId:'alpha-new',machineId:'studio-b'}]:[]}]},
   ]:[]}};
   if(path.includes('/messages')){const id=path.split('/sessions/')[1].split('/')[0];return items([{id:`msg-${id}`,role:'assistant',text:`History ${id}`}]);}
   if(path.includes('/files'))return items([]);
   if(path.includes('/sessions?')){
    if(project==='alpha' && w.__hold)await new Promise(resolve=>w.__waiting.push(resolve));
    if(w.__empty)return items([]);
    return items(['old','new'].map((age,i)=>({id:`${project}-${age}`,title:options.labels || options.requestLabel?'Travaille sur la sélection suivante de la Roadmap':`${project} ${age}`,machineId:`studio-${m.id}`,projectId:`${project}-${m.id}`,updatedAt:`2026-01-0${i+1}`})));
   }
   if(path.startsWith('/api/v1/runs/') && options.launch)return w.__accepted.find((r:any)=>path.endsWith(`/${r.id}`));
   if(path.startsWith('/api/v1/runs/'))return {id:'live',sessionId:'alpha-old',machineId:'studio-a',projectId:'alpha-a',status:w.__active?'running':'completed',startedAt:'2026-01-02'};
   throw Error(`Unmocked GET ${path}`);
  }};
  w.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:()=>{}};
 },options);
 await page.setViewportSize({width:1440,height:900});await page.goto('/');
 await expect(page.getByRole('heading',{name:'ALIEN18'})).toBeVisible();
}
const openProject=(page:Page,name='Alpha')=>page.locator('.ps-row').filter({hasText:name}).click();
const breadcrumb=(page:Page)=>page.locator('.ps-breadcrumb-current');
const refresh=(page:Page)=>page.getByRole('button',{name:'Refresh fleet',exact:true}).last().click();

test('project opens its most recent session and keeps manual selection across refresh and project reclick',async({page})=>{
 await fixture(page);await openProject(page);
 await expect(breadcrumb(page)).toHaveText('alpha new');
 await expect(page.getByText('History alpha-new',{exact:true})).toBeVisible();
 await page.locator('.ps-subrow').filter({hasText:'alpha old'}).click();
 await refresh(page);await expect(page.getByText('History alpha-old',{exact:true})).toBeVisible();
 await openProject(page);await expect(breadcrumb(page)).toHaveText('alpha old');
});

test('active session beats newer idle history and only active work has a pulsing dot',async({page})=>{
 await fixture(page,{active:true});await page.emulateMedia({reducedMotion:'no-preference'});await openProject(page);
 await expect(breadcrumb(page)).toHaveText('alpha old');
 const running=page.locator('.ps-subrow').filter({hasText:'alpha old'}).locator('.ps-dot--running');
 await expect(running).toHaveCount(1);
 await expect(running).toHaveCSS('animation-name','ps-pulse');
 await expect(page.locator('.ps-subrow').filter({hasText:'alpha new'}).locator('.ps-dot--running')).toHaveCount(0);
 await page.evaluate(()=>{(window as any).__active=false;});await refresh(page);
 await expect(page.locator('.ps-subrow .ps-dot--running')).toHaveCount(0);
 await expect(breadcrumb(page)).toHaveText('alpha old');
});

test('explicit New conversation stays blank through fleet refresh',async({page})=>{
 await fixture(page);await openProject(page);await expect(breadcrumb(page)).toHaveText('alpha new');
 await page.getByRole('button',{name:'New conversation',exact:true}).click();await refresh(page);
 await expect(breadcrumb(page)).toHaveText('New conversation');
 await expect(page.getByRole('heading',{name:'New conversation',exact:true})).toBeVisible();
 await expect(page.locator('.ps-subrow.is-active')).toHaveCount(0);
 await expect(page.getByText('History alpha-new',{exact:true})).toHaveCount(0);
});

test('explicit New conversation during pending project load is not replaced by the response',async({page})=>{
 await fixture(page,{hold:true,active:true});await openProject(page);
 await expect.poll(()=>page.evaluate(()=>(window as any).__waiting.length)).toBe(2);
 await expect(page.getByLabel('Message',{exact:true})).toHaveCount(0);
 await page.getByRole('button',{name:'New conversation',exact:true}).click();
 await expect(page.getByLabel('Message',{exact:true})).toBeEditable();
 await page.evaluate(()=>(window as any).__release());
 await expect(page.locator('.ps-subrow')).toHaveCount(2);
 await expect(breadcrumb(page)).toHaveText('New conversation');
 await refresh(page);await expect(breadcrumb(page)).toHaveText('New conversation');
});

test('late project response cannot select old project history after switching projects',async({page})=>{
 await fixture(page,{hold:true});await openProject(page);
 await expect.poll(()=>page.evaluate(()=>(window as any).__waiting.length)).toBe(2);
 await openProject(page,'Beta');await expect(breadcrumb(page)).toHaveText('beta new');
 await page.evaluate(()=>(window as any).__release());
 await expect(page.getByText('History beta-new',{exact:true})).toBeVisible();
 await expect(page.locator('.ps-subrow')).toHaveCount(2);
 await expect(breadcrumb(page)).toHaveText('beta new');
});

test('default uses refreshed current runs, not runs captured before async sessions finish',async({page})=>{
 await fixture(page,{hold:true,active:true});
 await page.evaluate(()=>{(window as any).__active=false;});await refresh(page);await openProject(page);
 await expect.poll(()=>page.evaluate(()=>(window as any).__waiting.length)).toBe(2);
 await page.evaluate(()=>{(window as any).__active=true;});await refresh(page);
 await expect.poll(()=>page.evaluate(()=>(window as any).__waiting.length)).toBe(4);
 await page.evaluate(()=>(window as any).__release());
 await expect(breadcrumb(page)).toHaveText('alpha old');
});

test('persisted Roadmap labels from all project copies replace generated instructions after restart',async({page})=>{
 await fixture(page,{labels:true});await openProject(page);
 await expect(page.locator('.ps-subrow').filter({hasText:'Invité distant'})).toHaveCount(1);
 await expect(page.locator('.ps-subrow').filter({hasText:'Campagne distante'})).toHaveCount(1);
 await expect(breadcrumb(page)).toHaveText('Invité distant');
 await expect(page.locator('.ps-subrow').filter({hasText:'Travaille sur'})).toHaveCount(0);
 await page.reload();await expect(page.getByRole('heading',{name:'ALIEN18'})).toBeVisible();await openProject(page);
 await expect(breadcrumb(page)).toHaveText('Invité distant');
 expect(await page.evaluate(()=>(window as any).__calls.filter((c:any)=>c.cmd==='api' && c.method!=='GET'))).toEqual([]);
});

test('completed public Run.requestId restores exact campaign player label after restart',async({page})=>{
 await fixture(page,{requestLabel:true});await openProject(page);
 await expect(page.locator('.ps-subrow').filter({hasText:'Invité distant · abcdef012345'})).toHaveCount(1);
 await expect(page.locator('.ps-subrow .ps-dot--running')).toHaveCount(0);
 await page.locator('.ps-subrow').filter({hasText:'abcdef012345'}).click();
 await expect(breadcrumb(page)).toHaveText('Invité distant · abcdef012345');
});


test('accepted in-memory campaign sessions use remote role and campaign ID without a run requestId',async({page})=>{
 await fixture(page,{labels:true,launch:true});await openProject(page);
 await expect(breadcrumb(page)).toHaveText('Invité distant');
 await page.locator('.fleet-roadmap .ps-plan-title').filter({hasText:'Campagne distante'}).click();
 page.on('dialog',dialog=>dialog.accept());
 await page.getByRole('button',{name:'Launch campaign',exact:true}).click();
 await expect(page.locator('.ps-subrow').filter({hasText:'Hôte distant ·'})).toHaveCount(1);
 await expect(page.locator('.ps-subrow').filter({hasText:'Invité distant ·'})).toHaveCount(1);
 const host=await page.locator('.ps-subrow').filter({hasText:'Hôte distant ·'}).innerText();
 const guest=await page.locator('.ps-subrow').filter({hasText:'Invité distant ·'}).innerText();
 expect(host).toMatch(/^Hôte distant · [a-f0-9]{12}$/);
 expect(guest.split(' · ')[1]).toBe(host.split(' · ')[1]);
 await page.locator('header').getByLabel('Language',{exact:true}).selectOption('fr');
 await expect(page.locator('.ps-subrow').filter({hasText:host})).toHaveCount(1);
 await expect(page.locator('.ps-subrow').filter({hasText:guest})).toHaveCount(1);
 expect(await page.evaluate(()=>(window as any).__accepted.every((r:any)=>r.requestId===undefined))).toBe(true);
});


test('pending default is not writable, and an empty project stays a new draft when remote history appears',async({page})=>{
 await fixture(page,{hold:true,empty:true});await openProject(page);
 await expect.poll(()=>page.evaluate(()=>(window as any).__waiting.length)).toBe(2);
 await expect(page.getByLabel('Message',{exact:true})).toHaveCount(0);
 await expect(page.getByText('Loading history…',{exact:true})).toBeVisible();
 await page.evaluate(()=>(window as any).__release());
 await expect(page.getByLabel('Message',{exact:true})).toBeEditable();
 await page.getByLabel('Message',{exact:true}).fill('New draft stays mine');
 await page.evaluate(()=>{(window as any).__empty=false;});await refresh(page);
 await expect(page.locator('.ps-subrow')).toHaveCount(2);
 await expect(breadcrumb(page)).toHaveText('New conversation');
 await expect(page.getByLabel('Message',{exact:true})).toHaveValue('New draft stays mine');
 await expect(page.locator('.ps-subrow.is-active')).toHaveCount(0);
});
