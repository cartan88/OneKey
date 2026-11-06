package com.onekey.app

import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PersistableBundle

/**
 * Puts a secret on the clipboard and takes it back off again.
 *
 * Android keeps clipboard contents until something replaces them, and other
 * apps (and keyboards) can read them, so a copied password is wiped after a
 * short delay and as soon as the vault locks. The desktop app does the same.
 */
object ClipboardGuard {
    private const val LABEL = "One Key"
    private const val CLEAR_AFTER_MS = 30_000L

    private val handler = Handler(Looper.getMainLooper())
    private var pendingClear: Runnable? = null

    fun copySecret(context: Context, value: String) {
        val clipboard = clipboardOf(context)
        val clip = ClipData.newPlainText(LABEL, value)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            // Keeps the value out of the system's clipboard preview.
            clip.description.extras = PersistableBundle().apply {
                putBoolean(ClipDescription.EXTRA_IS_SENSITIVE, true)
            }
        }
        clipboard.setPrimaryClip(clip)

        pendingClear?.let { handler.removeCallbacks(it) }
        val clear = Runnable { clearIfOurs(clipboard) }
        pendingClear = clear
        handler.postDelayed(clear, CLEAR_AFTER_MS)
    }

    fun clearNow(context: Context) {
        pendingClear?.let { handler.removeCallbacks(it) }
        pendingClear = null
        clearIfOurs(clipboardOf(context))
    }

    // Only wipe what One Key put there: something the user copied from another
    // app in the meantime is theirs. (An unreadable description, which is what a
    // background app sees on recent Android versions, is treated as ours.)
    private fun clearIfOurs(clipboard: ClipboardManager) {
        val description = clipboard.primaryClipDescription
        if (description != null && description.label != LABEL) return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            clipboard.clearPrimaryClip()
        } else {
            clipboard.setPrimaryClip(ClipData.newPlainText("", ""))
        }
    }

    private fun clipboardOf(context: Context): ClipboardManager =
        context.applicationContext.getSystemService(ClipboardManager::class.java)
}
