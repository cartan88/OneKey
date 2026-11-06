'use strict';

/**
 * One-off: generates the RSA key that pins the extension's ID.
 *
 * Chrome derives an unpacked extension's ID from its absolute path unless the
 * manifest carries a `key` field. Pinning it matters here because the native
 * messaging host manifest has to whitelist that exact ID — without pinning, the
 * bridge would break the moment the extension folder moved.
 *
 * Only the PUBLIC key is needed (and committed). The private key is discarded;
 * it would only be required to sign a .crx for Web Store distribution.
 *
 *   node tools/make-extension-key.js
 */

const crypto = require('crypto');

const { publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const der = publicKey.export({ type: 'spki', format: 'der' });

// Chrome's ID: first 16 bytes of SHA-256 over the DER public key, each nibble
// mapped from 0-f into a-p.
const digest = crypto.createHash('sha256').update(der).digest();
const id = [...digest.subarray(0, 16)]
  .map((b) => b.toString(16).padStart(2, '0'))
  .join('')
  .split('')
  .map((c) => String.fromCharCode(parseInt(c, 16) + 97))
  .join('');

console.log('manifest "key":\n' + der.toString('base64') + '\n');
console.log('extension id:\n' + id);
