package com.onekey.app.data

import com.onekey.app.crypto.OneKeyCrypto
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.time.Instant
import java.util.UUID
import javax.crypto.BadPaddingException

class VaultException(val code: String, message: String) : Exception(message)

/**
 * Owns the decrypted entries and the derived key while unlocked. The vault
 * file lives in the app's private internal storage — never external/shared
 * storage — consistent with One Key's local-only design. It uses the exact
 * same envelope format as a `.onekey` backup (see OneKeyCrypto), just tagged
 * "onekey-vault" instead of "onekey-backup".
 *
 * Every public member is synchronized, so no two callers can interleave on the
 * entries list or on the vault file, whatever thread they arrive on. (The
 * desktop app gets the same guarantee from its chained write queue.)
 */
class VaultRepository(baseDir: File) {

    private val file = File(baseDir, "vault.onekey")
    private val tmpFile = File(baseDir, "vault.onekey.tmp")
    private val backupFile = File(baseDir, "vault.onekey.bak")

    private var key: ByteArray? = null
    private var salt: ByteArray? = null
    private var kdf: OneKeyCrypto.KdfParams = OneKeyCrypto.DEFAULT_KDF
    private var entries: MutableList<Entry> = mutableListOf()

    val isUnlocked: Boolean
        @Synchronized get() = key != null

    @Synchronized
    fun exists(): Boolean = file.exists()

    @Synchronized
    fun listEntries(): List<Entry> {
        assertUnlocked()
        return sortedEntries()
    }

    // ------------------------------------------------------------ lifecycle

    @Synchronized
    fun create(masterPassword: String) {
        if (exists()) throw VaultException("EXISTS", "A vault already exists on this device.")
        requireAcceptablePassword(masterPassword, "WEAK_MASTER", "Your master password must be at least ${PasswordPolicy.MIN_LENGTH} characters.")

        file.parentFile?.mkdirs()
        val newSalt = OneKeyCrypto.newSalt()
        val newKey = OneKeyCrypto.deriveKey(masterPassword.toCharArray(), newSalt, OneKeyCrypto.DEFAULT_KDF)
        try {
            writeVault(newKey, newSalt, OneKeyCrypto.DEFAULT_KDF, emptyList())
        } catch (e: Exception) {
            OneKeyCrypto.wipe(newKey)
            throw e
        }
        key = newKey
        salt = newSalt
        kdf = OneKeyCrypto.DEFAULT_KDF
        entries = mutableListOf()
    }

    @Synchronized
    fun unlock(masterPassword: String) {
        if (!exists()) throw VaultException("NO_VAULT", "No vault found. Create one first.")

        val envelope = readEnvelope()
        val params = OneKeyCrypto.kdfFromEnvelope(envelope)
        val candidateSalt = OneKeyCrypto.saltOf(envelope)
        val candidateKey = OneKeyCrypto.deriveKey(masterPassword.toCharArray(), candidateSalt, params)

        val payload = try {
            decryptToJson(envelope, candidateKey, "BAD_PASSWORD", "Incorrect master password.")
        } catch (e: Exception) {
            OneKeyCrypto.wipe(candidateKey)
            throw e
        }

        key?.let { OneKeyCrypto.wipe(it) }
        key = candidateKey
        salt = candidateSalt
        kdf = params
        entries = payload.optJSONArray("entries")?.toEntryList()?.toMutableList() ?: mutableListOf()
    }

    @Synchronized
    fun lock() {
        key?.let { OneKeyCrypto.wipe(it) }
        key = null
        entries = mutableListOf()
    }

    /**
     * The current password is checked against the vault file as it is on disk
     * (not against the key held in memory), and the new key is only adopted
     * once the file has actually been rewritten under it. A failed write
     * therefore leaves both the session and the file on the old password.
     */
    @Synchronized
    fun changeMasterPassword(currentPassword: String, newPassword: String) {
        assertUnlocked()
        requireAcceptablePassword(newPassword, "WEAK_MASTER", "Your new master password must be at least ${PasswordPolicy.MIN_LENGTH} characters.")

        val envelope = readEnvelope()
        val diskKey = OneKeyCrypto.deriveKey(
            currentPassword.toCharArray(),
            OneKeyCrypto.saltOf(envelope),
            OneKeyCrypto.kdfFromEnvelope(envelope),
        )
        try {
            decryptToJson(envelope, diskKey, "BAD_PASSWORD", "Current master password is incorrect.")
        } finally {
            OneKeyCrypto.wipe(diskKey)
        }

        val newSalt = OneKeyCrypto.newSalt()
        val newKey = OneKeyCrypto.deriveKey(newPassword.toCharArray(), newSalt, OneKeyCrypto.DEFAULT_KDF)
        try {
            writeVault(newKey, newSalt, OneKeyCrypto.DEFAULT_KDF, entries)
        } catch (e: Exception) {
            OneKeyCrypto.wipe(newKey)
            throw e
        }

        key?.let { OneKeyCrypto.wipe(it) }
        key = newKey
        salt = newSalt
        kdf = OneKeyCrypto.DEFAULT_KDF
    }

