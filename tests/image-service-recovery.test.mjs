import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createImageServiceStore } from '../qianmu-image-service-store.js';
import { createImageServiceQueue, imageServiceChannelKey, describeImageServiceRequest } from '../qianmu-image-service-queue.js';
import { imageServiceAccount, queryImageServiceTask } from '../qianmu-image-service-access.js';
import { inspectImageServiceRecovery, recoverImageServiceRecords, restoreInterruptedImageRecovery } from '../qianmu-image-service-recovery.js';

const key = imageServiceChannelKey('mock-recovery-key');
const account = { user: { profile: { handle: 'alice', enabled: true } } };
const row = status => ({ namespace: imageServiceAccount(account).namespace, attemptId: `job-${status}`, requestDigest: 'a'.repeat(64),
  ownerId: 'old-service', fence: 'original-fence', status, automatic: true, createdAt: 1, updatedAt: 2 });
const state = (status, channelKey = key) => ({ schema: 'qianmu.image-service-channel.v1', channelKey, entries: [row(status)] });
async function fixture(t, status = 'submitting') {
  const parent = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(parent, 'qianmu-recovery-test-'));
  t.after(async () => { const resolved = await fs.realpath(root); assert.equal(path.dirname(resolved), parent); assert.match(path.basename(resolved), /^qianmu-recovery-test-/); await fs.rm(resolved, { recursive: true }); });
  const store = createImageServiceStore({ dataRoot: root }); t.after(() => store.close());
  if (status) await store.transaction(key, () => ({ state: state(status) }));
  return { root, store, active: path.join(root, '.qianmu-service', 'image-queue-v1') };
}
const hash = buffer => createHash('sha256').update(buffer).digest('hex');
const never = () => assert.fail('recovery cannot submit generation');
async function child(script) {
  const task = spawn(process.execPath, ['--input-type=module', '-e', script], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); let output = '';
  task.stdout.on('data', value => { output += value; }); task.stderr.on('data', value => { output += value; });
  return new Promise((resolve, reject) => { task.once('error', reject); task.once('close', code => code === 0 ? resolve({ pid: task.pid, output }) : reject(Error(`child ${code}: ${output.slice(0, 1000)}`))); });
}

test('inspection is readonly and does not create missing service folders', async t => {
  const { root } = await fixture(t, null);
  const plan = await inspectImageServiceRecovery({ dataRoot: root });
  assert.equal(plan.exists, false); assert.equal(plan.files.length, 0); assert.deepEqual(await fs.readdir(root), []);
});

test('offline assertion and exact snapshot confirmation are both mandatory', async t => {
  const { root, active } = await fixture(t), data = await fs.readFile(path.join(active, `${key}.json`));
  const plan = await inspectImageServiceRecovery({ dataRoot: root });
  await assert.rejects(recoverImageServiceRecords({ dataRoot: root, confirmation: plan.confirmation }), { code: 'image_service_recovery_offline_required' });
  await assert.rejects(recoverImageServiceRecords({ dataRoot: root, confirmation: '0'.repeat(64), serverStopped: true }), { code: 'image_service_recovery_changed' });
  assert.deepEqual(await fs.readFile(path.join(active, `${key}.json`)), data);
  assert.deepEqual(await fs.readdir(active), [`${key}.json`]);
});

test('recovery preserves originals and distinguishes never-sent from uncertain without replaying either', async t => {
  const { root, store, active } = await fixture(t), otherKey = imageServiceChannelKey('other-recovery-key');
  await store.transaction(otherKey, () => ({ state: state('reserved', otherKey) }));
  const originals = await Promise.all([key, otherKey].map(async key => [key, await fs.readFile(path.join(active, `${key}.json`))]));
  const plan = await inspectImageServiceRecovery({ dataRoot: root });
  assert.equal(plan.submitting, 1); assert.equal(plan.reserved, 1);
  const result = await recoverImageServiceRecords({ dataRoot: root, confirmation: plan.confirmation, serverStopped: true });
  assert.equal(result.released, 1); assert.equal(result.uncertain, 1); assert.equal(result.automaticResubmissions, 0);
  for (const [name, buffer] of originals) assert.deepEqual(await fs.readFile(path.join(result.backup, `${name}.json`)), buffer);
  assert.equal((await store.inspectChannel(key)).entries[0].status, 'uncertain');
  assert.equal((await store.inspectChannel(otherKey)).entries[0].status, 'released');
  assert.equal((await store.inspectChannel(key)).entries[0].fence, 'original-fence');
  const task = await queryImageServiceTask(account, { apiKey: 'mock-recovery-key', attemptId: 'job-submitting' }, { store });
  assert.equal(task.task.status, 'uncertain'); assert.equal(task.task.needsReview, true);
  const queue = createImageServiceQueue({ store }); t.after(() => queue.close());
  const description = describeImageServiceRequest({ prompt: 'mock' });
  await assert.rejects(queue.run({ apiKey: 'mock-recovery-key', namespace: imageServiceAccount(account).namespace, attemptId: 'new', automatic: true, ...description }, never), { code: 'image_service_confirmation_required' });
});

