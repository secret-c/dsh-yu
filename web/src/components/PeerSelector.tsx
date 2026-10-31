import React, {useEffect} from 'react';
import {Field, useApi} from '../ui';
export default function PeerSelector({value,onChange,peerKind}:{value:any;onChange:(v:any)=>void;peerKind?:'private'|'group'}) {
 const channels=useApi<{channels:any[]}>('/api/channels'); const peers=useApi<{peers:any[]}>('/api/channels/peers');
 const available=(channels.data?.channels||[]).filter(c=>c.enabled && ['onebot','napcat','snowluma'].includes(c.type));
 useEffect(()=>{if(!value.channelId && available.length===1) onChange({...value,channelId:available[0].id,requirePeer:value.requirePeer??true});},[channels.data]);
 const options=(peers.data?.peers||[]).filter(p=>p.channelId===value.channelId && (!peerKind || p.peerKind===peerKind));
 return <><Field label="OneBot 接入"><select aria-label="OneBot 接入" value={value.channelId||''} onChange={e=>onChange({...value,channelId:e.target.value,peerId:'',requirePeer:true})}><option value="">请选择启用的接入</option>{available.map(c=><option key={c.id} value={c.id}>{c.name||c.id}</option>)}{value.channelId&&!available.some(c=>c.id===value.channelId)&&<option value={value.channelId}>当前接入不可用：{value.channelId}</option>}</select></Field>
 <Field label="收到过消息的聊天对象" help="选择具体私聊或群聊；留空不会表示全部对象。"><select aria-label="收到过消息的聊天对象" value={value.peerId?value.peerKind+':'+value.peerId:''} onChange={e=>{const peer=options.find(p=>p.peerKind+':'+p.peerId===e.target.value);onChange({...value,peerId:peer?.peerId||'',peerKind:peer?.peerKind||'private',requirePeer:true});}}><option value="">请选择聊天对象</option>{options.map(p=><option key={p.peerKind+':'+p.peerId} value={p.peerKind+':'+p.peerId}>{p.peerKind==='group'?'群聊':'私聊'} · {p.peerLabel||p.peerId} ({p.peerId})</option>)}{value.peerId&&!options.some(p=>p.peerKind===value.peerKind&&p.peerId===value.peerId)&&<option value={value.peerKind+':'+value.peerId}>当前对象：{value.peerKind==='group'?'群聊':'私聊'} · {value.peerId}</option>}</select></Field>{peers.error&&<div className="notice bad">无法读取聊天对象</div>}</>;
}
