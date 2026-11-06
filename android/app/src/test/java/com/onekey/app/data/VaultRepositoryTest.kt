package com.onekey.app.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class VaultRepositoryTest {

    @get:Rule
    val tmp = TemporaryFolder()

    @Test
    fun `create then unlock with the right password, refuse the wrong one`() {
        val dir = tmp.newFolder()
        val repo = VaultRepository(dir)
        assertFalse(repo.exists())

        repo.create("correct password")
        assertTrue(repo.exists())
        repo.lock()
        assertFalse(repo.isUnlocked)

        val bad = assertThrows(VaultException::class.java) { repo.unlock("wrong password") }
        assertEquals("BAD_PASSWORD", bad.code)

        repo.unlock("correct password")
        assertTrue(repo.isUnlocked)
    }

    @Test
    fun `a master password under 8 characters is refused`() {
        val repo = VaultRepository(tmp.newFolder())
        val err = assertThrows(VaultException::class.java) { repo.create("short") }
        assertEquals("WEAK_MASTER", err.code)
    }

    @Test
    fun `add, edit and delete entries persist across lock and unlock`() {
        val dir = tmp.newFolder()
        val repo = VaultRepository(dir)
        repo.create("master password")

        val entry = repo.addEntry("Site", "user", "pw", "https://site.test", "note", "Work")
        repo.lock()
        repo.unlock("master password")
        assertEquals(1, repo.listEntries().size)

        repo.updateEntry(entry.id, name = "Renamed", username = null, password = "new-pw", url = null, notes = null, folder = null)
        repo.lock()
        repo.unlock("master password")
        val updated = repo.listEntries().single()
        assertEquals("Renamed", updated.name)
        assertEquals("new-pw", updated.password)
        assertEquals("https://site.test", updated.url) // untouched fields survive

        repo.deleteEntries(setOf(entry.id))
        assertTrue(repo.listEntries().isEmpty())
    }

    @Test
    fun `exporting from one vault and importing into another carries entries over, deduping on re-import`() {
        val source = VaultRepository(tmp.newFolder())
        source.create("source master password")
        source.addEntry("Bank", "alice", "secret1", "https://bank.test", "", "Finance")
        source.addEntry("Mail", "alice", "secret2", "https://mail.test", "", "")

        val backupBytes = source.exportBackup("shared backup password")

        val dest = VaultRepository(tmp.newFolder())
        dest.create("dest master password")

        val envelope = dest.inspectBackup(backupBytes)
        val plan = dest.previewImport(envelope, "shared backup password")
        assertEquals(2, plan.toAdd.size)
        assertEquals(2, dest.applyImport(plan))
        assertEquals(2, dest.listEntries().size)

        // Re-importing the same backup adds nothing new.
        val secondPlan = dest.previewImport(dest.inspectBackup(backupBytes), "shared backup password")
        assertEquals(0, secondPlan.toAdd.size)
        assertEquals(2, secondPlan.duplicates)
    }

    @Test
    fun `wrong backup password is refused without touching the vault`() {
        val source = VaultRepository(tmp.newFolder())
        source.create("source master password")
        source.addEntry("Bank", "alice", "secret1", "https://bank.test", "", "")
        val backupBytes = source.exportBackup("correct backup password")

        val dest = VaultRepository(tmp.newFolder())
        dest.create("dest master password")
        val envelope = dest.inspectBackup(backupBytes)

        val err = assertThrows(VaultException::class.java) { dest.previewImport(envelope, "wrong backup password") }
        assertEquals("BAD_PASSWORD", err.code)
        assertTrue(dest.listEntries().isEmpty())
    }

    @Test
    fun `a file that isn't a backup is refused rather than parsed`() {
        val repo = VaultRepository(tmp.newFolder())
        repo.create("master password")
        val err = assertThrows(VaultException::class.java) {
            repo.inspectBackup("not even json".toByteArray())
        }
        assertEquals("NOT_BACKUP", err.code)
    }
}
