import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
const entry = { localUrl: 'http://127.0.0.1:58800/', harnessUrl: 'http://127.0.0.1:60125/yu', adminUrl: 'http://127.0.0.1:60125/yu' };
function render({protocol='dsh-app:', origin='dsh-app://app', data=entry, failOpen=false, verified=true}={}) {
  let component, plugin, index=0;
  const values = [data, {paired:false}, {code:'TEST-0000',showCode:true}, 'ok', '', null, false];
  const opened=[], requests=[];
  const React = { createElement:(type, props, ...children)=>({type,props:props??{},children}), useState:()=>{const i=index++;return [values[i],v=>{values[i]=v;}];},useEffect:()=>{},useCallback:f=>f };
  const window={location:{protocol,origin}, open:(...args)=>{if(failOpen)throw new Error('open denied');opened.push(args);return null;},__ModuleLoader__:{load:m=>{plugin=m.factory(()=>React);}}};
  vm.runInNewContext(source,{window,URL,navigator:{},fetch:async(path, options)=>{
    requests.push({path,method:options.method});
    return {ok:true,text:async()=>JSON.stringify(path.endsWith('/session')?{paired:verified}: {})};
  }});
  plugin.apply({slots:{inject:(_name,f)=>f(),register:(_options,c)=>{component=c;}}});
  function tree(){index=0;return component();}
  function nodes(node){return [node,...(node?.children??[]).flat(Infinity).filter(x=>x&&typeof x==='object').flatMap(nodes)];}
  const find = text=>nodes(tree()).find(n=>n.type==='button'&&n.children.includes(text));
  return {values,opened,requests,find,url:()=>nodes(tree()).find(n=>n.type==='input'&&n.props['aria-label']==='管理台地址')?.props.value};
}

test('desktop opens the advertised independent HTTP console, and provides a copyable URL',()=>{
  const r=render();assert.equal(r.url(),entry.localUrl);r.find('打开管理台').props.onClick();
  assert.equal(r.opened[0][0],entry.localUrl);assert.match(r.values[5].text,/若没有打开/);
  r.find('在管理台修改位置').props.onClick();assert.equal(r.opened[1][0],entry.localUrl+'#/settings/storage');
});
test('desktop login opens the browser without consuming the pairing code',async()=>{
  const r=render();await r.find('在浏览器中登录').props.onClick();assert.equal(r.requests.length,0);assert.equal(r.opened[0][0],entry.localUrl);
});
test('web settings retain the current reverse proxy origin and canonical slash',()=>{
  const r=render({protocol:'https:',origin:'https://example.test'});assert.equal(r.url(),'https://example.test/yu/');
});
test('unavailable URL never guesses another instance and reports the failure',()=>{
  const r=render({data:{}});assert.equal(r.url(),undefined);r.find('打开管理台').props.onClick();assert.equal(r.opened.length,0);assert.match(r.values[5].text,/尚未提供/);
});
test('unsafe schemes, credentials and query strings are not offered',()=>{
  for(const url of ['dsh-app://app/yu','javascript:alert(1)','http://user:pass@localhost/','http://localhost/?token=secret','http://localhost/#secret']) {
    const r=render({data:{localUrl:url}});assert.equal(r.url(),undefined);
  }
});
test('open exceptions and clipboard unavailability are visible',async()=>{
  const r=render({failOpen:true});r.find('打开管理台').props.onClick();assert.match(r.values[5].text,/打开失败/);
  await r.find('复制地址').props.onClick();assert.match(r.values[5].text,/手动复制/);
});
test('web pairing does not falsely report success when the session cookie was discarded',async()=>{
  const r=render({protocol:'http:',origin:'http://localhost',verified:false});await r.find('用这个码登录').props.onClick();
  assert.deepEqual(r.requests.map(x=>[x.method,x.path]),[['POST','/yu/api/pair'],['GET','/yu/api/session']]);assert.match(r.values[5].text,/凭据未保存/);
});
