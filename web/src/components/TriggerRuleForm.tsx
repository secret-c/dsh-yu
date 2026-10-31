import PeerSelector from './PeerSelector';
import React, {useState} from 'react';
import {Field, useApi} from '../ui';

export function triggerRuleError(type:string, s:any):string|null {
 if (!s || typeof s !== 'object' || Array.isArray(s)) return '规则参数必须是对象';
 if (type === 'group-watch' && s.policy === 'keyword-or-count') {
  if (!s.channelId || !s.peerId) return '请选择接入和指定群聊';
  if (!Array.isArray(s.keywords) || !s.keywords.some((word:any)=>String(word).trim())) return '请填写叫她的关键词';
  if (!Number.isInteger(s.messageCount ?? 20) || (s.messageCount ?? 20)<2 || (s.messageCount ?? 20)>200) return '累计消息数须为 2 到 200 的整数';
  if (!Number.isInteger(s.windowMessages ?? 30) || (s.windowMessages ?? 30)<Math.max(20,s.messageCount ?? 20) || (s.windowMessages ?? 30)>200) return '携带消息数须至少覆盖累计消息数且不少于20，最多200';
 }
 if (type === 'message' && (!s.channelId || !s.peerId || !['private','group'].includes(s.peerKind))) return '请选择接入和聊天对象';
 if (type === 'message' && ['prefix','contains'].includes(s.match) && !String(s.value??'').trim()) return '请填写匹配文字';
 if (type === 'schedule') {
  if (['daily','weekly'].includes(s.kind) && !/^([01]\d|2[0-3]):[0-5]\d$/.test(s.at || '')) return '请填写有效时间';
  if (s.kind === 'weekly' && (!Array.isArray(s.days) || !s.days.length)) return '请至少选择一天';
  if (['interval','random','roll'].includes(s.kind) && (!Number.isFinite(Number(s.minutes)) || Number(s.minutes)<1 || Number(s.minutes)>10080 || (s.kind==='interval' && !Number.isInteger(Number(s.minutes))))) return '间隔须为 1 到 10080 分钟';
  if (['random','roll'].includes(s.kind)) {
   if (!Number.isFinite(Number(s.cooldownMinutes ?? 1)) || Number(s.cooldownMinutes ?? 1)<1 || Number(s.cooldownMinutes ?? 1)>Number(s.minutes)) return '冷却须为 1 到等待分钟数';
   if (s.hours != null && (!Array.isArray(s.hours) || s.hours.length!==2 || !s.hours.every(Number.isInteger) || s.hours[0]<0 || s.hours[1]>24 || s.hours[0]>=s.hours[1])) return '活动窗口须满足 0 ≤ 开始 < 结束 ≤ 24';
   if (s.kind==='roll' && (!Number.isInteger(s.sides) || s.sides<2 || s.sides>1000000 || !Number.isInteger(s.target) || s.target<1 || s.target>s.sides)) return '骰子面数须为 2 到 1000000，命中点须为 1 到面数';
  }
  if (s.kind==='cron' && String(s.expr||'').trim().split(/\s+/).length!==5) return 'Cron 需要五段';
  if (s.timezone) { try { new Intl.DateTimeFormat('en', {timeZone:s.timezone}); } catch { return '时区无效，请填写 IANA 时区，如 Asia/Shanghai'; } }
 }
 return null;
}
export function triggerSummary(type:string,s:any):string {
 if(type==='schedule') { const tz=s.timezone || '运行时区'; if(s.kind==='daily') return `每天 ${s.at}（${tz}）`; if(s.kind==='weekly') return `每周 ${Array.isArray(s.days)?s.days.join('、'):''} ${s.at}（${tz}）`; if(s.kind==='interval') return `每 ${s.minutes} 分钟`; if(['random','roll'].includes(s.kind)) return `${s.cadence==='interval'?'固定周期':'指数等待，平均'} ${s.minutes} 分钟${s.kind==='roll'?`；掷 d${s.sides}，≤ ${s.target} 命中`:''}`; return `定时：${s.expr || s.kind}`; }
 if(type==='message') return `消息匹配：${({any:'任意会话',private:'私聊',group:'群聊'} as any)[s.peerKind||'any']||s.peerKind} / ${({any:'全部消息',mention:'@我',prefix:'前缀',contains:'关键词',commands:'斜杠命令'} as any)[s.match||'any']||s.match}${s.peerId?' · '+s.peerId:''}`;
 if(type==='manual') return s.event==='new-session'?'新会话开始前（等待完成）':'手动触发';
 if(type==='group-watch') return s.policy==='keyword-or-count' ? `群聊看一眼：叫关键词或累计 ${s.messageCount ?? 20} 条 · ${s.peerId || '待选群聊'}（可保持安静）` : '群聊观察：先缓存，再按条件查看';
 return type;
}
export default function TriggerRuleForm({type,spec,onChange}:{type:string;spec:any;onChange:(spec:any)=>void}) {
 const [unit,setUnit]=useState(1); const [advanced,setAdvanced]=useState<string|null>(null); const [advancedError,setAdvancedError]=useState(''); const channels=useApi<{channels:any[]}>('/api/channels'); const s=spec || {}; const put=(key:string,value:any)=>onChange({...s,[key]:value});
 const number=(key:string,label:string, fallback:number, min:number,max:number,step=1)=><Field label={label}><input type="number" min={min} max={max} step={step} value={s[key] ?? fallback} onChange={e=>put(key,e.target.value===''?null:Number(e.target.value))}/></Field>;
 const text=(key:string,label:string)=><Field label={label}><input value={s[key] ?? ''} onChange={e=>put(key,e.target.value)}/></Field>;
 const list=(key:string,label:string)=><Field label={label} help="用逗号分隔"><input value={(s[key] || []).join(',')} onChange={e=>put(key,e.target.value.split(','))}/></Field>;
 return <div className="stack"><div className="notice">{triggerSummary(type,s)}</div>
 {type==='manual' && <Field label="触发时机" help="新会话事件仅用于记忆同步任务。"><select value={s.event==='new-session'?'new-session':'manual'} onChange={e=>{const next={...s};if(e.target.value==='manual') delete next.event;else next.event='new-session';onChange(next);}}><option value="manual">手动</option><option value="new-session">新会话开始前（等待完成）</option></select></Field>}
 {type==='group-watch' && <Field label="查看规则"><select aria-label="查看规则" value={s.policy==='keyword-or-count'?'keyword-or-count':'legacy'} onChange={e=>{const next={...s};if(e.target.value==='legacy') delete next.policy;else Object.assign(next,{policy:'keyword-or-count',peerKind:'group',messageCount:s.messageCount ?? 20,windowMessages:Math.max(30,s.windowMessages ?? 30,s.messageCount ?? 20)});onChange(next);}}><option value="keyword-or-count">叫关键词，或累计消息数后看一眼</option><option value="legacy">旧版：关键词概率、时间窗刷屏与连发</option></select></Field>}
 {type==='group-watch' && s.policy!=='keyword-or-count' && <Field label="接入渠道"><select value={s.channelId || ''} onChange={e=>put('channelId',e.target.value)}><option value="">所有渠道</option>{s.channelId && !channels.data?.channels?.some(c=>c.id===s.channelId) && <option value={s.channelId}>现有渠道：{s.channelId}</option>}{channels.data?.channels?.map(c=><option value={c.id} key={c.id}>{c.name || c.id}</option>)}</select></Field>}
 {type==='schedule' && <>
 {['daily','weekly'].includes(s.kind) && <Field label="时间"><input type="time" value={s.at || ''} onChange={e=>put('at',e.target.value)}/></Field>}
 {s.kind==='weekly' && <Field label="星期"><div className="row">{[1,2,3,4,5,6,7].map(d=><label key={d}><input type="checkbox" checked={(s.days || []).includes(d)} onChange={e=>put('days',e.target.checked?[...(s.days||[]),d].sort(): (s.days||[]).filter((x:number)=>x!==d))}/>周{['一','二','三','四','五','六','日'][d-1]}</label>)}</div></Field>}
 {['interval','random','roll'].includes(s.kind) && <><Field label={s.kind==='interval'?'间隔':'平均等待 / 周期'}><div className="row"><input type="number" min={1} value={s.minutes == null?'':s.minutes/unit} onChange={e=>put('minutes',e.target.value===''?null:Number(e.target.value)*unit)}/><select value={unit} onChange={e=>setUnit(Number(e.target.value))}><option value={1}>分钟</option><option value={60}>小时</option><option value={1440}>天</option></select></div></Field></>}
 {['random','roll'].includes(s.kind) && <><Field label="节奏"><select value={s.cadence || 'poisson'} onChange={e=>put('cadence',e.target.value)}><option value="poisson">泊松（指数等待）</option><option value="interval">固定周期</option></select></Field>{number('cooldownMinutes','最小冷却（分钟）',1,1,10080)}<Field label="活动时间"><select value={s.hours?'window':'all'} onChange={e=>put('hours',e.target.value==='all'?null:[8,23])}><option value="all">全天</option><option value="window">指定小时</option></select></Field>{s.hours && <div className="row"><input aria-label="开始小时" type="number" min={0} max={23} value={s.hours[0]} onChange={e=>put('hours',[Number(e.target.value),s.hours[1]])}/>点至<input aria-label="结束小时" type="number" min={1} max={24} value={s.hours[1]} onChange={e=>put('hours',[s.hours[0],Number(e.target.value)])}/>点</div>}{s.kind==='roll' && <>{number('sides','骰子面数',6,2,1000000)}{number('target','点数不大于此值时执行',1,1,s.sides||6)}</>}</>}
 {s.kind==='cron' && text('expr','Cron 表达式（五段）')}
 {['daily','weekly','cron','random','roll'].includes(s.kind) && <Field label="时区" help="留空使用运行时区，例如 Asia/Shanghai"><input value={s.timezone || ''} onChange={e=>put('timezone',e.target.value)}/></Field>}
 </>}
 {type==='message' && <><PeerSelector value={s} onChange={onChange}/><Field label="匹配方式"><select value={s.match||'any'} onChange={e=>put('match',e.target.value)}><option value="any">任意消息</option><option value="mention">被提及</option><option value="prefix">以内容开头</option><option value="contains">包含内容</option><option value="commands">斜杠命令</option></select></Field>{['prefix','contains'].includes(s.match)&&text('value','匹配内容')}{number('maxPerHour','每小时最多回复（0 为不限）',0,0,240)}<Field label="输出路由"><select aria-label="输出路由" value={s.replyMode??'reply'} onChange={e=>put('replyMode',e.target.value)}><option value="reply">回复消息来源（原私聊 / 原群）</option><option value="record">仅在任务会话记录</option></select></Field><Field label="消息活动时间"><select aria-label="消息活动时间" value={s.hours?'window':'all'} onChange={e=>put('hours',e.target.value==='all'?null:[8,23])}><option value="all">全天</option><option value="window">指定小时（可跨午夜）</option></select></Field>{s.hours&&<div className="row"><input aria-label="消息开始小时" type="number" min={0} max={23} value={s.hours[0]} onChange={e=>put('hours',[Number(e.target.value),s.hours[1]])}/>点至<input aria-label="消息结束小时" type="number" min={0} max={23} value={s.hours[1]} onChange={e=>put('hours',[s.hours[0],Number(e.target.value)])}/>点（结束相同表示全天）</div>}</>}
 {type==='group-watch' && s.policy==='keyword-or-count' && <><PeerSelector value={{...s,peerKind:'group'}} peerKind="group" onChange={v=>onChange({...v,peerKind:'group'})}/><div className="notice">在指定群里，叫到任一关键词，或从上次查看后累计到指定消息数，就看一眼近期聊天。两个条件同时命中只查看一次。查看后由模型判断是否接话；没有话想说时只输出 %% ，群里不发送消息。需要接话时只回复原群。</div>{list('keywords','叫她的关键词')}{number('messageCount','累计多少条消息看一眼',20,2,200)}{number('windowMessages','最多携带近期消息数',30,Math.max(20,s.messageCount ?? 20),200)}{number('keepHours','缓存保留（小时）',72,1,720)}</>}
 {type==='group-watch' && s.policy!=='keyword-or-count' && <><div className="notice">群消息先进入缓存；按关键词、刷屏等条件决定是否查看（旧版观察规则）。</div>{text('peerId','指定群号（留空为全部）')}{list('keywords','关键词')}{list('followedIds','关注的人')}{number('keywordProbability','关键词触发概率',0.35,0,1,0.05)}{number('peakMultiplier','峰价概率乘数',0.3,0,1,0.05)}{list('valleyWindows','谷价时段（例如 00:30-08:30）')}{number('floodThreshold','刷屏条数',12,2,200)}{number('floodWindowSec','刷屏窗口（秒）',90,10,3600)}{number('streakThreshold','关注的人连发条数',3,2,50)}{number('windowMessages','最多携带消息数',30,3,200)}{number('keepHours','缓存保留（小时）',72,1,720)}{number('minLookIntervalSec','查看最短间隔（秒）',120,0,3600)}</>}
 {type==='webhook' && number('maxPerHour','每小时最多触发',60,0,1000)}
 <details onToggle={e=>{if(e.currentTarget.open){setAdvanced(JSON.stringify(s,null,2));setAdvancedError('');}else setAdvanced(null);}}><summary>高级参数</summary><p>高级修改需先应用到表单。</p><textarea rows={10} value={advanced ?? JSON.stringify(s,null,2)} onChange={e=>setAdvanced(e.target.value)}/><button type="button" onClick={()=>{try{const v=JSON.parse(advanced || '{}');if(!v || typeof v!=='object' || Array.isArray(v)) throw new Error('参数必须是对象');onChange(v);setAdvancedError('');}catch(e){setAdvancedError((e as Error).message);}}}>应用高级参数</button>{advancedError && <div className="notice bad">{advancedError}</div>}</details>
 {triggerRuleError(type,s) && <div className="notice bad">{triggerRuleError(type,s)}</div>}</div>;
}
