import React from 'react';
import {useApi,Field,Button} from '../ui';
export default function InjectionSelection({value,onChange,label='注入资源',parentContext=false}:{value:any;onChange:(next:any)=>void;label?:string;parentContext?:boolean}) {
  const resources=useApi<any>('/api/inject');
  const selected=Array.isArray(value)?value:null;
  const effective=selected ?? (resources.data?.sections??[]).filter((s:any)=>s.enabled).map((s:any)=>({id:s.id,order:s.order}));
  return <Field label={label} help="继承使用上级配置；自选的空列表表示不注入。每个绑定可覆盖顺序、字符预算和投递时机。">
    <select value={selected===null?'inherit':'custom'} onChange={e=>onChange(e.target.value==='inherit'?null:(parentContext&&selected===null?[]:effective))}><option value="inherit">继承</option><option value="custom">自选资源</option></select>
    {selected===null&&<div className="li-sub">{parentContext?"继承上级，实际选择请查看上下文方案。":"当前继承全局已启用资源；以下为有效选择。切换自选后可修改。"}</div>}
    {resources.error&&<div role="alert">无法读取注入资源：{resources.error.message}</div>}
    {!(parentContext&&selected===null)&&<div className="stack">{(resources.data?.sections??[]).map((s:any)=>{const binding=effective.find((b:any)=>b.id===s.id);return <div key={s.id}>
      <label><input type="checkbox" checked={Boolean(binding)} disabled={selected===null} onChange={e=>onChange(e.target.checked?[...effective,{id:s.id,order:effective.length*10}]:effective.filter((b:any)=>b.id!==s.id))}/>{s.title} · {s.source?.path??'动态检索'}</label>
      {binding&&selected!==null&&<div className="row"><input aria-label={s.title+'顺序'} type="number" min="0" max="1000" value={binding.order??s.order} onChange={e=>onChange(selected.map((b:any)=>b.id===s.id?{...b,order:Number(e.target.value)}:b))}/><input aria-label={s.title+'字符预算'} type="number" min="0" max="400000" value={binding.maxChars??s.maxChars??14000} onChange={e=>onChange(selected.map((b:any)=>b.id===s.id?{...b,maxChars:Number(e.target.value)}:b))}/><select value={binding.scope??s.scope} onChange={e=>onChange(selected.map((b:any)=>b.id===s.id?{...b,scope:e.target.value}:b))}><option value="session">每会话</option><option value="turn">每轮</option></select></div>}
      {binding&&selected!==null&&<div><select aria-label={s.title+'注入通道'} value={binding.channel??s.channel} onChange={e=>onChange(selected.map((b:any)=>b.id===s.id?{...b,channel:e.target.value}:b))}><option value="system">系统提示词</option><option value="history">用户消息材料</option></select><textarea aria-label={s.title+'模板'} value={binding.template??s.template??'{{content}}'} onChange={e=>onChange(selected.map((b:any)=>b.id===s.id?{...b,template:e.target.value}:b))}/></div>}
    </div>;})}{selected!==null&&<Button variant="quiet" size="small" onClick={()=>onChange([])}>清空选择</Button>}</div>}
  </Field>;
}
