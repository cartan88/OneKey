package com.onekey.app.data

import org.junit.Assert.assertEquals
import org.junit.Test

class PortabilityTest {

    private fun entry(name: String, url: String, username: String, password: String) = Entry(
        id = "id-$name", name = name, username = username, password = password, url = url,
        notes = "", folder = "", createdAt = "t", updatedAt = "t", passwordUpdatedAt = "t",
    )

    @Test
    fun `hostOf normalizes scheme, case, trailing dot and www`() {
        assertEquals("example.com", Portability.hostOf("https://EXAMPLE.com./path"))
        assertEquals("example.com", Portability.hostOf("http://www.example.com"))
        assertEquals("accounts.google.com", Portability.hostOf("accounts.google.com"))
        assertEquals("", Portability.hostOf(""))
        assertEquals("", Portability.hostOf(null))
    }

    @Test
    fun `fingerprint matches only on identical host, username and password`() {
        val a = entry("A", "https://example.com/login", "user@example.com", "secret1")
        val b = entry("A again", "https://www.example.com/other", "user@example.com", "secret1")
        val differentPassword = entry("A", "https://example.com", "user@example.com", "secret2")

        assertEquals(Portability.fingerprint(a), Portability.fingerprint(b))
        assert(Portability.fingerprint(a) != Portability.fingerprint(differentPassword))
    }

    @Test
    fun `planImport skips exact duplicates and adds everything else`() {
        val existing = listOf(entry("A", "https://a.test", "ua", "pa"))
        val incoming = listOf(
            entry("A dup", "https://a.test", "ua", "pa"), // duplicate: same host+user+password
            entry("B", "https://b.test", "ub", "pb"), // new
        )

        val plan = Portability.planImport(incoming, existing)

        assertEquals(1, plan.toAdd.size)
        assertEquals("B", plan.toAdd[0].name)
        assertEquals(1, plan.duplicates)
    }

    @Test
    fun `importing the same backup twice is harmless the second time`() {
        val existing = mutableListOf(entry("A", "https://a.test", "ua", "pa"))
        val incoming = listOf(entry("A", "https://a.test", "ua", "pa"), entry("B", "https://b.test", "ub", "pb"))

        val firstPlan = Portability.planImport(incoming, existing)
        existing.addAll(firstPlan.toAdd)
        assertEquals(1, firstPlan.toAdd.size) // only B was new

        val secondPlan = Portability.planImport(incoming, existing)
        assertEquals(0, secondPlan.toAdd.size) // both A and B are now already present
        assertEquals(2, secondPlan.duplicates)
    }
}
