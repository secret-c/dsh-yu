import React, { useEffect, useRef, useState } from 'react';
import { api } from '../lib';
import { Button, Card, ErrorBox, Field, PageHead, useApi } from '../ui';

export function Onboarding() {
  const state = useApi<any>('/api/onboarding');
  const sessions = useApi<any>('/api/dsh/sessions');
  const channels = useApi<any>('/api/channels');
  const peers = useApi<any>('/api/channels/peers');
  const [mode, setMode] = useState<'shared'|'managed'>('shared');
  const [sessionId, setSession] = useState('');
  const [channelId, setChannel] = useState('');
  const [privatePeerId, setPrivate] = useState('');
  const [groupPeerIds, setGroups] = useState<string[]>([]);
  const [authorizeHistory, setConsent] = useState(false);
  const [preview, setPreview] = useState<any>(null);
  const [error, setError] = useState<Error|null>(null);
  const [busy, setBusy] = useState(false);
  const [groupInput, setGroupInput] = useState('');
  const initialized = useRef(false);
  const autoChannel = useRef(false);
  const available = (channels.data?.channels || []).filter((c:any)=>['onebot','napcat','snowluma'].includes(c.type));
  useEffect(() => { if (!state.data || initialized.current) return; initialized.current = true; const s = state.data.selection; if (s) { setMode(s.mode); setSession(s.sessionId || ''); setChannel(s.channelId || ''); setPrivate(s.privatePeerId || ''); setGroups(s.groupPeerIds || []); setConsent(!!s.authorizeHistory); } }, [state.data]);
  useEffect(() => { if (!state.data || !channels.data || autoChannel.current) return; autoChannel.current = true; if (!state.data.selection?.channelId && available.length === 1) setChannel(available[0].id); }, [state.data, channels.data]);
  const selection = {mode, sessionId: mode === 'shared' ? sessionId : null, channelId, privatePeerId, groupPeerIds, authorizeHistory};
  useEffect(() => { setPreview(null); }, [mode, sessionId, channelId, privatePeerId, groupPeerIds, authorizeHistory]);
  useEffect(() => { if (state.data?.status !== 'building') return; const timer = window.setInterval(() => void state.reload(), 1000); return () => window.clearInterval(timer); }, [state.data?.status, state.reload]);
  const run = async (action: 'preview'|'apply'|'build') => { setBusy(true); setError(null); try { const result = await api<any>('/api/onboarding/' + action, {method:'POST', body: action === 'build' ? {} : {...selection, ...(action === 'apply' ? {previewToken:preview?.previewToken} : {})}}); if(action === 'preview') setPreview(result); else {setPreview(null); await state.reload();} } catch(e) {setError(e as Error);} finally {setBusy(false);} };
  const options = (peers.data?.peers || []).filter((p:any) => p.channelId === channelId);
  return <><PageHead title="初始化 Yu" description="选择会话方式和明确允许的聊天对象，预览影响后应用。" />
    {state.error && <ErrorBox error={state.error} onRetry={() => void state.reload()} />}
    <Card title="当前状态"><p>{({unconfigured:'尚未配置','needs-confirmation':'导入后等待重新确认',pending:'等待首次构建',building:'正在构建',failed:'构建失败',ready:'已就绪'} as Record<string,string>)[state.data?.status] || '读取中'} {state.data?.stage || ''}</p>{state.data?.status === 'needs-confirmation' && <p>请重新选择当前宿主的 DSH 会话并授权历史，再预览和确认应用。业务任务保持暂停，首次构建成功后启用。</p>}{state.data?.error && <p role="alert">{state.data.error}</p>}{['pending','failed'].includes(state.data?.status) && <Button disabled={busy} onClick={() => void run('build')}>开始首次记忆构建 / 重试</Button>}</Card>
    <Card title="选择会话方式"><label><input type="radio" checked={mode==='shared'} onChange={() => setMode('shared')} /> 使用已有 DSH 会话</label><p>所有业务任务使用同一个源会话。记忆维护使用独立内部会话，保持源会话整洁。</p><label><input type="radio" checked={mode==='managed'} onChange={() => setMode('managed')} /> Yu 管理会话</label><p>每次业务任务新建会话，成功后归档并维护记忆，失败会话保留。</p></Card>
    <Card title="配置对象">{mode==='shared' && <><Field label="DSH 会话"><select value={sessionId} onChange={e => setSession(e.target.value)}><option value="">请选择会话</option>{(sessions.data?.sessions || []).map((s:any) => <option key={s.sessionId} value={s.sessionId}>{s.title || s.sessionId}</option>)}</select></Field><label><input type="checkbox" checked={authorizeHistory} onChange={e=>setConsent(e.target.checked)} /> 我授权读取所选 DSH 会话过去的完整历史，用于首次构建短期和长期记忆。</label></>}
    <Field label="QQ 接入"><select value={channelId} onChange={e=>{setChannel(e.target.value);setPrivate('');setGroups([]);}}><option value="">请选择接入</option>{(channels.data?.channels || []).filter((c:any)=>['onebot','napcat','snowluma'].includes(c.type)).map((c:any)=><option key={c.id} value={c.id}>{c.name || c.id}</option>)}</select></Field>
    <Field label="私聊对象" help="选择已见过的对象，或手动输入好友 QQ 号。"><select value={options.some((p:any)=>p.peerKind==='private'&&p.peerId===privatePeerId)?privatePeerId:''} onChange={e=>setPrivate(e.target.value)}><option value="">请选择私聊</option>{options.filter((p:any)=>p.peerKind==='private').map((p:any)=><option key={p.peerId} value={p.peerId}>{p.peerLabel || p.peerId} ({p.peerId})</option>)}</select><input aria-label="好友 QQ 号" value={privatePeerId} onChange={e=>setPrivate(e.target.value)} placeholder="好友 QQ 号" /></Field>
    <Field label="群聊对象" help="明确选择或添加至少一个群号。">{options.filter((p:any)=>p.peerKind==='group').map((p:any)=><label key={p.peerId} style={{display:'block'}}><input type="checkbox" checked={groupPeerIds.includes(p.peerId)} onChange={e=>setGroups(e.target.checked ? [...groupPeerIds,p.peerId] : groupPeerIds.filter(id=>id!==p.peerId))} /> {p.peerLabel || p.peerId} ({p.peerId})</label>)}<input aria-label="群号" value={groupInput} onChange={e=>setGroupInput(e.target.value)} placeholder="输入群号" /><Button variant="ghost" onClick={()=>{const id=groupInput.trim(); if (/^\d+$/.test(id)) {setGroups([...new Set([...groupPeerIds,id])]); setGroupInput('');} else setError(new Error('请输入有效的群号'));}}>添加群号</Button>{groupPeerIds.map(id=><div key={id}>已选群：{id} <Button variant="ghost" size="small" onClick={()=>setGroups(groupPeerIds.filter(x=>x!==id))}>移除</Button></div>)}</Field>
    {((mode==='shared' && sessions.error) || channels.error || peers.error) && <ErrorBox error={(mode==='shared' && sessions.error) || channels.error || peers.error} />}
    <Button disabled={busy} onClick={()=>void run('preview')}>预览影响</Button></Card>
    {preview && <Card title="应用影响"><p>六项业务任务（早安、晚安、自由活动、私聊、群聊、日记）：{preview.impact.businessTarget}。</p><p>记忆维护：{preview.impact.maintenance}。</p><p>私聊对象：{privatePeerId}；群聊对象：{groupPeerIds.join('、')}。</p><p>历史读取：{preview.impact.history}。</p><p>沿用既有输出策略；定时任务默认只在会话内，不自动发送 QQ。{preview.impact.activeRuns}。</p><Button disabled={busy} onClick={()=>void run('apply')}>确认应用</Button></Card>}
    {error && <ErrorBox error={error} />}</>;
}
