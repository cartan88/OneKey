package com.onekey.app.data

import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/** A single stored login. Mirrors the desktop vault's entry shape. */
data class Entry(
    val id: String,
    val name: String,
    val username: String,
    val password: String,
    val url: String,
    val notes: String,
    val folder: String,
    val createdAt: String,
    val updatedAt: String,
    val passwordUpdatedAt: String,
) {
    fun toJson(): JSONObject = JSONObject().apply {
        put("id", id)
        put("name", name)
        put("username", username)
        put("password", password)
        put("url", url)
        put("notes", notes)
        put("folder", folder)
        put("createdAt", createdAt)
        put("updatedAt", updatedAt)
        put("passwordUpdatedAt", passwordUpdatedAt)
    }

    /** Portable form used in `.onekey` backups — no id or timestamps. */
    fun toBackupJson(): JSONObject = JSONObject().apply {
        put("name", name)
        put("url", url)
        put("username", username)
        put("password", password)
        put("folder", folder)
        put("notes", notes)
    }

    companion object {
        fun fromJson(o: JSONObject): Entry = Entry(
            id = o.optString("id", UUID.randomUUID().toString()),
            name = o.optString("name", ""),
            username = o.optString("username", ""),
            password = o.optString("password", ""),
            url = o.optString("url", ""),
            notes = o.optString("notes", ""),
            folder = o.optString("folder", ""),
            createdAt = o.optString("createdAt", ""),
            updatedAt = o.optString("updatedAt", ""),
            passwordUpdatedAt = o.optString("passwordUpdatedAt", ""),
        )

        /** A backup row (name/url/username/password/folder/notes only) becomes a fresh entry. */
        fun fromBackupJson(o: JSONObject, now: String): Entry = Entry(
            id = UUID.randomUUID().toString(),
            name = o.optString("name", "").trim(),
            username = o.optString("username", "").trim(),
            password = o.optString("password", ""),
            url = o.optString("url", "").trim(),
            notes = o.optString("notes", ""),
            folder = o.optString("folder", "").trim(),
            createdAt = now,
            updatedAt = now,
            passwordUpdatedAt = now,
        )
    }
}

fun JSONArray.toEntryList(): List<Entry> = List(length()) { i -> Entry.fromJson(getJSONObject(i)) }

fun List<Entry>.toJsonArray(): JSONArray = JSONArray().apply { forEach { put(it.toJson()) } }
