# One Key for Android

Kotlin and Jetpack Compose. The vault is one encrypted file in the app's private
storage (`vault.onekey`, with the previous version kept as `vault.onekey.bak`),
using the same envelope as the desktop app's `.onekey` backups: scrypt
(N=2^17, r=8, p=1) and AES-256-GCM. Auto Backup is disabled so Android never
copies it off the device.

## Features

- Master-password vault: create, unlock, lock.
- Add, edit and delete logins; built-in password generator.
- Copy a password (marked sensitive on Android 13+).
- Export and import encrypted `.onekey` backups through the system file picker,
  interchangeable with the desktop app.

## Building

Requires JDK 17 and the Android SDK (platform 34, build-tools 34.0.0). Create
`local.properties` with `sdk.dir=<path to your SDK>`, then from this folder:

```bash
./gradlew assembleDebug        # app/build/outputs/apk/debug/app-debug.apk
./gradlew testDebugUnitTest    # unit tests, no device needed
```

`app/src/test/resources/sample-backup.onekey.json` is a backup produced by the
desktop app's own Node code; a test decrypts it to prove the two formats stay
compatible.

## Not implemented yet

Biometric unlock, auto-lock on inactivity, and Android Autofill.