    // -------------------------------------------------------------- entries

    @Synchronized
    fun addEntry(name: String, username: String, password: String, url: String, notes: String, folder: String): Entry {
        assertUnlocked()
        val now = nowIso()
        val entry = Entry(
            id = UUID.randomUUID().toString(),
            name = name.trim().ifEmpty { "Untitled" },
            username = username.trim(),
            password = password,
            url = url.trim(),
            notes = notes,
            folder = folder.trim(),
            createdAt = now,
            updatedAt = now,
            passwordUpdatedAt = now,
        )
        commit(entries + entry)
        return entry
    }

    @Synchronized
    fun updateEntry(id: String, name: String?, username: String?, password: String?, url: String?, notes: String?, folder: String?) {
        assertUnlocked()
        val idx = entries.indexOfFirst { it.id == id }
        if (idx < 0) throw VaultException("NOT_FOUND", "That entry no longer exists.")
        val existing = entries[idx]
        val now = nowIso()
        val passwordChanged = password != null && password != existing.password
        val updated = existing.copy(
            name = name?.trim()?.ifEmpty { "Untitled" } ?: existing.name,
            username = username?.trim() ?: existing.username,
            password = password ?: existing.password,
            url = url?.trim() ?: existing.url,
            notes = notes ?: existing.notes,
            folder = folder?.trim() ?: existing.folder,
            updatedAt = now,
            passwordUpdatedAt = if (passwordChanged) now else existing.passwordUpdatedAt,
        )
        commit(entries.toMutableList().also { it[idx] = updated })
    }

    @Synchronized
    fun deleteEntries(ids: Set<String>) {
        assertUnlocked()
        commit(entries.filter { it.id !in ids })
    }

    @Synchronized
    fun moveEntriesToFolder(ids: Set<String>, folder: String) {
        assertUnlocked()
        val target = folder.trim()
        commit(entries.map { if (it.id in ids) it.copy(folder = target) else it })
    }

    // ---------------------------------------------------------- backup i/o

    /** Every login in portable form, passwords included. */
    @Synchronized
    fun exportBackup(backupPassword: String): ByteArray {
        assertUnlocked()
        requireAcceptablePassword(backupPassword, "WEAK_PASSWORD", "The backup password must be at least ${PasswordPolicy.MIN_LENGTH} characters.")
        val payload = JSONObject().apply {
            put("format", Portability.BACKUP_FORMAT)
            put("version", 1)
            put("exportedAt", nowIso())
            put("entries", JSONArray().apply { sortedEntries().forEach { put(it.toBackupJson()) } })
        }
        val backupSalt = OneKeyCrypto.newSalt()
        val backupKey = OneKeyCrypto.deriveKey(backupPassword.toCharArray(), backupSalt, OneKeyCrypto.DEFAULT_KDF)
        val envelope = try {
            OneKeyCrypto.encryptPayload(payload.toString(), backupKey, backupSalt, OneKeyCrypto.DEFAULT_KDF, Portability.BACKUP_FORMAT)
        } finally {
            OneKeyCrypto.wipe(backupKey)
        }
        return envelope.toString(2).toByteArray(Charsets.UTF_8)
    }

    /** Parses (but does not decrypt) a chosen backup file. Refuses anything that isn't one. */
    fun inspectBackup(bytes: ByteArray): JSONObject {
        val envelope = try {
            JSONObject(String(bytes, Charsets.UTF_8))
        } catch (e: Exception) {
            throw VaultException("NOT_BACKUP", "That is not a One Key backup.")
        }
        if (envelope.optString("format") != Portability.BACKUP_FORMAT || !envelope.has("kdf") || !envelope.has("data")) {
            throw VaultException("NOT_BACKUP", "That is not a One Key backup. Only .onekey backup files can be imported.")
        }
        OneKeyCrypto.envelopeProblem(envelope)?.let { throw corrupt(it) }
        return envelope
    }

    /** Decrypts an inspected backup and reports what importing it would do, without changing anything yet. */
    @Synchronized
    fun previewImport(envelope: JSONObject, backupPassword: String): Portability.ImportPlan {
        assertUnlocked()
        OneKeyCrypto.envelopeProblem(envelope)?.let { throw corrupt(it) }
        val backupKey = OneKeyCrypto.deriveKey(
            backupPassword.toCharArray(),
            OneKeyCrypto.saltOf(envelope),
            OneKeyCrypto.kdfFromEnvelope(envelope),
        )
        val payload = try {
            decryptToJson(envelope, backupKey, "BAD_PASSWORD", "Incorrect backup password.")
        } finally {
            OneKeyCrypto.wipe(backupKey)
        }
        val now = nowIso()
        val incoming = payload.optJSONArray("entries")?.let { arr ->
            List(arr.length()) { i -> Entry.fromBackupJson(arr.getJSONObject(i), now) }
        } ?: emptyList()
        return Portability.planImport(incoming, entries)
    }

