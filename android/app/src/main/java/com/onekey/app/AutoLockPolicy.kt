package com.onekey.app

/**
 * When an unlocked vault should lock itself.
 *
 * Pure so it can be unit-tested without a device. A vault that is simply left
 * open is locked after [idleMs] without a touch or key press; one the user has
 * left (switched apps, turned the screen off) is locked much sooner, after
 * [backgroundMs]. While a system file picker is open the app is necessarily in
 * the background, so that grace period is stretched to the idle limit rather
 * than locking the vault under someone who is choosing where to save a backup.
 */
class AutoLockPolicy(
    private val idleMs: Long = 5 * 60_000L,
    private val backgroundMs: Long = 60_000L,
) {
    fun shouldLock(
        nowMs: Long,
        lastInteractionMs: Long,
        backgroundedAtMs: Long?,
        pickerOpen: Boolean,
    ): Boolean = if (backgroundedAtMs != null) {
        nowMs - backgroundedAtMs >= (if (pickerOpen) idleMs else backgroundMs)
    } else {
        nowMs - lastInteractionMs >= idleMs
    }
}
