import { describe, expect, it } from 'vitest';
import { buildCampaignHeader, campaignRequestId, defaultSession, layoutMode, mergeSessions, roadmapSessionLabels, type Run } from './logic';

const sessions = [
  { id:'old', title:'Old', machineId:'studio-a', projectId:'p-a', updatedAt:'2026-01-01' },
  { id:'new', title:'New', machineId:'studio-a', projectId:'p-a', updatedAt:'2026-01-03' },
];
const run: Run = { id:'live', sessionId:'old', machineId:'studio-a', projectId:'p-a', status:'running', startedAt:'2026-01-02' };
describe('Project defaults and Roadmap labels', () => {
  it('opens the most recent conversation, preferring live work to newer idle history', () => {
    expect(defaultSession(mergeSessions(sessions))?.id).toBe('new');
    expect(defaultSession(mergeSessions(sessions,[run]))?.id).toBe('old');
    expect(defaultSession(mergeSessions(sessions,[{...run,status:'completed'}]))?.id).toBe('new');
    expect(defaultSession([])).toBeUndefined();
  });
  it('reads persisted plan.sessions IDs, exact step links and nested completion without translating data', () => {
    expect(roadmapSessionLabels({plans:[
      {title:'Campagne serveur',sessions:['one'],steps:[{text:'Hôte distant',done:false}]},
      {title:'Plan multi',sessions:['plan','linked'],steps:[
        {text:'Client',externalLinks:[{sessionId:'linked'}]},
        {text:'Parent',children:[{text:'Contrôle invité',completion:{sessionId:'done'}}]},
      ]},
    ]})).toEqual({one:'Hôte distant',plan:'Plan multi',linked:'Client',done:'Contrôle invité'});
  });
  it('restores campaign role and ID from unique public run request IDs, not session order', () => {
    const doc={plans:[{title:'Campagne',sessions:['old'],steps:[{id:'host',text:'Hôte'},{id:'guest',text:'Invité'}]}]};
    const campaignRun={...run,status:'completed',requestId:campaignRequestId('abcdef012345','guest')};
    expect(roadmapSessionLabels(doc,[campaignRun])).toEqual({old:'Invité · abcdef012345'});
    expect(roadmapSessionLabels({plans:[...doc.plans,...doc.plans]},[campaignRun])).toEqual({old:'Invité · abcdef012345'});
    const prefix='x'.repeat(100);
    const ambiguous={plans:[{title:'Campagne',sessions:['old'],steps:[{id:prefix+'a',text:'Hôte'},{id:prefix+'b',text:'Invité'}]}]};
    expect(roadmapSessionLabels(ambiguous,[{...run,requestId:campaignRequestId('abcdef012345',prefix+'a')}])).toEqual({old:'Campagne'});
    expect(roadmapSessionLabels(doc,[{...run,requestId:'not-campaign'}])).toEqual({old:'Campagne'});
  });
  it('ignores malformed extension fields instead of guessing sessions by order', () => {
    expect(roadmapSessionLabels(null)).toEqual({});
    expect(roadmapSessionLabels({plans:[null,7,{sessions:[null,{},'good'],title:'Remote title',steps:[null,{text:9,externalLinks:[{sessionId:'bad'}],children:'bad'}]}]})).toEqual({good:'Remote title'});
  });
  it('matches CSS shortest-side phones and all non-phone portrait splits without changing density or drawer rules', () => {
    expect(layoutMode(844,390)).toMatchObject({mode:'phone',maxPanes:1,drawer:true,split:'vertical'});
    expect(layoutMode(1600,599)).toMatchObject({mode:'phone',maxPanes:1,drawer:true,density:'wide'});
    expect(layoutMode(500,900)).toMatchObject({mode:'phone',maxPanes:1});
    expect(layoutMode(600,900)).toMatchObject({mode:'tablet',maxPanes:2,split:'horizontal'});
    expect(layoutMode(900,1200)).toMatchObject({mode:'tablet',split:'horizontal'});
    expect(layoutMode(1300,1600)).toMatchObject({mode:'desktop',drawer:false,maxPanes:2,split:'horizontal',density:'normal'});
    expect(layoutMode(1600,900)).toMatchObject({mode:'desktop',drawer:false,split:'vertical',density:'wide'});
    expect(layoutMode(600,600)).toMatchObject({mode:'tablet',split:'horizontal'});
  });
  it('instructs every player to stop on another Computer Use owner OR an existing game instance', () => {
    const player={index:1,gui:false,machine:{id:'a',name:'ALIEN18',url:''},step:{id:'host',text:'Hôte',done:false}};
    const header=buildCampaignHeader('abcdef012345',player,[player]);
    expect(header).toContain('si une autre session agent possède Computer Use OU si une instance du jeu tourne déjà sur cette machine, signaler le conflit et ARRÊTER sans prendre le contrôle.');
    expect(buildCampaignHeader('abcdef012345',{...player,gui:true},[player])).toContain('uniquement en l’absence de conflit, attendre au plus 2 minutes l’autorisation de cette session');
  });
});
