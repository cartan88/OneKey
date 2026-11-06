# One Key

A local-only password manager. No account, no sync service, no server: each
device keeps its own encrypted vault file, protected by a master password that
is never stored anywhere and cannot be recovered.

| | |
|---|---|
| [`desktop/`](desktop/) | Windows app (Electron) plus the Chrome extension for autofill and capture. See [desktop/README.md](desktop/README.md). |
| [`android/`](android/) | Android app (Kotlin, Jetpack Compose). See [android/README.md](android/README.md). |

## Moving passwords between devices

The two apps share one file format, the encrypted `.onekey` backup
(scrypt + AES-256-GCM). Export a backup on one device, carry the file to the
other (a synced folder, USB, anything), and import it there. Imports only ever
add entries; nothing is overwritten.

Each device has its own master password. They are independent and are never
synced, so changing it on one device does not change it on the other.
