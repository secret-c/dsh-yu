import React from 'react';
import {useApi,Field} from '../ui';
export default function ResourceSelection({value,onChange,inherited}:{value:any;onChange:(v:any)=>void;inherited?:any}){
 const packages=useApi<any>('/api/tool-packages'), sources=useApi<any>('/api/database-sources');
 return <div className="stack">{[['packages','工具包实例',packages.data?.packages],['sources','数据库来源',sources.data?.sources]].map(([key,label,rows]:any)=>{
   const selection=value?.[key]??null;
   const effective=selection ?? inherited?.[key] ?? null;
   return <Field key={key} label={label} help="继承沿用上级；自选空列表表示无权限。勾选实例后仅授权当时勾选的操作，新安装实例不会扩权。">
     <select aria-label={label+'选择方式'} value={selection===null?'inherit':'custom'} onChange={e=>onChange({...value,[key]:e.target.value==='inherit'?null:[]})}><option value="inherit">继承</option><option value="custom">自选实例与操作</option></select>
     {selection!==null&&(rows??[]).map((row:any)=>{
       const grant=selection.find((g:any)=>g.id===row.id);
       const update=(operations:string[])=>onChange({...value,[key]:selection.map((g:any)=>g.id===row.id?{...g,operations}:g)});
       return <div key={row.id}><label><input type="checkbox" checked={Boolean(grant)} onChange={e=>onChange({...value,[key]:e.target.checked?[...selection,{id:row.id,operations:row.operations.map((o:any)=>o.name)}]:selection.filter((g:any)=>g.id!==row.id)})}/>{row.name} · {row.id}{!row.active?'（停用）':''}</label>{grant&&row.operations.map((o:any)=><label key={o.name} style={{display:'block',marginLeft:20}}><input type="checkbox" checked={grant.operations.includes(o.name)} onChange={e=>update(e.target.checked?[...grant.operations,o.name]:grant.operations.filter((n:string)=>n!==o.name))}/>{o.name}</label>)}</div>;
     })}
     <div className="li-sub">最终有效授权：{effective===null?'继承全局可用实例（遵循原工具策略）':effective.length?effective.map((g:any)=>`${g.id}：${g.operations.length} 项操作`).join('；'):'无'}</div>
   </Field>;
 })}</div>;
}
