import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';

test('license required, device binding, single run, wake cleanup and revocation', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'autosetter-test-'));
  process.env.AUTOSETTER_DATA_DIR=dir;
  let revoked=false; let device='';
  const api=createServer(async(req,res)=>{
    let raw=''; for await(const part of req) raw+=part;
    const body=JSON.parse(raw); res.setHeader('content-type','application/json');
    if (body.key !== 'ASET-ABCD-EFGH-JKMP' || revoked) {res.writeHead(403);res.end(JSON.stringify({error:'revoked'}));return;}
    if(req.url?.endsWith('/activate')){device=body.machine_id;res.end('{"ok":true}');}
    else if(req.url?.endsWith('/deactivate')){device='';res.end('{"ok":true}');}
    else{res.end(JSON.stringify({valid:device===body.machine_id}));}
  });
  api.listen(0,'127.0.0.1'); await once(api,'listening');
  process.env.AUTOSETTER_LICENSE_SERVER=`http://127.0.0.1:${(api.address() as any).port}`;
  try {
    const license=await import('../src/lib/app-license');
    const guard=await import('../src/lib/run-guard');
    await assert.rejects(guard.beginRun(), /Lizenz/);
    await license.activateLicense('ASET-ABCD-EFGH-JKMP');
    assert.match(device,/^[a-f0-9]{64}$/);
    assert.equal(JSON.parse(await readFile(path.join(dir,'license.json'),'utf8')).key,'ASET-ABCD-EFGH-JKMP');
    const stop=await guard.beginRun(); assert.equal(guard.isRunning(),true);
    await assert.rejects(guard.beginRun(), /bereits/);
    stop();stop();assert.equal(guard.isRunning(),false);
    revoked=true;await assert.rejects(guard.beginRun(), /revoked/);assert.equal(guard.isRunning(),false);
    revoked=false;await license.deactivateLicense();assert.equal(await license.savedLicense(),null);
  } finally {api.closeAllConnections();api.close();await rm(dir,{recursive:true,force:true});}
});

test('preflight produces a conservative planning range from actual OS metrics', async()=>{
  const { systemPreflight }=await import('../src/lib/system-preflight');
  const result=await systemPreflight({leads:1000,searches:10,enrich:true,workers:2,openEnded:false});
  assert.ok(result.totalGb>0);assert.ok(result.availableGb>=0);assert.ok(result.cpuPercent>=0&&result.cpuPercent<=100);
  assert.ok(result.maxMinutes>result.minMinutes);assert.equal(result.estimatedLeads,1000);assert.equal(result.openEnded,false);
});
