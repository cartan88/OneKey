package com.onekey.app.crypto

import org.bouncycastle.crypto.generators.SCrypt
import org.json.JSONObject
import java.nio.charset.StandardCharsets
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * Crypto primitives for One Key's vault/backup envelope.
 *
 * This must derive keys and encrypt/decrypt byte-for-byte the same way the
 * desktop app's Node `crypto.scrypt` + AES-256-GCM does (see src/crypto.js in
 * the desktop repo), so a `.onekey` backup exported from either side can be
 * read by the other. Envelope shape on disk:
 *
 *   {
 *     "format":  "onekey-backup" | "onekey-vault",
 *     "version": 1,
 *     "kdf":     { "name": "scrypt", "N", "r", "p", "keylen", "salt": <base64> },
 *     "cipher":  "aes-256-gcm",
 *     "iv":      <base64, 12 bytes>,
 *     "tag":     <base64, 16 bytes>,
 *     "data":    <base64 ciphertext, tag NOT included>
 *   }
 *
 * Node keeps the GCM auth tag separate from the ciphertext; Java's Cipher
 * appends it to the end of doFinal's output on encrypt and expects it there
 * on decrypt. The split/join between the two happens only in this file.
 */
object OneKeyCrypto {

    data class KdfParams(
        val name: String = "scrypt",
        val N: Int = 1 shl 17,
        val r: Int = 8,
        val p: Int = 1,
        val keylen: Int = 32,
    )

    val DEFAULT_KDF = KdfParams()

    private const val SALT_BYTES = 32
    private const val IV_BYTES = 12
    private const val GCM_TAG_BITS = 128

    // 2^21 caps scrypt scratch memory at 128 * 2^21 = 256 MiB; the default
    // (N=2^17, r=8) is 2^20, i.e. 128 MiB.
    private const val MAX_SCRYPT_N_TIMES_R = 1L shl 21
    private const val CIPHER_NAME = "aes-256-gcm"
    private const val TRANSFORM = "AES/GCM/NoPadding"

    private val secureRandom = SecureRandom()

    fun newSalt(): ByteArray {
        val salt = ByteArray(SALT_BYTES)
        secureRandom.nextBytes(salt)
        return salt
    }

    /** Derive a key from a master/backup password. Caller must [wipe] the result. */
    fun deriveKey(password: CharArray, salt: ByteArray, params: KdfParams = DEFAULT_KDF): ByteArray {
        val passwordBytes = String(password).toByteArray(StandardCharsets.UTF_8)
        try {
            return SCrypt.generate(passwordBytes, salt, params.N, params.r, params.p, params.keylen)
        } finally {
            wipe(passwordBytes)
        }
    }

    /** Encrypt a JSON payload into an on-disk envelope, tagged with [format]. */
    fun encryptPayload(payloadJson: String, key: ByteArray, salt: ByteArray, params: KdfParams, format: String): JSONObject {
        val iv = ByteArray(IV_BYTES).also { secureRandom.nextBytes(it) }
        val cipher = Cipher.getInstance(TRANSFORM)
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(GCM_TAG_BITS, iv))
        val plaintext = payloadJson.toByteArray(StandardCharsets.UTF_8)
        val ciphertextWithTag = try {
            cipher.doFinal(plaintext)
        } finally {
            wipe(plaintext)
        }
        val tagLen = GCM_TAG_BITS / 8
        val data = ciphertextWithTag.copyOfRange(0, ciphertextWithTag.size - tagLen)
        val tag = ciphertextWithTag.copyOfRange(ciphertextWithTag.size - tagLen, ciphertextWithTag.size)