test('record changes after preview invalidate confirmation with no partial writes', async t => {
  const { root, store, active } = await fixture(t), plan = await inspectImageServiceRecovery({ dataRoot: root });
  await store.transaction(key, current => { current.entries[0].updatedAt = 3; return { state: current }; });
  await assert.rejects(recoverImageServiceRecords({ dataRoot: root, confirmation: plan.confirmation, serverStopped: true }), { code: 'image_service_recovery_changed' });
  assert.equal((await store.inspectChannel(key)).entries[0].status, 'submitting');
  assert.ok(!(await fs.readdir(active)).includes('.maintenance.lock'));
});

test('a live lock owner is never displaced and an existing maintenance owner is never removed', async t => {
  const { root, active } = await fixture(t), lock = path.join(active, '.transaction.lock');
  await fs.writeFile(lock, JSON.stringify({ pid: process.pid }));
  let plan = await inspectImageServiceRecovery({ dataRoot: root });
  await assert.rejects(recoverImageServiceRecords({ dataRoot: root, confirmation: plan.confirmation, serverStopped: true }), { code: 'image_service_recovery_owner' });
  assert.ok((await fs.readdir(active)).includes('.transaction.lock'));
  const maintenance = path.join(active, '.maintenance.lock'); await fs.writeFile(maintenance, JSON.stringify({ owner: 'someone-else', pid: process.pid }));
  plan = await inspectImageServiceRecovery({ dataRoot: root });
  assert.equal(plan.maintenance, true);
  await assert.rejects(recoverImageServiceRecords({ dataRoot: root, confirmation: plan.confirmation, serverStopped: true }), { code: 'image_service_recovery_maintenance' });
  assert.equal(JSON.parse(await fs.readFile(maintenance, 'utf8')).owner, 'someone-else');
});

test('actual crashed-process write locks and staged bytes are retained in the backup, not discarded', async t => {
  const { root, active, store } = await fixture(t, null);
  const storeUrl = new URL('../qianmu-image-service-store.js', import.meta.url).href;
  await child(`import * as fs from 'node:fs/promises';import {createImageServiceStore} from ${JSON.stringify(storeUrl)};
    const store=createImageServiceStore({dataRoot:${JSON.stringify(root)},fileSystem:{...fs,rename:async()=>process.exit(0)}});
    await store.transaction(${JSON.stringify(key)},()=>({state:${JSON.stringify(state('reserved'))}}));`);
  const before = await fs.readdir(active), plan = await inspectImageServiceRecovery({ dataRoot: root });
  const result = await recoverImageServiceRecords({ dataRoot: root, confirmation: plan.confirmation, serverStopped: true });
  assert.deepEqual(await fs.readdir(active), []);
  for (const name of before) {
    const original = await fs.readFile(path.join(result.backup, name)), preserved = await fs.readFile(path.join(result.backup, `evidence-${name}`));
    assert.deepEqual(original, preserved);
  }
  assert.equal(await store.inspectChannel(key), undefined, 'staged but uncommitted metadata is not promoted to a submitted request');
});

test('terminal and already-uncertain histories need no rewrite or redundant backup', async t => {
  for (const status of ['succeeded', 'rejected', 'released', 'acknowledged', 'uncertain']) {
    const { root, active, store } = await fixture(t, status), original = await fs.readFile(path.join(active, `${key}.json`));
    const plan = await inspectImageServiceRecovery({ dataRoot: root });
    const result = await recoverImageServiceRecords({ dataRoot: root, confirmation: plan.confirmation, serverStopped: true });
    assert.equal(result.backup, null); assert.equal((await store.inspectChannel(key)).entries[0].status, status);
    assert.deepEqual(await fs.readFile(path.join(active, `${key}.json`)), original);
  }
});

