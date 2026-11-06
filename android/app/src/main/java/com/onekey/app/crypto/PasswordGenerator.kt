package com.onekey.app.crypto

import java.security.SecureRandom

/** Ported from the desktop app's generatePassword() in src/crypto.js. */
object PasswordGenerator {
    private const val LOWER = "abcdefghijklmnopqrstuvwxyz"
    private const val UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    private const val DIGITS = "0123456789"
    private const val SYMBOLS = "!#\$%&()*+,-./:;<=>?@[]^_{|}~"

    private val random = SecureRandom()

    // SecureRandom.nextInt(bound) already uses unbiased rejection sampling.
    private fun randomIndex(max: Int): Int = random.nextInt(max)

    fun generate(
        length: Int = 20,
        lower: Boolean = true,
        upper: Boolean = true,
        digits: Boolean = true,
        symbols: Boolean = true,
    ): String {
        val classes = buildList {
            if (lower) add(LOWER)
            if (upper) add(UPPER)
            if (digits) add(DIGITS)
            if (symbols) add(SYMBOLS)
            if (isEmpty()) add(LOWER)
        }

        val size = length.coerceIn(4, 128)
        val pool = classes.joinToString("")
        val chars = mutableListOf<Char>()

        for (set in classes) {
            if (chars.size < size) chars.add(set[randomIndex(set.length)])
        }
        while (chars.size < size) {
            chars.add(pool[randomIndex(pool.length)])
        }

        for (i in chars.size - 1 downTo 1) {
            val j = randomIndex(i + 1)
            val tmp = chars[i]
            chars[i] = chars[j]
            chars[j] = tmp
        }

        return chars.joinToString("")
    }
}
