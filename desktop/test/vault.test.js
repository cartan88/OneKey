'use strict';

/**
 * Smoke tests for the crypto + vault layer. Runs on plain Node — no Electron,
 * no window — because nothing in vault.js or crypto.js depends on either.
 *
 *   npm test
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const assert = require('assert');

const { Vault } = require('../src/vault.js');
const { generatePassword } = require('../src/crypto.js');
const strength = require('../src/renderer/strength.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onekey-test-'));
const log = (...a) => console.log('  ok', ...a);

(async () => {
  const v = new Vault(dir);
  assert.strictEqual(v.exists(), false);

  await assert.rejects(() => v.create('short'), (e) => e.code === 'WEAK_MASTER');
  log('rejects a master password under 8 chars');

  let t = Date.now();
  await v.create('correct horse battery');
  log(`created vault in ${Date.now() - t}ms (scrypt N=2^17)`);
  assert.ok(v.exists() && v.isUnlocked);

  const a = await v.addEntry({
    name: 'Gmail',
    username: 'me@x.com',
    password: 'Tr0ub4dor&3xyz!',
    url: 'https://mail.google.com',
    folder: 'Email',
    favorite: true,
  });
  await v.addEntry({ name: 'Reddit', username: 'me', password: 'password', notes: 'throwaway' });
  await v.addEntry({ name: 'Forum', username: 'me', password: 'password' });

  assert.strictEqual(v.listEntries().length, 3);
  assert.ok(!('password' in v.listEntries()[0]), 'listEntries must not leak passwords');
  log('added 3 entries; the list handed to the UI is redacted');

  const byName = Object.fromEntries(v.listEntries().map((e) => [e.name, e]));
  assert.strictEqual(byName.Reddit.reused, true);
  assert.strictEqual(byName.Forum.reused, true);
  assert.strictEqual(byName.Gmail.reused, false);
  assert.strictEqual(byName.Reddit.strength.score, 0);
  assert.ok(byName.Gmail.strength.score >= 3);
  log('reuse detection and strength scoring:', byName.Gmail.strength.label, '/', byName.Reddit.strength.label);

  assert.strictEqual(v.revealPassword(a.id), 'Tr0ub4dor&3xyz!');
  log('reveals the correct password by id');

  await v.updateEntry(a.id, { name: 'Gmail (work)', password: 'NewP@ssw0rd-1234' });
  assert.strictEqual(v.revealPassword(a.id), 'NewP@ssw0rd-1234');
  await v.updateEntry(a.id, { notes: 'kept' });
  assert.strictEqual(v.revealPassword(a.id), 'NewP@ssw0rd-1234', 'omitted password must survive');
  await v.updateEntry(a.id, { password: '' });
  assert.strictEqual(v.revealPassword(a.id), '');
  log('update: changes, preserves on omit, clears on empty string');

  v.lock();
  assert.strictEqual(v.isUnlocked, false);
  assert.throws(() => v.listEntries(), (e) => e.code === 'LOCKED');
  log('lock clears state and blocks access');

  await assert.rejects(() => v.unlock('wrong password!!'), (e) => e.code === 'BAD_PASSWORD');
  log('wrong master password rejected');

  t = Date.now();
  await v.unlock('correct horse battery');
  log(`unlocked in ${Date.now() - t}ms`);
  assert.strictEqual(v.listEntries().length, 3);
  assert.strictEqual(v.listEntries().find((e) => e.name === 'Gmail (work)').notes, 'kept');
  log('data survived the lock/unlock round trip');

  // A single flipped ciphertext byte must fail the GCM tag rather than load.
  const env = JSON.parse(fs.readFileSync(v.file, 'utf8'));
  const bytes = Buffer.from(env.data, 'base64');
  bytes[5] ^= 0xff;
  env.data = bytes.toString('base64');
  const tamperedPath = path.join(dir, 'tampered.onekey');
  fs.writeFileSync(tamperedPath, JSON.stringify(env));
  const v2 = new Vault(dir);
  v2.file = tamperedPath;
  await assert.rejects(() => v2.unlock('correct horse battery'), (e) => e.code === 'BAD_PASSWORD');
  fs.unlinkSync(tamperedPath);
  log('flipped ciphertext byte is rejected (GCM auth tag)');

  await assert.rejects(
    () => v.changeMasterPassword('nope nope nope', 'brand new master pw'),
    (e) => e.code === 'BAD_PASSWORD'
  );
  await v.changeMasterPassword('correct horse battery', 'brand new master pw');
  v.lock();
  await assert.rejects(() => v.unlock('correct horse battery'), (e) => e.code === 'BAD_PASSWORD');
  await v.unlock('brand new master pw');
  assert.strictEqual(v.listEntries().length, 3);
  log('master password rotation re-encrypts the whole vault');

  await v.deleteEntry(a.id);
  assert.strictEqual(v.listEntries().length, 2);
  await assert.rejects(() => v.deleteEntry(a.id), (e) => e.code === 'NOT_FOUND');
  log('delete works and a stale id fails cleanly');

  // --------------------------------------------------------------- bulk ops

  const bulkStart = v.listEntries().length;
  const bulk = [];
  for (let i = 0; i < 5; i++) {
    bulk.push(await v.addEntry({ name: `Bulk ${i}`, username: 'u', password: 'p' }));
  }
  assert.strictEqual(v.listEntries().length, bulkStart + 5);

  // One id in the batch is already gone — the rest must still go through
  // rather than the whole call failing because of one stale id.
  const staleId = 'not-a-real-id';
  const delResult = await v.deleteEntries([bulk[0].id, bulk[1].id, staleId]);
  assert.strictEqual(delResult.deleted, 2, 'a stale id in the batch must not block the real deletes');
  assert.strictEqual(v.listEntries().length, bulkStart + 3);
  assert.ok(!v.listEntries().some((e) => e.id === bulk[0].id || e.id === bulk[1].id));
  log('deleteEntries removes exactly the requested ids and tolerates a stale one');

  // Deleting nothing (empty selection, or a batch that matches nothing left)
  // must not touch the file — nothing to persist, nothing to break.
  const noopDelete = await v.deleteEntries([staleId]);
  assert.strictEqual(noopDelete.deleted, 0);
  log('deleteEntries is a safe no-op when nothing in the batch exists');

  const moveIds = [bulk[2].id, bulk[3].id];
  const moveResult = await v.moveEntriesToFolder(moveIds, 'Archive');
  assert.strictEqual(moveResult.moved, 2);
  assert.ok(
    v.listEntries().filter((e) => moveIds.includes(e.id)).every((e) => e.folder === 'Archive'),
    'both moved entries should carry the new folder'
  );
  assert.notStrictEqual(
    v.listEntries().find((e) => e.id === bulk[4].id).folder,
    'Archive',
    'an entry outside the selection must be untouched'
  );
  log('moveEntriesToFolder moves exactly the requested ids');

  // Moving into the folder an entry is already in should count as nothing
  // moved, and must not bump updatedAt or write the file needlessly.
  const beforeUpdatedAt = v.listEntries().find((e) => e.id === bulk[2].id).updatedAt;
  const reMove = await v.moveEntriesToFolder(moveIds, 'Archive');
  assert.strictEqual(reMove.moved, 0, 'moving into the folder an entry is already in should be a no-op');
  assert.strictEqual(v.listEntries().find((e) => e.id === bulk[2].id).updatedAt, beforeUpdatedAt);
  log('moveEntriesToFolder is a true no-op when nothing would actually change');

  // Bulk changes are real writes, not just in-memory — confirm via a reload.
  // The master password was rotated earlier in this file, so it has to be
  // re-unlocked with 'brand new master pw', not the original.
  await v.deleteEntries(bulk.map((e) => e.id));
  v.lock();
  await v.unlock('brand new master pw');
  assert.strictEqual(v.listEntries().length, bulkStart);
  log('bulk delete and move both survive a lock/unlock — genuinely persisted');

  await v.updateSettings({ autoLockMinutes: 999 });
  assert.strictEqual(v.getSettings().autoLockMinutes, 120, 'clamped to 120');
  await v.updateSettings({ autoLockMinutes: 15 });
  assert.strictEqual(v.getSettings().autoLockMinutes, 15);
  log('settings persist and clamp');

  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const pw = generatePassword({ length: 20 });
    assert.strictEqual(pw.length, 20);
    assert.ok(
      /[a-z]/.test(pw) && /[A-Z]/.test(pw) && /[0-9]/.test(pw) && /[^A-Za-z0-9]/.test(pw),
      `missing character class: ${pw}`
    );
    seen.add(pw);
  }
  assert.strictEqual(seen.size, 200, 'generator must not repeat');
  assert.ok(!/[Il1O0o]/.test(generatePassword({ length: 40, avoidAmbiguous: true })));
  assert.ok(/^\d{12}$/.test(generatePassword({ length: 12, upper: false, lower: false, symbols: false })));
  log('generator: all classes present, unique across 200 draws, honours options');

  for (const [pw, expected] of [
    ['password', 0],
    ['12345678', 0],
    ['qwerty123', 0],
    ['Summer2024', 0],
    ['aaaaaaaaaaaa', 0],
  ]) {
    assert.strictEqual(strength.estimate(pw).score, expected, `${pw} should score ${expected}`);
  }
  assert.strictEqual(strength.estimate(generatePassword({ length: 20 })).score, 4);
  log('strength estimator flags the usual weak shapes and passes generated ones');

  const files = fs.readdirSync(dir);
  assert.ok(files.includes('vault.onekey') && files.includes('vault.onekey.bak'));
  assert.ok(!files.some((f) => f.endsWith('.tmp')), 'temp file should have been renamed away');
  log('on-disk files:', files.join(', '));

  // Regression test: the renderer (editing in the app) and the Chrome-extension
  // bridge both call into the same Vault instance, so overlapping writes are a
  // real scenario, not a contrived one. Before _persist() queued writes, two
  // saves landing close together could interleave on the shared tmp file and
  // whichever rename() finished second would silently win, discarding the
  // other save. Firing many concurrent addEntry calls without awaiting between
  // them reproduces exactly that interleaving.
  const concurrent = await Promise.all(
    Array.from({ length: 25 }, (_, i) =>
      v.addEntry({ name: `Concurrent ${i}`, username: 'u', password: `p${i}` })
    )
  );
  assert.strictEqual(concurrent.length, 25);
  assert.strictEqual(
    v.listEntries().filter((e) => e.name.startsWith('Concurrent ')).length,
    25,
    'all 25 concurrent entries must be present in memory'
  );

  // The real assertion: reload straight from disk, bypassing the in-memory
  // this._payload entirely, so a write that silently lost the race would show
  // up here even though the in-memory check above already passed. The master
  // password was rotated earlier in this file (changeMasterPassword), so it
  // has to be re-unlocked with 'brand new master pw', not the original.
  v.lock();
  await v.unlock('brand new master pw');
  assert.strictEqual(
    v.listEntries().filter((e) => e.name.startsWith('Concurrent ')).length,
    25,
    'all 25 concurrent entries must survive to disk — none silently lost to a write race'
  );
  log('25 concurrent addEntry calls all persisted — no write-race data loss');

  console.log('\nAll tests passed.');
  fs.rmSync(dir, { recursive: true, force: true });
})().catch((err) => {
  console.error('\nFAILED:', err);
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(1);
});