        return JSONObject().apply {
            put("format", format)
            put("version", 1)
            put("kdf", JSONObject().apply {
                put("name", params.name)
                put("N", params.N)
                put("r", params.r)
                put("p", params.p)
                put("keylen", params.keylen)
                put("salt", b64(salt))
            })
            put("cipher", CIPHER_NAME)
            put("iv", b64(iv))
            put("tag", b64(tag))
            put("data", b64(data))
        }
    }

    /** Decrypt an envelope. Throws if the key is wrong or the file was tampered with. */
    fun decryptPayload(envelope: JSONObject, key: ByteArray): String {
        val iv = unb64(envelope.getString("iv"))
        val tag = unb64(envelope.getString("tag"))
        val data = unb64(envelope.getString("data"))
        val combined = data + tag

        val cipher = Cipher.getInstance(TRANSFORM)
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(GCM_TAG_BITS, iv))
        val plaintext = cipher.doFinal(combined)
        try {
            return String(plaintext, StandardCharsets.UTF_8)
        } finally {
            wipe(plaintext)
        }
    }

    fun kdfFromEnvelope(envelope: JSONObject): KdfParams {
        val k = envelope.optJSONObject("kdf") ?: return DEFAULT_KDF
        return KdfParams(
            name = k.optString("name", DEFAULT_KDF.name),
            N = k.optInt("N", DEFAULT_KDF.N),
            r = k.optInt("r", DEFAULT_KDF.r),
            p = k.optInt("p", DEFAULT_KDF.p),
            keylen = k.optInt("keylen", DEFAULT_KDF.keylen),
        )
    }

    fun saltOf(envelope: JSONObject): ByteArray =
        unb64(envelope.getJSONObject("kdf").getString("salt"))

    /**
     * What is structurally wrong with an envelope, or null if it is usable.
     *
     * Checked before any key derivation so a damaged or hand-edited file is
     * reported as damaged, not blamed on the password. It also bounds the
     * scrypt cost the file asks for (memory is 128 * N * r bytes), so a hostile
     * backup cannot make the device allocate gigabytes.
     */
    fun envelopeProblem(envelope: JSONObject): String? {
        val kdf = envelope.optJSONObject("kdf") ?: return "its key-derivation settings are missing"
        if (kdf.optString("name", DEFAULT_KDF.name) != "scrypt") return "it uses an unsupported key derivation"

        val n = kdf.optInt("N", -1)
        val r = kdf.optInt("r", -1)
        val p = kdf.optInt("p", -1)
        if (n < 2 || (n and (n - 1)) != 0) return "its key-derivation settings are invalid"
        if (r < 1 || p < 1 || p > 16) return "its key-derivation settings are invalid"
        if (n.toLong() * r > MAX_SCRYPT_N_TIMES_R) return "its key-derivation settings are too demanding for this device"
        if (kdf.optInt("keylen", -1) != DEFAULT_KDF.keylen) return "its key-derivation settings are invalid"

        if (decodeField(kdf, "salt")?.isNotEmpty() != true) return "its salt is missing or unreadable"
        if (decodeField(envelope, "iv")?.size != IV_BYTES) return "its nonce is missing or unreadable"
        if (decodeField(envelope, "tag")?.size != GCM_TAG_BITS / 8) return "its authentication tag is missing or unreadable"
        if (decodeField(envelope, "data") == null) return "its encrypted contents are missing or unreadable"
        return null
    }

    private fun decodeField(obj: JSONObject, key: String): ByteArray? =
        if (!obj.has(key)) null else runCatching { unb64(obj.getString(key)) }.getOrNull()

    fun wipe(buf: ByteArray) = buf.fill(0)

    fun wipe(chars: CharArray) = chars.fill('\u0000')

    // java.util.Base64 rather than android.util.Base64: same standard-with-padding
    // encoding Node's Buffer#toString('base64') produces, and it's plain JVM (no
    // Android stub), so this class is unit-testable without an emulator.
    private fun b64(bytes: ByteArray): String = java.util.Base64.getEncoder().encodeToString(bytes)
    private fun unb64(text: String): ByteArray = java.util.Base64.getDecoder().decode(text)
}
