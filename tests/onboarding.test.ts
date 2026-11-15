import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { chooseModel, downloadVerifiedModel } from '../src/lib/model-download';
import { createResultGate } from '../src/lib/trial-usage';

test('RAM choice, resumable model download and integrity failure', async () => {
  assert.equal(chooseModel(12 * 1024 ** 3).id, 'qwen-1.5b');
  assert.equal(chooseModel(16 * 1024 ** 3).id, 'qwen-7b');
  const dir = await mkdtemp(path.join(tmpdir(), 'autosetter-model-'));
  const file = path.join(dir, 'model.gguf');
  const contents = Buffer.from('GGUF-verified-model-fixture');
  const spec = { id: 'fixture', name: 'Fixture', file: 'model.gguf', url: 'https://fixture.invalid/model', size: contents.length, sha256: createHash('sha256').update(contents).digest('hex') };
  try {
    await writeFile(file + '.part', contents.subarray(0, 8));
    let checked = false;
    await downloadVerifiedModel(spec, file, () => {}, (async (_url: unknown, init: RequestInit) => {
      assert.equal((init.headers as Record<string, string>).Range, 'bytes=8-'); checked = true;
      return new Response(contents.subarray(8), { status: 206, headers: { 'content-range': `bytes 8-${contents.length - 1}/${contents.length}` } });
    }) as typeof fetch);
    assert.ok(checked); assert.deepEqual(await readFile(file), contents);
    await assert.rejects(downloadVerifiedModel({ ...spec, sha256: 'a'.repeat(64) }, path.join(dir, 'bad.gguf'), () => {}, (async () => new Response(contents)) as typeof fetch), /Prüfsumme/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('50 free results persist across runs; result 51 waits for one successful payment', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'autosetter-trial-'));
  let paid = false; let upgradeCalls = 0; let paymentFails = true; let inserted = 0;
  const options = { file: () => path.join(dir, 'usage.json'), access: async () => ({ tier: paid ? 'lifetime' as const : 'trial' as const, id: 'trial-1' }),
    upgrade: async () => { upgradeCalls++; if (paymentFails) throw new Error('bank confirmation required'); paid = true; } };
  try {
    const first = createResultGate(options);
    await Promise.all(Array.from({ length: 50 }, () => first.record(() => ++inserted)));
    assert.equal(inserted, 50); assert.equal(upgradeCalls, 0); assert.equal(await first.usage('trial-1'), 50);
    const restarted = createResultGate(options);
    await assert.rejects(restarted.record(() => ++inserted), /confirmation/);
    assert.equal(inserted, 50, 'result 51 must not be persisted before successful payment');
    assert.equal(await restarted.usage('trial-1'), 50);
    paymentFails = false;
    await Promise.all(Array.from({ length: 4 }, () => restarted.record(() => ++inserted)));
    assert.equal(inserted, 54); assert.equal(upgradeCalls, 2, 'one failed attempt, one successful upgrade, then no further calls');
    const paidRestart = createResultGate(options);
    await paidRestart.record(() => ++inserted); assert.equal(upgradeCalls, 2, 'paid license remains local');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
