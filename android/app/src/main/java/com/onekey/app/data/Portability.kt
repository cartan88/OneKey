package com.onekey.app.data

import java.net.URI

/**
 * Import/export for One Key on Android. One format, both directions: the same
 * encrypted `.onekey` backup the desktop app reads and writes. Ported from the
 * desktop's src/portability.js and src/match.js so merge/dedupe behavior
 * matches exactly.
 */
object Portability {

    const val BACKUP_FORMAT = "onekey-backup"
    const val VAULT_FORMAT = "onekey-vault"

    /** Hostname in comparable form, or "" if the input isn't a usable http(s) URL. */
    fun hostOf(rawUrl: String?): String {
        val text = rawUrl?.trim().orEmpty()
        if (text.isEmpty()) return ""
        return try {
            val hasScheme = Regex("^[a-zA-Z][a-zA-Z0-9+.-]*://").containsMatchIn(text)
            val uri = URI(if (hasScheme) text else "https://$text")
            val scheme = uri.scheme?.lowercase()
            if (scheme != "http" && scheme != "https") return ""
            val host = uri.host ?: return ""
            host.lowercase().removeSuffix(".").removePrefix("www.")
        } catch (e: Exception) {
            ""
        }
    }

    /**
     * Identity of a login for duplicate detection: same site, user and secret.
     * Joined with NUL, exactly like desktop's fingerprint(), so an entry that
     * legitimately contains a space in its username can't collide with another.
     */
    fun fingerprint(entry: Entry): String {
        val host = hostOf(entry.url).ifEmpty { entry.url.trim().lowercase() }
        return listOf(host, entry.username.trim().lowercase(), entry.password).joinToString("\u0000")
    }

    data class ImportPlan(val toAdd: List<Entry>, val duplicates: Int)

    /**
     * Imports only ever ADD. An incoming row that matches an existing entry
     * exactly is skipped; nothing already stored is ever overwritten.
     */
    fun planImport(incoming: List<Entry>, existing: List<Entry>): ImportPlan {
        val seen = existing.map { fingerprint(it) }.toMutableSet()
        val toAdd = mutableListOf<Entry>()
        var duplicates = 0

        for (entry in incoming) {
            val print = fingerprint(entry)
            if (seen.contains(print)) {
                duplicates++
                continue
            }
            seen.add(print)
            toAdd.add(entry)
        }
        return ImportPlan(toAdd, duplicates)
    }
}
