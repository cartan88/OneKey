package com.onekey.app

import android.app.Application
import android.os.SystemClock
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.onekey.app.data.Entry
import com.onekey.app.data.VaultException
import com.onekey.app.data.VaultRepository
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.util.concurrent.Executors

enum class Screen { SETUP, UNLOCK, LIST, EDITOR }

data class PendingImport(val envelope: JSONObject, val fileName: String)

data class UiState(
    val screen: Screen = Screen.UNLOCK,
    val entries: List<Entry> = emptyList(),
    val editingEntryId: String? = null,
    val error: String? = null,
    val lastExport: ByteArray? = null,
    val pendingImport: PendingImport? = null,
    val importResult: String? = null,
    val busy: Boolean = false,
)

class OneKeyViewModel(app: Application) : AndroidViewModel(app) {

    private val repo = VaultRepository(app.filesDir)

    // Every vault operation runs here, one at a time and in the order it was
    // asked for. Scrypt stays off the main thread, and two operations can never
    // overlap on the vault file or the entry list.
    private val worker = Executors.newSingleThreadExecutor { Thread(it, "onekey-vault") }
    private val workerDispatcher = worker.asCoroutineDispatcher()

    // Touched on the main thread only.
    private var inFlight = 0

    private val _state = MutableStateFlow(
        UiState(screen = if (repo.exists()) Screen.UNLOCK else Screen.SETUP)
    )
    val state: StateFlow<UiState> = _state.asStateFlow()

    override fun onCleared() {
        worker.shutdown()
    }

    private fun submit(block: () -> Unit) {
        inFlight++
        _state.update { it.copy(busy = true) }
        viewModelScope.launch {
            withContext(workerDispatcher) { runCatching(block).onFailure(::reportError) }
            inFlight--
            if (inFlight == 0) _state.update { it.copy(busy = false) }
        }
    }

    fun clearError() = _state.update { it.copy(error = null) }
    fun clearImportResult() = _state.update { it.copy(importResult = null) }
    fun showError(message: String) = _state.update { it.copy(error = message) }

    fun createVault(masterPassword: String) = submit {
        repo.create(masterPassword)
        _state.update { it.copy(screen = Screen.LIST, entries = repo.listEntries(), error = null) }
    }

    fun unlock(masterPassword: String) = submit {
        repo.unlock(masterPassword)
        _state.update { it.copy(screen = Screen.LIST, entries = repo.listEntries(), error = null) }
    }

    /**
     * What the user sees goes away at once; the key itself is released on the
     * worker, after any operation already underway has finished.
     */
    fun lock() {
        hideVaultContents()
        ClipboardGuard.clearNow(getApplication())
        submit {
            repo.lock()
            hideVaultContents()
        }
    }

    private fun hideVaultContents() = _state.update {
        it.copy(
            screen = Screen.UNLOCK,
            entries = emptyList(),
            editingEntryId = null,
            lastExport = null,
            pendingImport = null,
        )
    }

    // ------------------------------------------------------------ auto-lock

    private val autoLock = AutoLockPolicy()
    private var lastInteractionAt = SystemClock.elapsedRealtime()
    private var backgroundedAt: Long? = null
    private var pickerOpen = false

    init {
        viewModelScope.launch {
            while (true) {
                delay(5_000)
                lockIfDue()
            }
        }
    }

    private fun isShowingVault() = _state.value.screen.let { it == Screen.LIST || it == Screen.EDITOR }

    private fun lockIfDue() {
        if (isShowingVault() &&
            autoLock.shouldLock(SystemClock.elapsedRealtime(), lastInteractionAt, backgroundedAt, pickerOpen)
        ) {
            lock()
        }
    }

    /** A touch or key press anywhere in the app. */
    fun noteInteraction() {
        lastInteractionAt = SystemClock.elapsedRealtime()
    }

    fun onBackgrounded() {
        backgroundedAt = SystemClock.elapsedRealtime()
    }

    /** Checked first thing on return, because timers do not tick while the app is frozen in the background. */
    fun onForegrounded() {
        lockIfDue()
        backgroundedAt = null
        lastInteractionAt = SystemClock.elapsedRealtime()
    }

    /** A system file picker is open over the app, so leaving it is not the user walking away. */
    fun pickerOpened() {
        pickerOpen = true
    }

    fun pickerClosed() {
        pickerOpen = false
        lastInteractionAt = SystemClock.elapsedRealtime()
    }

    fun openNewEntry() = _state.update { it.copy(screen = Screen.EDITOR, editingEntryId = null) }
    fun openEditEntry(id: String) = _state.update { it.copy(screen = Screen.EDITOR, editingEntryId = id) }
    fun closeEditor() = _state.update { it.copy(screen = Screen.LIST, editingEntryId = null) }

    /** Looked up in the already-loaded list, so composing the editor never touches the vault. */
    fun entryById(id: String?): Entry? = id?.let { wanted -> _state.value.entries.find { it.id == wanted } }

    fun saveEntry(id: String?, name: String, username: String, password: String, url: String, notes: String, folder: String) =
        submit {
            if (id == null) {
                repo.addEntry(name, username, password, url, notes, folder)
            } else {
                repo.updateEntry(id, name, username, password, url, notes, folder)
            }
            _state.update { it.copy(screen = Screen.LIST, entries = repo.listEntries(), editingEntryId = null) }
        }

    fun deleteEntry(id: String) = submit {
        repo.deleteEntries(setOf(id))
        _state.update { it.copy(entries = repo.listEntries()) }
    }

    fun exportBackup(backupPassword: String) {
        // One export at a time: its bytes are held until the user has chosen where to save them.
        if (_state.value.lastExport != null) return
        submit {
            val bytes = repo.exportBackup(backupPassword)
            _state.update { it.copy(lastExport = bytes, error = null) }
        }
    }

    /** The save-location picker is done: [saved] says whether the file was actually written. */
    fun finishExport(saved: Boolean) = _state.update {
        it.copy(
            lastExport = null,
            error = if (saved) it.error else "The backup couldn't be written there. Nothing was saved - try again or pick a different location.",
        )
    }

    fun inspectImport(bytes: ByteArray, fileName: String) = submit {
        val envelope = repo.inspectBackup(bytes)
        _state.update { it.copy(pendingImport = PendingImport(envelope, fileName)) }
    }

    fun clearPendingImport() = _state.update { it.copy(pendingImport = null) }

    fun applyImport(backupPassword: String) {
        val pending = _state.value.pendingImport ?: return
        submit {
            val plan = repo.previewImport(pending.envelope, backupPassword)
            val added = repo.applyImport(plan)
            val message = if (plan.duplicates > 0) {
                "Imported $added item(s) - ${plan.duplicates} duplicate(s) skipped."
            } else {
                "Imported $added item(s)."
            }
            _state.update {
                it.copy(
                    entries = repo.listEntries(),
                    pendingImport = null,
                    importResult = message,
                )
            }
        }
    }

    private fun reportError(t: Throwable) {
        val message = when (t) {
            is VaultException -> t.message
            is OutOfMemoryError -> "This device doesn't have enough free memory to open the vault. Close other apps and try again."
            else -> "Something went wrong."
        }
        _state.update { it.copy(error = message) }
    }
}
