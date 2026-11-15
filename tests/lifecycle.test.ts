import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { generateKeyPairSync, sign } from 'node:crypto';

test('one online activation, offline restarts, copied certificates and tamper rejection', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'autosetter-test-'));
  const {privateKey,publicKey}=generateKeyPairSync('ed25519');
  const encodedPublic=publicKey.export({type:'spki',format:'der'}).toString('base64');
  let requests=0;let bound='';let machine='a'.repeat(64);let forged=false;
  const api=createServer(async(req,res)=>{
    requests++;
    let raw='';for await(const part of req)raw+=part;
    const body=JSON.parse(raw);res.setHeader('content-type','application/json');
    assert.equal(req.url,'/api/license/activate','only activation may contact the server');
    if(body.key!=='ASET-ABCD-EFGH-JKMP'||(bound&&bound!==body.machine_id)){
      res.writeHead(403);res.end('{"error":"already activated"}');return;
    }
    bound=body.machine_id;
    const payload=Buffer.from(JSON.stringify({v:1,product:'autosetter_lifetime_v1',id:'license-1',machine:bound})).toString('base64url');
    const certificate=forged?'ASET1.invalid.invalid':`ASET1.${payload}.${sign(null,Buffer.from(payload),privateKey).toString('base64url')}`;
    res.end(JSON.stringify({ok:true,certificate}));
  });
  api.listen(0,'127.0.0.1');await once(api,'listening');
  try {
    const {createLicenseManager}=await import('../src/lib/app-license');
    const config={server:`http://127.0.0.1:${(api.address() as any).port}`,publicKey:encodedPublic,file:()=>path.join(dir,'license.json'),machine:async()=>machine};
    const license=createLicenseManager(config);
    const guard=await import('../src/lib/run-guard');
    await assert.rejects(guard.beginRun(license.requireLicense),/Lizenz/);
    await license.activateLicense('ASET-ABCD-EFGH-JKMP');
    assert.equal(requests,1);
    const original=await readFile(config.file(),'utf8');
    assert.ok(JSON.parse(original).certificate);
    assert.equal(JSON.parse(original).key,undefined,'the reusable purchase key is not stored');
    const stop=await guard.beginRun(license.requireLicense);assert.equal(guard.isRunning(),true);
    await assert.rejects(guard.beginRun(license.requireLicense),/bereits/);
    stop();stop();assert.equal(guard.isRunning(),false);
    await createLicenseManager(config).requireLicense();
    assert.equal(requests,1,'restarts and new runs must work without a network request');

    machine='b'.repeat(64);
    await assert.rejects(license.requireLicense(),/Lizenz/,'copied activation cannot unlock another device');
    await assert.rejects(license.activateLicense('ASET-ABCD-EFGH-JKMP'),/already activated/);
    machine='a'.repeat(64);
    const parsed=JSON.parse(original);
    const [version,payload,signature]=parsed.certificate.split('.');
    const changed=Buffer.from(JSON.stringify({...JSON.parse(Buffer.from(payload,'base64url').toString()),machine:'b'.repeat(64)})).toString('base64url');
    await writeFile(config.file(),JSON.stringify({certificate:`${version}.${changed}.${signature}`}));
    await assert.rejects(license.requireLicense(),/Lizenz/,'editing the signed machine ID must be rejected');
    await writeFile(config.file(),original);
    forged=true;
    await assert.rejects(license.activateLicense('ASET-ABCD-EFGH-JKMP'),/bestätigt/);
    assert.equal(await readFile(config.file(),'utf8'),original,'bad server responses must not replace valid activation');
    api.closeAllConnections();api.close();
    await createLicenseManager(config).requireLicense();
  } finally {api.closeAllConnections();api.close();await rm(dir,{recursive:true,force:true});}
});

test('preflight produces a conservative planning range from actual OS metrics', async()=>{
  const { systemPreflight }=await import('../src/lib/system-preflight');
  const result=await systemPreflight({leads:1000,searches:10,enrich:true,workers:2,openEnded:false});
  assert.ok(result.totalGb>0);assert.ok(result.availableGb>=0);assert.ok(result.cpuPercent>=0&&result.cpuPercent<=100);
  assert.ok(result.maxMinutes>result.minMinutes);assert.equal(result.estimatedLeads,1000);assert.equal(result.openEnded,false);
});

test('trial certificates remain restricted; bank failure and offline upgrade pause until a signed paid license arrives', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'autosetter-trial-license-'));
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const machine = 'a'.repeat(64); let paid = false; let requests = 0;
  const certificate = (trial: boolean) => {
    const payload = Buffer.from(JSON.stringify(trial ? { v: 2, product: 'autosetter_trial_v1', id: 'trial-1', machine, limit: 50, priceCents: 29900 } : { v: 1, product: 'autosetter_lifetime_v1', id: 'paid-1', machine })).toString('base64url');
    return `${trial ? 'ASET2' : 'ASET1'}.${payload}.${sign(null, Buffer.from(payload), privateKey).toString('base64url')}`;
  };
  const api = createServer(async (req, res) => {
    requests++; res.setHeader('content-type', 'application/json');
    if (req.url === '/api/license/activate') return res.end(JSON.stringify({ certificate: certificate(true) }));
    assert.equal(req.url, '/api/trial/upgrade');
    if (!paid) return res.end(JSON.stringify({ paid: false, paymentUrl: 'https://checkout.stripe.com/test' }));
    res.end(JSON.stringify({ paid: true, certificate: certificate(false) }));
  });
  api.listen(0, '127.0.0.1'); await once(api, 'listening');
  try {
    const { createLicenseManager, TrialPaymentRequired } = await import('../src/lib/app-license');
    const { readLicenseCertificate } = await import('../src/lib/license-certificate');
    const encodedPublic = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    const config = { server: `http://127.0.0.1:${(api.address() as any).port}`, publicKey: encodedPublic, file: () => path.join(dir, 'license.json'), machine: async () => machine };
    const manager = createLicenseManager(config);
    await manager.activateLicense('TEST'); assert.equal((await manager.access()).tier, 'trial');
    assert.equal(readLicenseCertificate(certificate(true).replace('ASET2.', 'ASET1.'), machine, encodedPublic), null);
    assert.equal(readLicenseCertificate(certificate(true), 'b'.repeat(64), encodedPublic), null);
    await assert.rejects(manager.upgradeTrial(), e => e instanceof TrialPaymentRequired && !!e.paymentUrl);
    assert.equal((await manager.access()).tier, 'trial');
    paid = true; await manager.upgradeTrial(); assert.equal((await manager.access()).tier, 'lifetime');
    const before = requests; api.closeAllConnections(); api.close();
    await createLicenseManager(config).upgradeTrial(); assert.equal(requests, before);
    await writeFile(config.file(), JSON.stringify({ certificate: certificate(true) }));
    await assert.rejects(createLicenseManager(config).upgradeTrial(), TrialPaymentRequired);
  } finally { api.closeAllConnections(); api.close(); await rm(dir, { recursive: true, force: true }); }
});
