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
