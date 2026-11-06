'use strict';

/**
 * Vault store for One Key.
 *
 * Owns the decrypted entries and the derived key while unlocked. Nothing here
 * is exposed to the renderer directly — main.js mediates every access over IPC
 * and strips passwords out of list responses.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const {
  KDF,
  deriveKey,
  newSalt,
  encryptPayload,
  decryptPayload,
  kdfFromEnvelope,
  wipe,
} = require('./crypto');
// Lives under renderer/ because the same file is loaded by the UI for its live
// strength meter; keeping one copy avoids the two sides ever disagreeing.
const strength = require('./renderer/strength');
const { hostOf, entryMatchesUrl, nameFromUrl } = require('./match');
const { planImport } = require('./portability');
const { AppError } = require('./errors');

const CURRENT_PAYLOAD_VERSION = 1;

/** A vault failure the user is meant to see. See src/errors.js. */
class VaultError extends AppError {
  constructor(code, message) {
    super(code, message);
    this.name = 'VaultError';
  }
}

class Vault {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'vault.onekey');
    this.backupFile = path.join(dir, 'vault.onekey.bak');

    this._key = null; // Buffer while unlocked, null while locked
    this._salt = null;
    this._kdf = KDF;
    this._payload = null; // { version, entries: [], settings: {} }

    // Every write chains onto this so concurrent callers (the renderer and the
    // Chrome-extension bridge) never race on the same file. See _persist().
    this._writeQueue = Promise.resolve();
  }

  get isUnlocked() {
    return this._key !== null;
  }

  exists() {
    return fs.existsSync(this.file);
  }

  // ---------------------------------------------------------------- lifecycle

  async create(masterPassword) {
    if (this.exists()) {
      throw new VaultError('EXISTS', 'A vault already exists on this machine.');
    }
    if (!masterPassword || masterPassword.length < 8) {
      throw new VaultError(
        'WEAK_MASTER',
        'Your master password must be at least 8 characters.'
      );
    }

    await fsp.mkdir(this.dir, { recursive: true });

    this._salt = newSalt();
    this._kdf = KDF;
    this._key = await deriveKey(masterPassword, this._salt, this._kdf);
    this._payload = {
      version: CURRENT_PAYLOAD_VERSION,
      createdAt: new Date().toISOString(),
      settings: { autoLockMinutes: 5, browserIntegration: true },
      entries: [],
    };

    await this._persist();
  }

  async unlock(masterPassword) {
    if (!this.exists()) {
      throw new VaultError('NO_VAULT', 'No vault found. Create one first.');
    }

    const envelope = await this._readEnvelope();
    const params = kdfFromEnvelope(envelope);
    const salt = Buffer.from(envelope.kdf.salt, 'base64');
    const key = await deriveKey(masterPassword, salt, params);

    let payload;
    try {
      payload = decryptPayload(envelope, key);
    } catch {
      wipe(key);
      throw new VaultError('BAD_PASSWORD', 'Incorrect master password.');
    }

    this._key = key;
    this._salt = salt;
    this._kdf = params;
    this._payload = this._normalize(payload);
  }

  lock() {
    wipe(this._key);
    this._key = null;
    this._payload = null;
    this._salt = null;
  }

  async changeMasterPassword(currentPassword, newPassword) {
    this._assertUnlocked();
    if (!newPassword || newPassword.length < 8) {
      throw new VaultError(
        'WEAK_MASTER',
        'Your new master password must be at least 8 characters.'
      );
    }

    // Re-derive from the on-disk salt to confirm the current password, rather
    // than trusting the caller.
    const envelope = await this._readEnvelope();
    const check = await deriveKey(
      currentPassword,
      Buffer.from(envelope.kdf.salt, 'base64'),
      kdfFromEnvelope(envelope)
    );
    let ok = false;
    try {
      decryptPayload(envelope, check);
      ok = true;
    } catch {
      ok = false;
    } finally {
      wipe(check);
    }
    if (!ok) throw new VaultError('BAD_PASSWORD', 'Current master password is incorrect.');

    const oldKey = this._key;
    this._salt = newSalt();
    this._kdf = KDF;
    this._key = await deriveKey(newPassword, this._salt, this._kdf);
    wipe(oldKey);

    await this._persist();
  }

  // ------------------------------------------------------------------ entries

  /**
   * Entries with passwords removed — safe to hand to the renderer. Each carries
   * a strength score and a reuse flag so the UI can show vault health without
   * ever seeing the secrets themselves.
   */
  listEntries() {
    this._assertUnlocked();

    const counts = new Map();
    for (const e of this._payload.entries) {
      if (e.password) counts.set(e.password, (counts.get(e.password) || 0) + 1);
    }

    return this._payload.entries
      .map((e) => {
        const item = this._redact(e);
        const est = strength.estimate(e.password);
        item.strength = { score: est.score, label: est.label };
        item.reused = Boolean(e.password) && counts.get(e.password) > 1;
        return item;
      })
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  }

  revealPassword(id) {
    this._assertUnlocked();
    const entry = this._find(id);
    return entry.password || '';
  }

  async addEntry(input) {
    this._assertUnlocked();
    const now = new Date().toISOString();
    const entry = {
      id: crypto.randomUUID(),
      name: (input.name || '').trim() || 'Untitled',
      username: (input.username || '').trim(),
      password: input.password || '',
      url: (input.url || '').trim(),
      notes: input.notes || '',
      folder: (input.folder || '').trim(),
      favorite: Boolean(input.favorite),
      createdAt: now,
      updatedAt: now,
      passwordUpdatedAt: now,
    };
    this._payload.entries.push(entry);
    await this._persist();
    return this._redact(entry);
  }

  async updateEntry(id, patch) {
    this._assertUnlocked();
    const entry = this._find(id);

    if (patch.name !== undefined) entry.name = String(patch.name).trim() || 'Untitled';
    if (patch.username !== undefined) entry.username = String(patch.username).trim();
    if (patch.url !== undefined) entry.url = String(patch.url).trim();
    if (patch.notes !== undefined) entry.notes = String(patch.notes);
    if (patch.folder !== undefined) entry.folder = String(patch.folder).trim();
    if (patch.favorite !== undefined) entry.favorite = Boolean(patch.favorite);

    // Omitting `password` leaves it untouched; sending an empty string clears
    // it, which is a legitimate edit.
    if (patch.password !== undefined) {
      const next = String(patch.password);
      if (next !== entry.password) {
        entry.passwordUpdatedAt = new Date().toISOString();
      }
      entry.password = next;
    }

    entry.updatedAt = new Date().toISOString();
    await this._persist();
    return this._redact(entry);
  }

  async deleteEntry(id) {
    this._assertUnlocked();
    const i = this._payload.entries.findIndex((e) => e.id === id);
    if (i === -1) throw new VaultError('NOT_FOUND', 'That entry no longer exists.');
    this._payload.entries.splice(i, 1);
    await this._persist();
  }

  /**
   * Delete several entries as one operation.
   *
   * One persist for the whole batch rather than one per id — the same reason
   * importEntries() batches — so selecting 200 items and deleting them writes
   * the vault once, not 200 times. Ids that no longer exist are skipped rather
   * than failing the whole batch: the selection was built from a snapshot the
   * renderer already had, and something else deleting one of those entries in
   * the meantime shouldn't block deleting the rest.
   */
  async deleteEntries(ids) {
    this._assertUnlocked();
    const wanted = new Set(ids);
    const before = this._payload.entries.length;
    this._payload.entries = this._payload.entries.filter((e) => !wanted.has(e.id));
    const deleted = before - this._payload.entries.length;
    if (deleted > 0) await this._persist();
    return { deleted };
  }

  /**
   * Move several entries into a folder as one operation. An empty string clears
   * the folder, same as the single-item editor.
   */
  async moveEntriesToFolder(ids, folder) {
    this._assertUnlocked();
    const wanted = new Set(ids);
    const target = String(folder || '').trim();
    const now = new Date().toISOString();

    let moved = 0;
    for (const entry of this._payload.entries) {
      if (!wanted.has(entry.id) || entry.folder === target) continue;
      entry.folder = target;
      entry.updatedAt = now;
      moved++;
    }

    if (moved > 0) await this._persist();
    return { moved };
  }

  // ------------------------------------------------------------------ browser

  /**
   * Entries that belong to a page, without passwords. This is the only way the
   * browser side can discover entry ids, which is what keeps `credentialFor`
   * from being usable as a way to enumerate the vault.
   */
  matchEntriesForUrl(pageUrl) {
    this._assertUnlocked();
    if (!hostOf(pageUrl)) return [];
    return this._payload.entries
      .filter((e) => e.password && entryMatchesUrl(e.url, pageUrl))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
      .map((e) => ({ id: e.id, name: e.name, username: e.username }));
  }

  /**
   * The credential for one entry, but only if that entry really does belong to
   * the page asking for it — re-checked here rather than trusted from the caller.
   */
  credentialFor(id, pageUrl) {
    this._assertUnlocked();
    const entry = this._find(id);
    if (!entryMatchesUrl(entry.url, pageUrl)) {
      throw new VaultError('ORIGIN_MISMATCH', 'That login is not for this website.');
    }
    return { username: entry.username, password: entry.password, name: entry.name };
  }

  /**
   * Decide what a submitted login means without changing anything:
   * already stored, a password change, or something new.
   */
  classifySave({ url, username, password }) {
    this._assertUnlocked();
    if (!password) throw new VaultError('NO_PASSWORD', 'No password to save.');
    if (!hostOf(url)) throw new VaultError('BAD_URL', 'That page has no usable web address.');

    const existing = this._sameLogin(url, username);
    if (existing) {
      return existing.password === password
        ? { action: 'known', name: existing.name }
        : { action: 'update', name: existing.name };
    }
    return { action: 'new', name: nameFromUrl(url) };
  }

  /**
   * Apply a save from the browser.
   *
   * An existing entry's password is only replaced when the host AND username
   * match exactly — an unambiguous "same login, new password". Anything else
   * becomes a new entry, so a browser-side mistake can never quietly overwrite
   * a different credential.
   */
  async applySave({ url, username, password, name }) {
    this._assertUnlocked();
    const { action } = this.classifySave({ url, username, password });

    if (action === 'known') {
      const entry = this._sameLogin(url, username);
      return { action: 'known', entry: this._redact(entry) };
    }

    if (action === 'update') {
      const entry = this._sameLogin(url, username);
      entry.password = password;
      entry.passwordUpdatedAt = new Date().toISOString();
      entry.updatedAt = entry.passwordUpdatedAt;
      await this._persist();
      return { action: 'updated', entry: this._redact(entry) };
    }

    const created = await this.addEntry({
      name: (name || '').trim() || nameFromUrl(url),
      username,
      password,
      url: this._originOf(url),
    });
    return { action: 'created', entry: created };
  }

  /** The entry for this exact host + username pair, if there is one. */
  _sameLogin(url, username) {
    const wanted = String(username || '').trim().toLowerCase();
    return this._payload.entries.find(
      (e) =>
        entryMatchesUrl(e.url, url) && String(e.username || '').trim().toLowerCase() === wanted
    );
  }

  /** Store the origin rather than the full submitted URL — no paths or queries. */
  _originOf(rawUrl) {
    try {
      const url = new URL(rawUrl);
      return `${url.protocol}//${url.host}`;
    } catch {
      return rawUrl;
    }
  }

  // ------------------------------------------------------ import and export

  /**
   * Every login in portable form, passwords included — that is the point of an
   * export. Internal bookkeeping (ids, timestamps) is left out so the result is
   * meaningful to other password managers.
   */
  exportEntries() {
    this._assertUnlocked();
    return this._payload.entries
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
      .map((e) => ({
        name: e.name,
        url: e.url,
        username: e.username,
        password: e.password,
        folder: e.folder,
        notes: e.notes,
      }));
  }

  /**
   * Add imported logins.
   *
   * Only ever adds: an incoming row identical to one already stored is skipped,
   * and anything else becomes a new entry. Nothing is overwritten, because a
   * duplicate can be deleted afterwards while an overwritten password is gone
   * for good.
   */
  async importEntries(incoming) {
    this._assertUnlocked();
    if (!Array.isArray(incoming)) {
      throw new VaultError('BAD_IMPORT', 'That file contained no importable logins.');
    }

    const { toAdd, duplicates } = planImport(incoming, this._payload.entries);
    const now = new Date().toISOString();

    for (const item of toAdd) {
      this._payload.entries.push({
        id: crypto.randomUUID(),
        name: String(item.name || '').trim() || 'Untitled',
        username: String(item.username || '').trim(),
        password: String(item.password || ''),
        url: String(item.url || '').trim(),
        notes: String(item.notes || ''),
        folder: String(item.folder || '').trim(),
        favorite: Boolean(item.favorite),
        createdAt: now,
        updatedAt: now,
        passwordUpdatedAt: now,
      });
    }

    // One write for the whole import, not one per row.
    if (toAdd.length) await this._persist();
    return { added: toAdd.length, duplicates };
  }

  // ----------------------------------------------------------------- settings

  getSettings() {
    this._assertUnlocked();
    return { ...this._payload.settings };
  }

  async updateSettings(patch) {
    this._assertUnlocked();
    if (patch.autoLockMinutes !== undefined) {
      const n = Number(patch.autoLockMinutes);
      // 0 means "never auto-lock".
      this._payload.settings.autoLockMinutes = Number.isFinite(n)
        ? Math.max(0, Math.min(120, Math.round(n)))
        : 5;
    }
    if (patch.browserIntegration !== undefined) {
      this._payload.settings.browserIntegration = Boolean(patch.browserIntegration);
    }
    await this._persist();
    return this.getSettings();
  }

  // -------------------------------------------------------------- persistence

  async _readEnvelope() {
    let raw;
    try {
      raw = await fsp.readFile(this.file, 'utf8');
    } catch (err) {
      throw new VaultError('READ_FAILED', `Could not read the vault file: ${err.message}`);
    }
    let envelope;
    try {
      envelope = JSON.parse(raw);
    } catch {
      throw new VaultError('CORRUPT', 'The vault file is not valid — it may be corrupted.');
    }
    if (envelope.format !== 'onekey-vault' || !envelope.kdf || !envelope.data) {
      throw new VaultError('CORRUPT', 'The vault file is not a One Key vault.');
    }
    return envelope;
  }

  /**
   * Queue a write behind any already in flight.
   *
   * The renderer (editing in the app) and the Chrome-extension bridge (autofill
   * capture-and-save) both call into this same Vault instance independently, so
   * two saves can genuinely overlap in time. Every write targets the same fixed
   * `${this.file}.tmp` path; without serializing them, two concurrent writers
   * could open/truncate/rename that path interleaved, and whichever `rename()`
   * lands second wins — silently discarding the other save.
   *
   * Chaining onto `_writeQueue` makes writes run strictly one at a time, in the
   * order they were requested. Each write still reads `this._payload` at the
   * moment it actually runs rather than when it was queued, which is what makes
   * this safe rather than merely serialized: because entries are mutated
   * in-place on that shared object before `_persist()` is ever called, every
   * queued write already sees every mutation that happened before its turn.
   *
   * A failed write must not wedge the queue for whoever writes next, so the
   * continuation stored back onto `_writeQueue` swallows the error; the
   * rejection itself is still delivered to the caller that triggered it, via
   * the returned promise.
   */
  _persist() {
    const previous = this._writeQueue;
    const run = previous.catch(() => {}).then(() => this._persistNow());
    this._writeQueue = run.catch(() => {});
    return run;
  }

  /**
   * Write the vault atomically: temp file -> fsync -> keep a backup of the
   * previous good file -> rename into place. A crash mid-write can therefore
   * never leave a half-written vault.
   */
  async _persistNow() {
    this._assertUnlocked();
    const envelope = encryptPayload(this._payload, this._key, this._salt, this._kdf);
    const json = JSON.stringify(envelope, null, 2);
    const tmp = `${this.file}.tmp`;

    const handle = await fsp.open(tmp, 'w');
    try {
      await handle.writeFile(json, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }

    if (fs.existsSync(this.file)) {
      await fsp.copyFile(this.file, this.backupFile);
    }
    await fsp.rename(tmp, this.file);
  }

  // ------------------------------------------------------------------ helpers

  _assertUnlocked() {
    if (!this.isUnlocked) throw new VaultError('LOCKED', 'The vault is locked.');
  }

  _find(id) {
    const entry = this._payload.entries.find((e) => e.id === id);
    if (!entry) throw new VaultError('NOT_FOUND', 'That entry no longer exists.');
    return entry;
  }

  _redact(entry) {
    const { password, ...rest } = entry;
    return { ...rest, hasPassword: Boolean(password), passwordLength: password ? password.length : 0 };
  }

  /** Fill in anything an older payload version might be missing. */
  _normalize(payload) {
    const out = {
      version: CURRENT_PAYLOAD_VERSION,
      createdAt: payload.createdAt || new Date().toISOString(),
      settings: { autoLockMinutes: 5, browserIntegration: true, ...(payload.settings || {}) },
      entries: Array.isArray(payload.entries) ? payload.entries : [],
    };
    out.entries = out.entries.map((e) => ({
      id: e.id || crypto.randomUUID(),
      name: e.name || 'Untitled',
      username: e.username || '',
      password: e.password || '',
      url: e.url || '',
      notes: e.notes || '',
      folder: e.folder || '',
      favorite: Boolean(e.favorite),
      createdAt: e.createdAt || out.createdAt,
      updatedAt: e.updatedAt || e.createdAt || out.createdAt,
      passwordUpdatedAt: e.passwordUpdatedAt || e.updatedAt || out.createdAt,
    }));
    return out;
  }
}

module.exports = { Vault, VaultError };
