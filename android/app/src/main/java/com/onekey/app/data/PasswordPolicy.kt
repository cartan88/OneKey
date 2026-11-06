package com.onekey.app.data

/** The one place that defines what counts as an acceptable master or backup password. */
object PasswordPolicy {
    const val MIN_LENGTH = 8

    fun isAcceptable(password: String): Boolean = password.length >= MIN_LENGTH
}
