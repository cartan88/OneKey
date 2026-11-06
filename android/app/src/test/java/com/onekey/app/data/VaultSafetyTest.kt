package com.onekey.app.data

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** Regression tests for the review findings: durability, concurrency, and honest error reporting. */
@RunWith(RobolectricTestRunner::class)
class VaultSafetyTest {

    @get:Rule
    val tmp = TemporaryFolder()

    private fun vaultWith(dir: File, vararg names: String): VaultRepository {
        val repo = VaultRepository(dir)
        repo.create("master password")
        names.forEach { repo.addEntry(it, "user-$it", "pw-$it", "https://$it.test", "", "") }
        return repo
    }

    // ------------------------------------------------------------- durability

    @Test
    fun `each save keeps the previous vault as a spare copy`() {
        val dir = tmp.newFolder()
        val repo = vaultWith(dir, "A")
        repo.addEntry("B", "u", "p", "https://b.test", "", "")

        assertTrue(File(dir, "vault.onekey.bak").exists())
        assertFalse("the temp file must not be left behind", File(dir, "vault.onekey.tmp").exists())
    }

    @Test
    fun `an unreadable vault file falls back to the spare copy`() {
        val dir = tmp.newFolder()
        val repo = vaultWith(dir, "A")
        repo.addEntry("B", "u", "p", "https://b.test", "", "") // spare now holds the A-only state
        repo.lock()

        File(dir, "vault.onekey").writeText("{ truncated by a crash")

        repo.unlock("master password")
        assertEquals(listOf("A"), repo.listEntries().map { it.name })
    }

    @Test
    fun `a failed save leaves memory and disk unchanged`() {
        val dir = tmp.newFolder()
        val repo = vaultWith(dir, "A")
        File(dir, "vault.onekey.tmp").mkdir() // makes writing the temp file fail

        assertThrows(Exception::class.java) { repo.addEntry("B", "u", "p", "https://b.test", "", "") }
        assertEquals(listOf("A"), repo.listEntries().map { it.name })

        File(dir, "vault.onekey.tmp").delete()
        repo.lock()
        repo.unlock("master password")
        assertEquals(listOf("A"), repo.listEntries().map { it.name })
    }

    // ----------------------------------------------------------- master password

    @Test
    fun `changing the master password is verified against the file and survives a relock`() {
        val dir = tmp.newFolder()
        val repo = vaultWith(dir, "A")

        val wrong = assertThrows(VaultException::class.java) { repo.changeMasterPassword("not it at all", "second password") }
        assertEquals("BAD_PASSWORD", wrong.code)

        repo.changeMasterPassword("master password", "second password")
        repo.lock()
        assertThrows(VaultException::class.java) { repo.unlock("master password") }
        repo.unlock("second password")
        assertEquals(listOf("A"), repo.listEntries().map { it.name })
    }

    @Test
    fun `a failed password change keeps the old password in force`() {
        val dir = tmp.newFolder()
        val repo = vaultWith(dir, "A")
        File(dir, "vault.onekey.tmp").mkdir()

        assertThrows(Exception::class.java) { repo.changeMasterPassword("master password", "second password") }

        File(dir, "vault.onekey.tmp").delete()
        repo.lock()
        repo.unlock("master password") // still the old one, on disk and in the session
        assertEquals(1, repo.listEntries().size)
    }

    // ----------------------------------------------------------------- concurrency

    @Test
    fun `concurrent writers neither lose entries nor corrupt the file`() {
        val dir = tmp.newFolder()
        val repo = vaultWith(dir)

        val threads = 8
        val perThread = 5
        val pool = Executors.newFixedThreadPool(threads)
        val start = CountDownLatch(1)
        val failures = java.util.Collections.synchronizedList(mutableListOf<Throwable>())
        repeat(threads) { t ->
            pool.execute {
                start.await()
                repeat(perThread) { i ->
                    try {
                        repo.addEntry("t$t-$i", "u", "p", "https://t$t-$i.test", "", "")
                        repo.listEntries()
                    } catch (e: Throwable) {
                        failures.add(e)
                    }
                }
            }
        }
        start.countDown()
        pool.shutdown()
        assertTrue(pool.awaitTermination(60, TimeUnit.SECONDS))

        assertTrue("unexpected failures: $failures", failures.isEmpty())
        assertEquals(threads * perThread, repo.listEntries().size)

        repo.lock()
        repo.unlock("master password")
        assertEquals(threads * perThread, repo.listEntries().size)
    }

    // ------------------------------------------------- damaged file vs wrong password

    private fun backupEnvelope(): JSONObject {
        val source = vaultWith(tmp.newFolder(), "A")
        return JSONObject(String(source.exportBackup("backup password")))
    }

    private fun importer() = vaultWith(tmp.newFolder())

    @Test
    fun `a backup missing its nonce is reported as damaged, not as a wrong password`() {
        val envelope = backupEnvelope().apply { remove("iv") }
        val err = assertThrows(VaultException::class.java) { importer().inspectBackup(envelope.toString().toByteArray()) }
        assertEquals("CORRUPT", err.code)
    }

    @Test
    fun `a backup missing a key-derivation setting is reported as damaged`() {
        val envelope = backupEnvelope().apply { getJSONObject("kdf").remove("N") }
        val err = assertThrows(VaultException::class.java) { importer().inspectBackup(envelope.toString().toByteArray()) }
        assertEquals("CORRUPT", err.code)
    }

    @Test
    fun `a backup demanding absurd scrypt memory is refused before any derivation`() {
        val envelope = backupEnvelope().apply { getJSONObject("kdf").put("N", 1 shl 30) }
        val err = assertThrows(VaultException::class.java) { importer().inspectBackup(envelope.toString().toByteArray()) }
        assertEquals("CORRUPT", err.code)
    }

    @Test
    fun `a genuine wrong backup password is still reported as one`() {
        val envelope = backupEnvelope()
        val dest = importer()
        val err = assertThrows(VaultException::class.java) { dest.previewImport(dest.inspectBackup(envelope.toString().toByteArray()), "not the password") }
        assertEquals("BAD_PASSWORD", err.code)
    }

    @Test
    fun `a real backup produced by the desktop app passes validation and imports`() {
        val fixture = javaClass.classLoader!!.getResourceAsStream("sample-backup.onekey.json")!!.readBytes()
        val dest = importer()

        val plan = dest.previewImport(dest.inspectBackup(fixture), "correct-horse-battery")

        assertEquals(2, plan.toAdd.size)
        assertEquals(2, dest.applyImport(plan))
        assertEquals(setOf("Example Bank", "Sample Mail"), dest.listEntries().map { it.name }.toSet())
    }

    @Test
    fun `the password rule is shared`() {
        assertFalse(PasswordPolicy.isAcceptable("1234567"))
        assertTrue(PasswordPolicy.isAcceptable("12345678"))
        val err = assertThrows(VaultException::class.java) { VaultRepository(tmp.newFolder()).create("1234567") }
        assertEquals("WEAK_MASTER", err.code)
    }
}