test('corrupted or foreign files cannot be silently replaced during inspection or recovery', async t => {
  const { root, active } = await fixture(t), target = path.join(active, `${key}.json`);
  const original = await fs.readFile(target); await fs.writeFile(target, 'null');
  await assert.rejects(inspectImageServiceRecovery({ dataRoot: root }), { code: 'image_service_recovery_corrupt' });
  await fs.writeFile(target, original); await fs.writeFile(path.join(active, 'unrelated.txt'), 'do not delete');
  await assert.rejects(inspectImageServiceRecovery({ dataRoot: root }), { code: 'image_service_recovery_file' });
  assert.equal(await fs.readFile(path.join(active, 'unrelated.txt'), 'utf8'), 'do not delete');
});

test('backup checksums match original bytes and recovery cannot be replayed from an old preview', async t => {
  const { root } = await fixture(t), plan = await inspectImageServiceRecovery({ dataRoot: root });
  const result = await recoverImageServiceRecords({ dataRoot: root, confirmation: plan.confirmation, serverStopped: true });
  const manifest = JSON.parse(await fs.readFile(path.join(result.backup, 'manifest.json'), 'utf8'));
  for (const entry of manifest.files) assert.equal(hash(await fs.readFile(path.join(result.backup, entry.name))), entry.checksum);
  await assert.rejects(recoverImageServiceRecords({ dataRoot: root, confirmation: plan.confirmation, serverStopped: true }), { code: 'image_service_recovery_changed' });
});

test('offline command inspection accepts only explicit arguments and never installs a live endpoint', async t => {
  const { root } = await fixture(t);
  const script = new URL('../scripts/recover-image-service.mjs', import.meta.url).href;
  const output = await child(`process.argv=['node','recover','--data-root',${JSON.stringify(root)},'--inspect']; await import(${JSON.stringify(script)});`);
  assert.equal(JSON.parse(output.output.trim()).submitting, 1);
  const runtime = await fs.readFile(new URL('../server-plugin.js', import.meta.url), 'utf8');
  assert.doesNotMatch(runtime, /recoverImageServiceRecords|qianmu-image-service-recovery/);
});

async function interrupted(t) {
  const context = await fixture(t), plan = await inspectImageServiceRecovery({ dataRoot: context.root });
  const result = await recoverImageServiceRecords({ dataRoot: context.root, confirmation: plan.confirmation, serverStopped: true });
  const manifest = JSON.parse(await fs.readFile(path.join(result.backup, 'manifest.json'), 'utf8'));
  // Model the exact on-disk state after replacing the last record, before writing
  // the completed marker. Original bytes come from the real recovery operation.
  await fs.unlink(path.join(result.backup, 'completed.json'));
  const dead = await child('process.exit(0)');
  const gate = { schema: 'qianmu.image-service-maintenance.v1', owner: manifest.recoveryOwner, pid: dead.pid };
  await fs.writeFile(path.join(context.active, '.maintenance.lock'), JSON.stringify(gate));
  return { ...context, backup: result.backup, backupId: path.basename(result.backup), manifest, gate };
}

test('interrupted recovery can restore its exact originals without losing the request identity', async t => {
  const { root, active, store, backup, backupId, manifest } = await interrupted(t);
  const result = await restoreInterruptedImageRecovery({ dataRoot: root, backupId, serverStopped: true });
  assert.equal(result.automaticResubmissions, 0); assert.equal(result.next, 'inspect-before-recovery');
  for (const item of manifest.files) assert.deepEqual(await fs.readFile(path.join(active, item.name)), await fs.readFile(path.join(backup, item.name)));
  assert.equal((await store.inspectChannel(key)).entries[0].status, 'submitting', 'restoring evidence is not declaring a refund');
  assert.ok(!(await fs.readdir(active)).includes('.maintenance.lock'));
  assert.ok(!(await fs.readdir(backup)).includes('.restore.lock'));
  const next = await inspectImageServiceRecovery({ dataRoot: root });
  await recoverImageServiceRecords({ dataRoot: root, confirmation: next.confirmation, serverStopped: true });
  assert.equal((await store.inspectChannel(key)).entries[0].status, 'uncertain');
});

