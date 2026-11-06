'use strict';

/**
 * Import and export for One Key.
 *
 * Exactly one file format, in both directions: an encrypted backup (.onekey), a
 * self-contained AES-256-GCM envelope under a password the user chooses.
 *
 * There is deliberately no plaintext support at all — not written, not read. A
 * file containing every password in readable form is the worst artifact this app
 * could touch, and once such a file exists it outlives the intention behind it:
 * it gets synced, backed up and indexed, and cannot be un-leaked. Refusing to
 * write one but happily reading one would still leave users producing plaintext
 * exports elsewhere and leaving them on disk, so both halves are gone.
 *
 * Everything here is pure: no file I/O, no Electron, no vault state. That keeps
 * the crypto and merge rules directly testable.
 */

const { encryptPayload, decryptPayload, deriveKey, newSalt, kdfFromEnvelope, wipe, KDF } =
  require('./crypto');
const { hostOf } = require('./match');
const { AppError } = require('./errors');

const BACKUP_FORMAT = 'onekey-backup';

// -------------------------------------------------------------------- backups

/** Build an encrypted backup envelope from entries, under `password`. */
async function makeBackup(entries, password, now) {
  if (!password || password.length < 8) {
    throw new AppError('WEAK_PASSWORD', 'The backup password must be at least 8 characters.');
  }

  const salt = newSalt();
  const key = await deriveKey(password, salt, KDF);
  try {
    const envelope = encryptPayload(
      { format: BACKUP_FORMAT, version: 1, exportedAt: now, entries },
      key,
      salt,
      KDF
    );
    // Mark the envelope itself so a backup can never be mistaken for a vault
    // file, and vice versa.
    envelope.format = BACKUP_FORMAT;
    return envelope;
  } finally {
    wipe(key);
  }
}

/** Read an encrypted backup envelope. Throws BAD_PASSWORD if the key is wrong. */
async function readBackup(envelope, password) {
  if (!envelope || envelope.format !== BACKUP_FORMAT || !envelope.kdf || !envelope.data) {
    throw new AppError('NOT_BACKUP', 'That file is not a One Key backup.');
  }

  const key = await deriveKey(
    password,
    Buffer.from(envelope.kdf.salt, 'base64'),
    kdfFromEnvelope(envelope)
  );
  try {
    const payload = decryptPayload(envelope, key);
    const entries = Array.isArray(payload.entries) ? payload.entries : [];
    return { entries, exportedAt: payload.exportedAt || null };
  } catch (err) {
    if (err instanceof AppError) throw err;
    // A wrong password and a tampered file are indistinguishable here: GCM's auth
    // tag fails either way. "Incorrect password" is the overwhelmingly likely
    // cause and the one the user can act on.
    throw new AppError('BAD_PASSWORD', 'Incorrect backup password.');
  } finally {
    wipe(key);
  }
}

// ---------------------------------------------------------------------- merge

/**
 * Identity of a login for duplicate detection: same site, user and secret.
 *
 * Joined with NUL rather than a space, because NUL cannot occur in a hostname or
 * username. With a printable separator, a username of "a b" with password "c"
 * and a username of "a" with password "b c" would hash to the same string and be
 * treated as duplicates.
 */
function fingerprint(entry) {
  return [
    hostOf(entry.url) || String(entry.url || '').trim().toLowerCase(),
    String(entry.username || '').trim().toLowerCase(),
    String(entry.password || ''),
  ].join('\u0000');
}

/**
 * Decide what to add.
 *
 * Imports only ever ADD. An incoming row that matches an existing entry exactly
 * is skipped; anything else becomes a new entry. Nothing is overwritten, because
 * a merge that silently replaced a password would be unrecoverable — and the
 * user can delete duplicates, but cannot un-overwrite a lost secret.
 */
function planImport(incoming, existing) {
  const seen = new Set(existing.map(fingerprint));
  const toAdd = [];
  let duplicates = 0;

  for (const entry of incoming) {
    const print = fingerprint(entry);
    if (seen.has(print)) {
      duplicates++;
      continue;
    }
    seen.add(print);
    toAdd.push(entry);
  }

  return { toAdd, duplicates };
}

module.exports = {
  BACKUP_FORMAT,
  makeBackup,
  readBackup,
  planImport,
  fingerprint,
};
