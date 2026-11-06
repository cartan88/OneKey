'use strict';

/**
 * Crypto primitives for One Key.
 *
 * Vault format (JSON on disk):
 *   {
 *     format:  "onekey-vault",
 *     version: 1,
 *     kdf:     { name: "scrypt", N, r, p, keylen, salt: <base64> },
 *     cipher:  "aes-256-gcm",
 *     iv:      <base64>,
 *     tag:     <base64>,
 *     data:    <base64>          // encrypted UTF-8 JSON payload
 *   }
 *
 * The payload is only ever decrypted in the main process, and the derived key
 * is held in a Buffer that gets zeroed on lock.
 */

const crypto = require('crypto');
const { AppError } = require('./errors');

// scrypt parameters. N=2^17 with r=8 needs ~128 MiB of scratch memory, which is
// a deliberate brute-force cost. maxmem must be raised past Node's 32 MiB default.
const KDF = Object.freeze({
  name: 'scrypt',
  N: 1 << 17,
  r: 8,
  p: 1,
  keylen: 32,
});

const SALT_BYTES = 32;
const IV_BYTES = 12; // 96-bit nonce, the recommended size for GCM
const CIPHER = 'aes-256-gcm';

function scryptMaxmem(params) {
  // Node requires maxmem > 128 * N * r; give it headroom.
  return 256 * params.N * params.r;
}

/** Derive a 32-byte key from a master password + salt. */
function deriveKey(password, salt, params = KDF) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      Buffer.from(password, 'utf8'),
      salt,
      params.keylen,
      { N: params.N, r: params.r, p: params.p, maxmem: scryptMaxmem(params) },
      (err, key) => (err ? reject(err) : resolve(key))
    );
  });
}

function newSalt() {
  return crypto.randomBytes(SALT_BYTES);
}

/** Encrypt a JS object into an on-disk vault envelope. */
function encryptPayload(payload, key, salt, params = KDF) {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(CIPHER, key, iv);
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
  const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  plaintext.fill(0);

  return {
    format: 'onekey-vault',
    version: 1,
    kdf: {
      name: params.name,
      N: params.N,
      r: params.r,
      p: params.p,
      keylen: params.keylen,
      salt: salt.toString('base64'),
    },
    cipher: CIPHER,
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: data.toString('base64'),
  };
}

/**
 * Decrypt a vault envelope. Throws if the key is wrong or the file was
 * tampered with — GCM's auth tag makes those the same failure.
 */
function decryptPayload(envelope, key) {
  const decipher = crypto.createDecipheriv(
    envelope.cipher || CIPHER,
    key,
    Buffer.from(envelope.iv, 'base64')
  );
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.data, 'base64')),
    decipher.final(),
  ]);
  const text = plaintext.toString('utf8');
  plaintext.fill(0);
  return JSON.parse(text);
}

// 2^21 caps scrypt scratch memory at 128 * 2^21 = 256 MiB. The default
// (N=2^17, r=8) is 2^20, i.e. 128 MiB.
const MAX_N_TIMES_R = 2 ** 21;

function decodedLength(value) {
  if (typeof value !== 'string') return -1;
  try {
    return Buffer.from(value, 'base64').length;
  } catch {
    return -1;
  }
}

/**
 * What is structurally wrong with an envelope, or null if it is usable.
 *
 * Checked before any key derivation so a damaged or hand-edited file is
 * reported as damaged rather than blamed on the password, and so a hostile
 * file cannot choose how much memory scrypt is allowed to use: scryptMaxmem()
 * raises Node's limit to whatever the parameters ask for, which makes the
 * parameters themselves the thing that has to be bounded.
 */