test('an old completed backup cannot overwrite subsequent service history', async t => {
  const { root, store } = await fixture(t), plan = await inspectImageServiceRecovery({ dataRoot: root });
  const result = await recoverImageServiceRecords({ dataRoot: root, confirmation: plan.confirmation, serverStopped: true });
  await assert.rejects(restoreInterruptedImageRecovery({ dataRoot: root, backupId: path.basename(result.backup), serverStopped: true }), { code: 'image_service_recovery_completed' });
  assert.equal((await store.inspectChannel(key)).entries[0].status, 'uncertain');
});

test('restore refuses new or unrelated changes even with a matching old backup owner', async t => {
  const { root, active, backupId } = await interrupted(t);
  const target = path.join(active, `${key}.json`), record = JSON.parse(await fs.readFile(target, 'utf8'));
  record.state.entries[0].fence = 'different-paid-request'; record.checksum = hash(JSON.stringify(record.state));
  await fs.writeFile(target, JSON.stringify(record));
  await assert.rejects(restoreInterruptedImageRecovery({ dataRoot: root, backupId, serverStopped: true }), { code: 'image_service_recovery_changed' });
  assert.equal(JSON.parse(await fs.readFile(target, 'utf8')).state.entries[0].fence, 'different-paid-request');
});

test('restore verifies backups and cannot displace a living recovery owner', async t => {
  const { root, active, backup, backupId, gate, manifest } = await interrupted(t);
  const maintenance = path.join(active, '.maintenance.lock');
  await fs.writeFile(maintenance, JSON.stringify({ ...gate, pid: process.pid }));
  await assert.rejects(restoreInterruptedImageRecovery({ dataRoot: root, backupId, serverStopped: true }), { code: 'image_service_recovery_owner' });
  await fs.writeFile(maintenance, JSON.stringify(gate));
  await fs.writeFile(path.join(backup, manifest.files[0].name), 'altered backup');
  await assert.rejects(restoreInterruptedImageRecovery({ dataRoot: root, backupId, serverStopped: true }), { code: 'image_service_recovery_backup' });
  assert.ok((await fs.readdir(active)).includes('.maintenance.lock'));
  for (const invalid of ['../outside', '/', '', 'a'.repeat(36)]) await assert.rejects(restoreInterruptedImageRecovery({ dataRoot: root, backupId: invalid, serverStopped: true }));
});

test('real process interruption and post-rename I/O failure retain a recoverable partial repair fence', async t => {
  for (const mode of ['exit', 'io-error']) {
    const { root, store, active } = await fixture(t), second = imageServiceChannelKey('partial-repair-second');
    await store.transaction(second, () => ({ state: state('reserved', second) }));
    const original = await inspectImageServiceRecovery({ dataRoot: root });
    const recoveryUrl = new URL('../qianmu-image-service-recovery.js', import.meta.url).href;
    await child(`import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
      const rename=fs.promises.rename;let first=true;
      fs.promises.rename=async(...args)=>{await rename(...args);if(first){first=false;${mode === 'exit' ? 'process.exit(0);' : "throw Object.assign(Error('simulated post-rename failure'),{code:'EIO'});"}}};
      syncBuiltinESMExports();
      const {recoverImageServiceRecords}=await import(${JSON.stringify(recoveryUrl)});
      try{await recoverImageServiceRecords({dataRoot:${JSON.stringify(root)},confirmation:${JSON.stringify(original.confirmation)},serverStopped:true});process.exitCode=2;}
      catch(error){if(error.code!=='image_service_recovery_io'||!error.backupId||error.recoveryInterrupted!==true)throw error;}`);
    assert.ok((await fs.readdir(active)).includes('.maintenance.lock'));
    await assert.rejects(store.transaction(key, never), { code: 'image_service_storage_maintenance' });
    const backupRoot = path.join(root, '.qianmu-service', 'image-queue-recovery'), backups = await fs.readdir(backupRoot);
    assert.equal(backups.length, 1);
    await restoreInterruptedImageRecovery({ dataRoot: root, backupId: backups[0], serverStopped: true });
    assert.equal((await inspectImageServiceRecovery({ dataRoot: root })).confirmation, original.confirmation);
    assert.ok(!(await fs.readdir(active)).includes('.maintenance.lock'));
  }
});