    /** Applies a previously computed import plan. */
    @Synchronized
    fun applyImport(plan: Portability.ImportPlan): Int {
        assertUnlocked()
        commit(entries + plan.toAdd)
        return plan.toAdd.size
    }

    // ------------------------------------------------------------- private

    private fun assertUnlocked() {
        if (key == null) throw VaultException("LOCKED", "The vault is locked.")
    }

    private fun requireAcceptablePassword(password: String, code: String, message: String) {
        if (!PasswordPolicy.isAcceptable(password)) throw VaultException(code, message)
    }

    private fun sortedEntries(): List<Entry> = entries.sortedBy { it.name.lowercase() }

    private fun nowIso(): String = Instant.now().toString()

    private fun corrupt(problem: String) =
        VaultException("CORRUPT", "That file looks damaged or incomplete: $problem.")

    /**
     * Decrypts and parses an envelope. A wrong key and a damaged file are told
     * apart: GCM rejecting the tag is the only outcome blamed on the password.
     */
    private fun decryptToJson(envelope: JSONObject, key: ByteArray, badKeyCode: String, badKeyMessage: String): JSONObject {
        OneKeyCrypto.envelopeProblem(envelope)?.let { throw corrupt(it) }
        val text = try {
            OneKeyCrypto.decryptPayload(envelope, key)
        } catch (e: BadPaddingException) {
            throw VaultException(badKeyCode, badKeyMessage)
        } catch (e: Exception) {
            throw corrupt("it could not be decrypted")
        }
        return try {
            JSONObject(text)
        } catch (e: Exception) {
            throw corrupt("its contents are not readable")
        }
    }

    /**
     * The vault file, or the previous good copy if the main file is unusable.
     *
     * "Usable" includes a structural check, so everything that follows (reading
     * the salt, deriving a key) only ever sees an envelope that has been
     * validated, including the cap on how much memory scrypt may be asked for.
     */
    private fun readEnvelope(): JSONObject {
        val main = loadEnvelope(file)
        if (main.envelope != null) return main.envelope
        if (!backupFile.exists()) throw corrupt(main.problem)

        val spare = loadEnvelope(backupFile)
        if (spare.envelope != null) return spare.envelope
        throw corrupt("the vault file and its backup copy are both unusable")
    }

    private class Loaded(val envelope: JSONObject?, val problem: String)

    private fun loadEnvelope(source: File): Loaded {
        val envelope = try {
            JSONObject(source.readText(Charsets.UTF_8))
        } catch (e: Exception) {
            return Loaded(null, "the vault file is unreadable")
        }
        val problem = OneKeyCrypto.envelopeProblem(envelope)
        return if (problem == null) Loaded(envelope, "") else Loaded(null, problem)
    }

    /** Writes the new entry list to disk and, only once that succeeds, adopts it in memory. */
    private fun commit(newEntries: List<Entry>) {
        writeVault(key!!, salt!!, kdf, newEntries)
        entries = newEntries.toMutableList()
    }

    /**
     * Durable replace of the vault file: the new contents are written to a
     * temporary file and fsynced, the file being replaced is kept as
     * vault.onekey.bak, and the temporary file is then moved into place. A
     * crash at any point leaves either the old file or the complete new one —
     * never a half-written vault.
     */
    private fun writeVault(useKey: ByteArray, useSalt: ByteArray, useKdf: OneKeyCrypto.KdfParams, toStore: List<Entry>) {
        val payload = JSONObject().apply {
            put("version", 1)
            put("entries", toStore.toJsonArray())
        }
        val envelope = OneKeyCrypto.encryptPayload(payload.toString(), useKey, useSalt, useKdf, Portability.VAULT_FORMAT)
        val bytes = envelope.toString(2).toByteArray(Charsets.UTF_8)

        FileOutputStream(tmpFile).use { out ->
            out.write(bytes)
            out.flush()
            out.fd.sync()
        }

        if (file.exists()) {
            // Best effort: failing to refresh the spare copy must not block saving.
            runCatching {
                Files.copy(file.toPath(), backupFile.toPath(), StandardCopyOption.REPLACE_EXISTING)
            }
        }

        try {
            Files.move(tmpFile.toPath(), file.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
        } catch (e: AtomicMoveNotSupportedException) {
            Files.move(tmpFile.toPath(), file.toPath(), StandardCopyOption.REPLACE_EXISTING)
        }
    }
}