function envelopeProblem(envelope) {
  const k = envelope && envelope.kdf;
  if (!k || typeof k !== 'object') return 'its key-derivation settings are missing';
  if ((k.name || KDF.name) !== 'scrypt') return 'it uses an unsupported key derivation';

  const { N, r, p } = k;
  if (!Number.isInteger(N) || N < 2 || (N & (N - 1)) !== 0) return 'its key-derivation settings are invalid';
  if (!Number.isInteger(r) || r < 1 || !Number.isInteger(p) || p < 1 || p > 16) {
    return 'its key-derivation settings are invalid';
  }
  if (N * r > MAX_N_TIMES_R) return 'its key-derivation settings are too demanding for this computer';
  if ((k.keylen || KDF.keylen) !== KDF.keylen) return 'its key-derivation settings are invalid';

  if (decodedLength(k.salt) <= 0) return 'its salt is missing or unreadable';
  if (decodedLength(envelope.iv) !== IV_BYTES) return 'its nonce is missing or unreadable';
  if (decodedLength(envelope.tag) !== 16) return 'its authentication tag is missing or unreadable';
  if (decodedLength(envelope.data) < 0) return 'its encrypted contents are missing or unreadable';
  return null;
}

/** Throws a user-facing CORRUPT error if the envelope cannot safely be opened. */
function assertEnvelopeUsable(envelope) {
  const problem = envelopeProblem(envelope);
  if (problem) {
    throw new AppError('CORRUPT', `That file looks damaged or incomplete: ${problem}.`);
  }
}

/** Read the KDF parameters an existing vault was written with. */
function kdfFromEnvelope(envelope) {
  const k = envelope.kdf || {};
  return {
    name: k.name || KDF.name,
    N: k.N || KDF.N,
    r: k.r || KDF.r,
    p: k.p || KDF.p,
    keylen: k.keylen || KDF.keylen,
  };
}

const ALPHABETS = {
  lower: 'abcdefghijklmnopqrstuvwxyz',
  upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  digits: '0123456789',
  symbols: '!#$%&()*+,-./:;<=>?@[]^_{|}~',
  // Characters that are easy to misread when transcribing by hand.
  ambiguous: 'Il1O0o',
};

/** Uniform random index in [0, max) with no modulo bias. */
function randomIndex(max) {
  const limit = Math.floor(0xffffffff / max) * max;
  for (;;) {
    const n = crypto.randomBytes(4).readUInt32BE(0);
    if (n < limit) return n % max;
  }
}

/**
 * Generate a password with a cryptographically secure RNG. Guarantees at least
 * one character from each selected class, then shuffles so position is random.
 */
function generatePassword(opts = {}) {
  const {
    length = 20,
    lower = true,
    upper = true,
    digits = true,
    symbols = true,
    avoidAmbiguous = false,
  } = opts;

  const strip = (set) =>
    avoidAmbiguous
      ? [...set].filter((c) => !ALPHABETS.ambiguous.includes(c)).join('')
      : set;

  const classes = [];
  if (lower) classes.push(strip(ALPHABETS.lower));
  if (upper) classes.push(strip(ALPHABETS.upper));
  if (digits) classes.push(strip(ALPHABETS.digits));
  if (symbols) classes.push(strip(ALPHABETS.symbols));

  if (classes.length === 0) classes.push(strip(ALPHABETS.lower));

  const size = Math.max(4, Math.min(128, Math.floor(length)));
  const pool = classes.join('');
  const chars = [];

  // One guaranteed character per class (as long as there's room).
  for (const set of classes) {
    if (chars.length < size) chars.push(set[randomIndex(set.length)]);
  }
  while (chars.length < size) {
    chars.push(pool[randomIndex(pool.length)]);
  }

  // Fisher-Yates with unbiased indices.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomIndex(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }

  return chars.join('');
}

/** Overwrite a key buffer so it does not linger in memory after locking. */
function wipe(buf) {
  if (Buffer.isBuffer(buf)) buf.fill(0);
}

module.exports = {
  KDF,
  deriveKey,
  newSalt,
  encryptPayload,
  decryptPayload,
  kdfFromEnvelope,
  envelopeProblem,
  assertEnvelopeUsable,
  generatePassword,
  wipe,
};
