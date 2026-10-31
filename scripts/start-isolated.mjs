#!/usr/bin/env node
// Create an isolated DSH profile; never copies existing accounts or API keys.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync,spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const source=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const root=path.resolve(process.env.YU_REPRO_ROOT || path.join(os.homedir(),'yu-isolated'));
const env={...process.env,DSH_HOME:path.join(root,'dsh')};
const dsh=process.env.DSH_BIN || 'dsh';
const profile=path.join(env.DSH_HOME,'profiles','yu-isolated');
fs.mkdirSync(root,{recursive:true});
if(!fs.existsSync(path.join(profile,'package.json'))){
 const r=spawnSync(dsh,['yu-isolated','--from-default-profile','web','--dump-config'],{env,stdio:'ignore'});
 if(r.status!==0)throw new Error('Install DeepSeek Harness first; dsh must be on PATH (or set DSH_BIN).');
}
const file=path.join(profile,'package.json');const pkg=JSON.parse(fs.readFileSync(file));
pkg.dependencies['@yu/companion']='link:'+source;
if(!pkg.dsh.profile.bundles.includes('@yu/companion'))pkg.dsh.profile.bundles.push('@yu/companion');
fs.writeFileSync(file,JSON.stringify(pkg,null,2));
const modules=path.join(profile,'node_modules','@yu');fs.mkdirSync(modules,{recursive:true});
const link=path.join(modules,'companion');if(!fs.existsSync(link))fs.symlinkSync(source,link,process.platform==='win32'?'junction':'dir');
const port=Number(process.env.YU_PORT || 58810);const dshPort=Number(process.env.YU_DSH_PORT || 30810);
if(!Number.isInteger(port)||!Number.isInteger(dshPort))throw new Error('Ports must be integers');
fs.writeFileSync(path.join(profile,'cordis.patch.yml'),`- id: yu-companion\n  config:\n    port: ${port}\n    host: 127.0.0.1\n    dataDir: ${JSON.stringify(path.join(root,'data'))}\n    exposeViaDshWeb: true\n`);
console.log(`Yu: http://127.0.0.1:${port}/; isolated data: ${root}`);
const child=spawn(dsh,['yu-isolated','--no-open','--port',String(dshPort)],{env,stdio:'inherit'});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal));
child.on('exit',code=>process.exit(code ?? 1));
child.on('error',error=>{console.error(error.message);process.exit(1);});
