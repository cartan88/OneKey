package com.onekey.app.crypto

import com.onekey.app.data.Entry
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * The fixture below is not something this test wrote — it was produced by the
 * DESKTOP app's actual Node crypto.js/portability.js (see the generation
 * command in the session), independently of any Kotlin code here. Decrypting
 * it correctly is the real proof that this envelope format is compatible with
 * the desktop app, not just that this file's own encrypt/decrypt round-trips
 * with itself.
 */
@RunWith(RobolectricTestRunner::class)
class OneKeyCryptoTest {

    private fun loadFixture(): String =
        javaClass.classLoader!!.getResourceAsStream("sample-backup.onekey.json")!!
            .bufferedReader(Charsets.UTF_8).readText()

    @Test
    fun `decrypts a real backup produced by the desktop app's Node crypto code`() {
        val envelope = JSONObject(loadFixture())
        assertEquals("onekey-backup", envelope.getString("format"))

        val params = OneKeyCrypto.kdfFromEnvelope(envelope)
        val salt = OneKeyCrypto.saltOf(envelope)
        val key = OneKeyCrypto.deriveKey("correct-horse-battery".toCharArray(), salt, params)

        val payload = JSONObject(OneKeyCrypto.decryptPayload(envelope, key))
        assertEquals("onekey-backup", payload.getString("format"))
        assertEquals("2026-01-01T00:00:00.000Z", payload.getString("exportedAt"))

        val entries = payload.getJSONArray("entries")
        assertEquals(2, entries.length())

        val bank = entries.getJSONObject(0)
        assertEquals("Example Bank", bank.getString("name"))
        assertEquals("https://example.com/login", bank.getString("url"))
        assertEquals("alice@example.com", bank.getString("username"))
        assertEquals("Tr0ub4dor&3!Xyz", bank.getString("password"))
        assertEquals("Finance", bank.getString("folder"))
        assertEquals("Primary checking", bank.getString("notes"))

        val mail = entries.getJSONObject(1)
        assertEquals("Sample Mail", mail.getString("name"))
        assertEquals("p@ss w0rd/with\"quotes", mail.getString("password"))
    }

    @Test
    fun `wrong backup password fails to decrypt (GCM auth tag rejects it)`() {
        val envelope = JSONObject(loadFixture())
        val params = OneKeyCrypto.kdfFromEnvelope(envelope)
        val salt = OneKeyCrypto.saltOf(envelope)
        val wrongKey = OneKeyCrypto.deriveKey("totally-wrong-password".toCharArray(), salt, params)

        assertThrows(Exception::class.java) {
            OneKeyCrypto.decryptPayload(envelope, wrongKey)
        }
    }

    @Test
    fun `round-trips its own encrypt then decrypt`() {
        val salt = OneKeyCrypto.newSalt()
        val key = OneKeyCrypto.deriveKey("some master password".toCharArray(), salt, OneKeyCrypto.DEFAULT_KDF)
        val original = """{"hello":"world","n":42}"""

        val envelope = OneKeyCrypto.encryptPayload(original, key, salt, OneKeyCrypto.DEFAULT_KDF, "onekey-vault")
        val decrypted = OneKeyCrypto.decryptPayload(envelope, key)

        assertEquals(JSONObject(original).toString(), JSONObject(decrypted).toString())
    }

    @Test
    fun `entry round-trips through backup json shape`() {
        val entry = Entry(
            id = "irrelevant-for-backups",
            name = "Site",
            username = "user",
            password = "pw",
            url = "https://site.example",
            notes = "note",
            folder = "folder",
            createdAt = "2026-01-01T00:00:00.000Z",
            updatedAt = "2026-01-01T00:00:00.000Z",
            passwordUpdatedAt = "2026-01-01T00:00:00.000Z",
        )
        val backupJson = entry.toBackupJson()
        assertEquals(setOf("name", "url", "username", "password", "folder", "notes"), backupJson.keys().asSequence().toSet())

        val restored = Entry.fromBackupJson(backupJson, "2026-02-01T00:00:00.000Z")
        assertEquals(entry.name, restored.name)
        assertEquals(entry.password, restored.password)
        assertEquals("2026-02-01T00:00:00.000Z", restored.createdAt)
    }
}
