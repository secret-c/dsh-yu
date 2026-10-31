import {randomBytes} from 'node:crypto';
import {readSections} from './sections.js';
export function initializeCompanionDefaults({ db, repo, settings }) {
  if(db.getMeta('companion.defaults.v1')){
    if(!db.getMeta('companion.roles.v1')){
      const names={morning:['早安','早上好'],night:['晚安'],activity:['自由活动'],private:['QQ私聊','qq私聊'],group:['QQ群聊','qq群聊'],journal:['写日记','日记']};
      const tasks=repo.tasks.list().sort((a,b)=>a.createdAt-b.createdAt);
      db.setMeta('companion.roles.v1',JSON.stringify(Object.fromEntries(Object.entries(names).map(([role,aliases])=>[role,tasks.find(t=>aliases.includes(t.name))?.id]))));
    }
    return;
  }
  try { return repo.transaction(()=>{
  if (!db.get('SELECT key FROM settings WHERE key = ?', 'memory.autoMaintenanceDaily')) settings.set('memory.autoMaintenanceDaily', true);
  const sections=readSections(settings).sections;
  if(!repo.memory.blocks().length && sections.some(s=>s.kind==='memory')) repo.memory.createBlock({slug:'short-term',name:'短期记忆',content:'',orderIndex:10});
  const channel=repo.channels.list().find(c=>['onebot','snowluma','napcat'].includes(c.type)) ?? repo.channels.create({name:'QQ（待连接 OneBot）',type:'onebot',enabled:true,config:{token:randomBytes(24).toString('base64url')}});
  const contexts = repo.contexts.list();
  const context = contexts[0] ?? repo.contexts.create({ name: '默认上下文', config: {injection:readSections(settings).sections.filter(s=>s.enabled).map(s=>({id:s.id,order:s.order}))} });
  const roles = [
    { names: ['早安', '早上好'], name: '早安', kind: 'custom', goal: '向用户道早安。', spec: { kind: 'daily', at: '08:00' } },
    { names: ['晚安'], name: '晚安', kind: 'custom', goal: '向用户道晚安。', spec: { kind: 'daily', at: '23:00' } },
    { names: ['自由活动'], name: '自由活动', kind: 'activity', goal: '自由活动并记录有意义的结果。', spec: { kind: 'random', cadence: 'poisson', minutes: 180, cooldownMinutes: 60, hours: [9, 22] } },
    { names: ['QQ私聊', 'qq私聊'], name: 'QQ私聊', kind: 'chat', goal: '自然回复私聊消息。', pending: true, type: 'message', spec: { peerKind: 'private', match: 'any', replyMode: 'reply' } },
    { names: ['QQ群聊', 'qq群聊'], name: 'QQ群聊', kind: 'chat', goal: '被提及时自然回复群消息。', pending: true, type: 'message', spec: { peerKind: 'group', match: 'mention', replyMode: 'reply' } },
    { names: ['写日记', '日记'], name: '写日记', kind: 'journal', goal: '回顾今天并写日记。', spec: { kind: 'daily', at: '22:30' } },
  ];
  const tasks = repo.tasks.list({ withTriggers: false });
  const roleIds={};
  for (const [index,role] of roles.entries()) {
    const roleKey=['morning','night','activity','private','group','journal'][index];
    const existing=tasks.find(task=>role.names.some(name=>task.name.toLowerCase()===name.toLowerCase()));
    if(existing){roleIds[roleKey]=existing.id;continue;}
    const task = repo.tasks.create({ name: role.name, kind: role.kind, goal: role.goal, contextId: context.id, conversationMode: role.pending ? 'per-peer' : 'new', enabled: false, description: role.pending ? '待配置 QQ 接入和目标后启用触发规则。' : '' });
    repo.triggers.create(task.id, { type: role.type ?? 'schedule', label: role.name, enabled: !role.pending, spec: role.pending?{...role.spec,channelId:channel.id,requirePeer:true}:role.spec });
    roleIds[roleKey]=task.id;
  }
  db.setMeta('companion.roles.v1',JSON.stringify(roleIds));
  db.setMeta('companion.defaults.v1','1');
  }); } catch(error) {settings.reload();throw error;}
}

