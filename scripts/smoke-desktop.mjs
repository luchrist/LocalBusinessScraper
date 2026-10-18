import { createServer } from 'node:http';
import { fork, execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import { once } from 'node:events';
const root=process.cwd(), temp=await fs.mkdtemp(path.join(os.tmpdir(),'autosetter-smoke-'));
const resources=process.env.AUTOSETTER_SMOKE_RESOURCES || path.join(root,'.desktop');
const runtime=path.join(resources,'runtime',process.platform==='win32'?'node.exe':'node');
const serverRoot=path.join(resources,'server');
const key='ASET-ABCD-EFGH-JKMP';
let activated=false;
const licenses=createServer(async(req,res)=>{
  let raw='';for await(const p of req)raw+=p;const body=JSON.parse(raw);
  res.setHeader('content-type','application/json');
  if(body.key!==key){res.writeHead(403);res.end('{"error":"test key invalid"}');return;}
  if(req.url.endsWith('/activate'))activated=true;
  res.end(JSON.stringify({ok:true,valid:activated}));
});
licenses.listen(0,'127.0.0.1');await once(licenses,'listening');
const reservation=net.createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');const port=reservation.address().port;await new Promise(r=>reservation.close(r));
const token='smoke-only-local-token', origin=`http://127.0.0.1:${port}`, power=[];
const child=fork(path.join(serverRoot,'server.js'),[],{execPath:runtime,cwd:serverRoot,execArgv:[],silent:true,env:{...process.env,NODE_ENV:'production',PORT:String(port),HOSTNAME:'127.0.0.1',AUTOSETTER_DATA_DIR:temp,AUTOSETTER_ASSET_DIR:serverRoot,AUTOSETTER_LOCAL_TOKEN:token,AUTOSETTER_LICENSE_SERVER:`http://127.0.0.1:${licenses.address().port}`,PLAYWRIGHT_BROWSERS_PATH:path.join(resources,'browsers')}});
let logs='';child.stdout.on('data',d=>logs+=d);child.stderr.on('data',d=>logs+=d);child.on('message',m=>{if(m.type==='autosetter-power')power.push(m.active);});
const call=(url,options={})=>fetch(origin+url,{...options,headers:{'x-autosetter-local-token':token,...options.headers}});
try{
  let ready=false;
  for(let i=0;i<100;i++){try{if((await call('/api/health')).ok){ready=true;break;}}catch{} await new Promise(r=>setTimeout(r,100));}
  assert.ok(ready,'server startup: '+logs);
  assert.equal((await fetch(origin+'/api/health')).status,403,'packaged local server rejects requests without token');
  assert.equal((await call('/api/scrape',{method:'POST',body:new FormData()})).status,403,'scrape is gated on backend');
  assert.equal((await call('/api/license',{method:'POST',headers:{'Content-Type':'application/json',origin},body:JSON.stringify({key})})).status,200,'activation works behind loopback origin');
  const form=new FormData();form.append('file',new Blob(['Stadt,Branche,max\nBerlin,Restaurant,60\nHamburg,Hotel,20\n'],{type:'text/csv'}),'searches.csv');form.append('searchEmail','true');form.append('searchOwner','true');
  const preflight=await call('/api/preflight',{method:'POST',headers:{origin},body:form});assert.equal(preflight.status,200);const report=await preflight.json();assert.equal(report.estimatedLeads,80);assert.ok(report.maxMinutes>report.minMinutes);
  assert.equal((await call('/api/history')).status,200,'native SQLite works in bundled Node');
  const bad=await call('/api/scrape',{method:'POST',body:new FormData()});assert.equal(bad.status,200);assert.match(await bad.text(),/No file uploaded/);
  await new Promise(r=>setTimeout(r,100));assert.deepEqual(power,[true,false],'wake lock follows actual job lifecycle including failed start');
  execFileSync(runtime,['--input-type=module','-e',"const {chromium}=await import('playwright');const browser=await chromium.launch({headless:true,args:['--no-sandbox']});await browser.close();console.log('Bundled Chromium launches');"],{cwd:serverRoot,env:{...process.env,PLAYWRIGHT_BROWSERS_PATH:path.join(resources,'browsers')},stdio:'inherit'});
  console.log('Desktop smoke passed: local authentication, activation, preflight CSV limits, native SQLite, wake IPC, bundled Chromium.');
}catch(e){console.error(logs);throw e;}
finally{child.kill();licenses.closeAllConnections();licenses.close();await fs.rm(temp,{recursive:true,force:true});}
