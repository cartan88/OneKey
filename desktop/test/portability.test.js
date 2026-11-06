'use strict';

/**
 * Tests for import/export: encrypted backups, the merge rules, and that no
 * plaintext credential handling exists in either direction.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const assert = require('assert');

const { Vault } = require('../src/vault.js');
const p = require('../src/portability.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onekey-port-'));
const log = (...a) => console.log('  ok', ...a);

(async () => {
  // ------------------------------------------------------- no plaintext at all
  //
  // One Key handles exactly one format: its own encrypted backup. Nothing here
  // reads or writes plaintext credentials, in either direction.

  for (const gone of ['toCsv', 'CSV_COLUMNS', 'parseCsv', 'entriesFromCsv']) {
    assert.ok(!(gone in p), `${gone} must not exist — no plaintext handling remains`);
  }
  assert.deepStrictEqual(
    Object.keys(p).sort(),
    ['BACKUP_FORMAT', 'fingerprint', 'makeBackup', 'planImport', 'readBackup'],
    'the module surface should be backups and merge rules only'
  );
  log('no plaintext CSV handling remains: not written, not read');

  // ---------------------------------------------------------------- backups

  // Distinctive markers: short strings like "pa" turn up in base64 ciphertext by
  // chance, which would make the leak check below meaningless.
  const SECRET = 'PLAINTEXT-MARKER-Zq7x-secret';
  const USER = 'PLAINTEXT-MARKER-user@example.test';
  const entries = [
    { name: 'A', url: 'https://a.test', username: USER, password: SECRET, folder: '', notes: '' },
    { name: 'B', url: 'https://b.test', username: 'ub', password: 'pb', folder: 'Work', notes: 'n' },
  ];

  await assert.rejects(() => p.makeBackup(entries, 'short'), (e) => e.code === 'WEAK_PASSWORD');
  log('a backup password under 8 characters is refused');

  const envelope = await p.makeBackup(entries, 'backup password', '2026-08-11T00:00:00.000Z');
  assert.strictEqual(envelope.format, 'onekey-backup');
  const asText = JSON.stringify(envelope);
  assert.ok(
    !asText.includes(SECRET) && !asText.includes(USER) && !asText.includes('a.test'),
    'the backup must not leak plaintext'
  );
  log('backup envelope is encrypted, with no plaintext anywhere in the file');

  await assert.rejects(() => p.readBackup(envelope, 'wrong password'), (e) => e.code === 'BAD_PASSWORD');
  log('a wrong backup password is refused');

  const restored = await p.readBackup(envelope, 'backup password');
  assert.deepStrictEqual(restored.entries, entries);
  assert.strictEqual(restored.exportedAt, '2026-08-11T00:00:00.000Z');
  log('backup restores byte-identical entries');

  // A vault file must not be accepted as a backup, or vice versa.
  const v = new Vault(dir);
  await v.create('a master password for tests');
  await v.addEntry({ name: 'In vault', url: 'https://v.test', username: 'u', password: 'p' });
  const vaultFile = JSON.parse(fs.readFileSync(v.file, 'utf8'));
  await assert.rejects(
    () => p.readBackup(vaultFile, 'a master password for tests'),
    (e) => e.code === 'NOT_BACKUP'
  );
  log('a vault file is not mistaken for a backup');

  // Tampering with a backup must fail the auth tag, not load partial data.
  const tampered = JSON.parse(JSON.stringify(envelope));
  const bytes = Buffer.from(tampered.data, 'base64');
  bytes[3] ^= 0xff;
  tampered.data = bytes.toString('base64');
  await assert.rejects(() => p.readBackup(tampered, 'backup password'), (e) => e.code === 'BAD_PASSWORD');
  log('a modified backup is rejected (GCM auth tag)');

  // ------------------------------------------------------------------ merge

  const existing = [
    { name: 'A', url: 'https://a.test', username: 'ua', password: 'pa' },
    { name: 'B', url: 'https://b.test', username: 'ub', password: 'pb' },
  ];

  // Exact repeats are skipped.
  let plan = p.planImport(existing, existing);
  assert.strictEqual(plan.toAdd.length, 0);
  assert.strictEqual(plan.duplicates, 2);
  log('importing the same data twice adds nothing');

  // www. and subdomain-equal hosts count as the same site.
  plan = p.planImport([{ name: 'A2', url: 'https://www.a.test', username: 'UA', password: 'pa' }], existing);
  assert.strictEqual(plan.toAdd.length, 0, 'www. and case differences are still the same login');
  log('duplicate detection ignores www. and username case');

  // A changed password is NOT a duplicate, and must not overwrite.
  plan = p.planImport([{ name: 'A', url: 'https://a.test', username: 'ua', password: 'CHANGED' }], existing);
  assert.strictEqual(plan.toAdd.length, 1);
  assert.strictEqual(plan.duplicates, 0);
  log('a changed password imports as a new entry rather than overwriting');

  // Repeats inside one file are collapsed too.
  plan = p.planImport(
    [
      { name: 'C', url: 'https://c.test', username: 'uc', password: 'pc' },
      { name: 'C again', url: 'https://c.test', username: 'uc', password: 'pc' },
    ],
    existing
  );
  assert.strictEqual(plan.toAdd.length, 1);
  assert.strictEqual(plan.duplicates, 1);
  log('duplicates within a single file are collapsed');

  // ------------------------------------------------- vault-level integration

  const before = v.listEntries().length;
  const result = await v.importEntries([
    { name: 'Imported', url: 'https://imported.test', username: 'iu', password: 'ip' },
    { name: 'In vault', url: 'https://v.test', username: 'u', password: 'p' }, // already there
  ]);
  assert.strictEqual(result.added, 1);
  assert.strictEqual(result.duplicates, 1);
  assert.strictEqual(v.listEntries().length, before + 1);

  const imported = v.listEntries().find((e) => e.name === 'Imported');
  assert.strictEqual(v.revealPassword(imported.id), 'ip');
  log('vault.importEntries adds new logins, skips duplicates, and persists');

  // Survives a lock/unlock, i.e. it really was written to disk.
  v.lock();
  await v.unlock('a master password for tests');
  assert.strictEqual(v.listEntries().length, before + 1);
  log('imported entries survive a lock and unlock');

  const exported = v.exportEntries();
  assert.strictEqual(exported.length, before + 1);
  assert.ok(
    exported.every((e) => typeof e.password === 'string'),
    'export must include passwords — that is the point of it'
  );
  assert.ok(
    exported.every((e) => !('id' in e) && !('createdAt' in e)),
    'export should carry the login itself, not internal bookkeeping'
  );
  log('vault.exportEntries returns portable rows with passwords');

  console.log('\nAll import/export tests passed.');
  fs.rmSync(dir, { recursive: true, force: true });
})().catch((err) => {
  console.error('\nFAILED:', err);
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(1);
});
