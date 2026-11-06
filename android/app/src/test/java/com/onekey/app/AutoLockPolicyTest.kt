package com.onekey.app

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AutoLockPolicyTest {

    private val policy = AutoLockPolicy(idleMs = 300_000L, backgroundMs = 60_000L)

    @Test
    fun `a vault in active use stays unlocked`() {
        assertFalse(policy.shouldLock(nowMs = 120_000, lastInteractionMs = 100_000, backgroundedAtMs = null, pickerOpen = false))
    }

    @Test
    fun `a vault left open and untouched locks after the idle limit`() {
        assertFalse(policy.shouldLock(299_999, 0, null, false))
        assertTrue(policy.shouldLock(300_000, 0, null, false))
    }

    @Test
    fun `leaving the app locks much sooner than leaving it open`() {
        assertFalse(policy.shouldLock(nowMs = 159_999, lastInteractionMs = 0, backgroundedAtMs = 100_000, pickerOpen = false))
        assertTrue(policy.shouldLock(nowMs = 160_000, lastInteractionMs = 0, backgroundedAtMs = 100_000, pickerOpen = false))
    }

    @Test
    fun `time spent in the foreground before leaving does not count against the background limit`() {
        // Last touched 10 minutes ago, but only backgrounded 5 seconds ago.
        assertFalse(policy.shouldLock(nowMs = 605_000, lastInteractionMs = 0, backgroundedAtMs = 600_000, pickerOpen = false))
    }

    @Test
    fun `a file picker gets the longer idle grace period instead of the short one`() {
        assertFalse(policy.shouldLock(nowMs = 200_000, lastInteractionMs = 0, backgroundedAtMs = 100_000, pickerOpen = true))
        assertTrue(policy.shouldLock(nowMs = 400_000, lastInteractionMs = 0, backgroundedAtMs = 100_000, pickerOpen = true))
    }
}
