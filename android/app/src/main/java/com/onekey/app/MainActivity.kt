@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)

package com.onekey.app

import android.net.Uri
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import com.onekey.app.crypto.PasswordGenerator
import com.onekey.app.data.Entry
import com.onekey.app.data.PasswordPolicy
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class MainActivity : ComponentActivity() {
    private val vm: OneKeyViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Keeps saved logins out of screenshots, screen recordings and the
        // recent-apps thumbnail.
        window.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)

        setContent {
            MaterialTheme {
                Surface(modifier = Modifier.fillMaxSize()) {
                    OneKeyApp(vm)
                }
            }
        }
    }

    // These feed the auto-lock: see AutoLockPolicy.
    override fun onUserInteraction() {
        super.onUserInteraction()
        vm.noteInteraction()
    }

    override fun onStop() {
        super.onStop()
        vm.onBackgrounded()
    }

    override fun onStart() {
        super.onStart()
        vm.onForegrounded()
    }
}

@Composable
fun OneKeyApp(vm: OneKeyViewModel = viewModel()) {
    val state by vm.state.collectAsState()
    val context = LocalContext.current

    var showExportDialog by remember { mutableStateOf(false) }
    var showImportPasswordDialog by remember { mutableStateOf(false) }

    val exportLauncher = rememberLauncherForCreateDocument { uri ->
        vm.pickerClosed()
        val bytes = state.lastExport
        if (uri == null || bytes == null) {
            // Picker dismissed: nothing was saved, and the pending bytes must not linger.
            vm.finishExport(saved = true)
        } else {
            val written = runCatching {
                context.contentResolver.openOutputStream(uri)?.use { it.write(bytes); true } ?: false
            }.getOrDefault(false)
            vm.finishExport(saved = written)
        }
    }
    val importLauncher = rememberLauncherForOpenDocument { uri ->
        vm.pickerClosed()
        if (uri != null) {
            val name = queryDisplayName(context, uri) ?: "backup.onekey"
            val bytes = runCatching {
                context.contentResolver.openInputStream(uri)?.use { it.readBytes() }
            }.getOrNull()
            if (bytes != null) {
                vm.inspectImport(bytes, name)
            } else {
                vm.showError("That file couldn't be opened. Check that it still exists and try again.")
            }
        }
    }

    LaunchedEffect(state.pendingImport) {
        showImportPasswordDialog = state.pendingImport != null
    }
    LaunchedEffect(state.lastExport) {
        if (state.lastExport != null) {
            val stamp = SimpleDateFormat("yyyy-MM-dd", Locale.US).format(Date())
            vm.pickerOpened()
            exportLauncher("one-key-backup-$stamp.onekey")
        }
    }

    Box(Modifier.fillMaxSize()) {
        when (state.screen) {
            Screen.SETUP -> SetupScreen(vm, state.busy)
            Screen.UNLOCK -> UnlockScreen(vm, state.busy)
            Screen.LIST -> VaultListScreen(
                vm = vm,
                entries = state.entries,
                busy = state.busy,
                onExport = { showExportDialog = true },
                onImport = {
                    vm.pickerOpened()
                    importLauncher(arrayOf("*/*"))
                },
            )
            Screen.EDITOR -> EntryEditorScreen(vm, vm.entryById(state.editingEntryId), state.busy)
        }

        if (state.busy) {
            LinearProgressIndicator(Modifier.fillMaxWidth().align(Alignment.TopCenter))
        }
    }

    state.error?.let { message ->
        AlertDialog(
            onDismissRequest = vm::clearError,
            confirmButton = { TextButton(onClick = vm::clearError) { Text("OK") } },
            title = { Text("One Key") },
            text = { Text(message) },
        )
    }

    state.importResult?.let { message ->
        AlertDialog(
            onDismissRequest = vm::clearImportResult,
            confirmButton = { TextButton(onClick = vm::clearImportResult) { Text("OK") } },
            title = { Text("Import complete") },
            text = { Text(message) },
        )
    }

    if (showExportDialog) {
        BackupPasswordDialog(
            title = "Export encrypted backup",
            confirmLabel = "Export",
            onDismiss = { showExportDialog = false },
            onConfirm = { pw ->
                showExportDialog = false
                vm.exportBackup(pw)
            },
        )
    }

    if (showImportPasswordDialog) {
        BackupPasswordDialog(
            title = "Import from ${state.pendingImport?.fileName ?: "backup"}",
            confirmLabel = "Import",
            onDismiss = {
                showImportPasswordDialog = false
                vm.clearPendingImport()
            },
            onConfirm = { pw ->
                showImportPasswordDialog = false
                vm.applyImport(pw)
            },
        )
    }
}

@Composable
private fun SetupScreen(vm: OneKeyViewModel, busy: Boolean) {
    var password by remember { mutableStateOf("") }
    var confirm by remember { mutableStateOf("") }

    CenteredColumn {
        Text("Welcome to One Key", style = MaterialTheme.typography.headlineSmall)
        Spacer(Modifier.height(8.dp))
        Text(
            "Choose a master password. It's never stored anywhere and can't be recovered - if you lose it, your vault is gone.",
            style = MaterialTheme.typography.bodyMedium,
        )
        Spacer(Modifier.height(24.dp))
        PasswordField("Master password", password, { password = it })
        Spacer(Modifier.height(8.dp))
        PasswordField("Confirm password", confirm, { confirm = it })
        Spacer(Modifier.height(24.dp))
        Button(
            enabled = !busy && PasswordPolicy.isAcceptable(password) && password == confirm,
            onClick = { vm.createVault(password) },
            modifier = Modifier.fillMaxWidth(),
        ) { Text("Create vault") }
        if (password.isNotEmpty() && !PasswordPolicy.isAcceptable(password)) {
            HelperText("At least ${PasswordPolicy.MIN_LENGTH} characters.")
        } else if (confirm.isNotEmpty() && password != confirm) {
            HelperText("Passwords don't match.")
        }
    }
}

@Composable
private fun UnlockScreen(vm: OneKeyViewModel, busy: Boolean) {
    var password by remember { mutableStateOf("") }

    CenteredColumn {
        Text("One Key", style = MaterialTheme.typography.headlineMedium)
        Spacer(Modifier.height(24.dp))
        PasswordField("Master password", password, { password = it }, onDone = { if (!busy && password.isNotEmpty()) vm.unlock(password) })
        Spacer(Modifier.height(16.dp))
        Button(
            enabled = !busy && password.isNotEmpty(),
            onClick = { vm.unlock(password) },
            modifier = Modifier.fillMaxWidth(),
        ) { Text("Unlock") }
    }
}

@Composable
private fun VaultListScreen(
    vm: OneKeyViewModel,
    entries: List<Entry>,
    busy: Boolean,
    onExport: () -> Unit,
    onImport: () -> Unit,
) {
    var menuOpen by remember { mutableStateOf(false) }
    var pendingDeleteId by remember { mutableStateOf<String?>(null) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("One Key") },
                actions = {
                    IconButton(enabled = !busy, onClick = vm::lock) {
                        Icon(Icons.Filled.Lock, contentDescription = "Lock vault")
                    }
                    IconButton(enabled = !busy, onClick = { menuOpen = true }) {
                        Icon(Icons.Filled.MoreVert, contentDescription = "More")
                    }
                    DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                        DropdownMenuItem(text = { Text("Export encrypted backup...") }, enabled = !busy, onClick = { menuOpen = false; onExport() })
                        DropdownMenuItem(text = { Text("Import from backup...") }, enabled = !busy, onClick = { menuOpen = false; onImport() })
                    }
                },
            )
        },
        floatingActionButton = {
            FloatingActionButton(onClick = { if (!busy) vm.openNewEntry() }) {
                Icon(Icons.Filled.Add, contentDescription = "Add entry")
            }
        },
    ) { padding ->
        if (entries.isEmpty()) {
            Box(Modifier.fillMaxSize().padding(padding), contentAlignment = Alignment.Center) {
                Text("No saved logins yet. Tap + to add one.", style = MaterialTheme.typography.bodyMedium)
            }
        } else {
            LazyColumn(Modifier.fillMaxSize().padding(padding)) {
                items(entries, key = { it.id }) { entry ->
                    EntryRow(
                        entry = entry,
                        busy = busy,
                        onClick = { vm.openEditEntry(entry.id) },
                        onDelete = { pendingDeleteId = entry.id },
                    )
                    HorizontalDivider()
                }
            }
        }
    }

    pendingDeleteId?.let { id ->
        val entry = entries.find { it.id == id }
        AlertDialog(
            onDismissRequest = { pendingDeleteId = null },
            title = { Text("Delete login?") },
            text = { Text("\"${entry?.name}\" will be removed. This can't be undone.") },
            confirmButton = {
                TextButton(onClick = { vm.deleteEntry(id); pendingDeleteId = null }) { Text("Delete") }
            },
            dismissButton = {
                TextButton(onClick = { pendingDeleteId = null }) { Text("Cancel") }
            },
        )
    }
}

@Composable
private fun EntryRow(entry: Entry, busy: Boolean, onClick: () -> Unit, onDelete: () -> Unit) {
    val context = LocalContext.current
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f).clickable(onClick = onClick)) {
            Text(entry.name, style = MaterialTheme.typography.bodyLarge)
            if (entry.username.isNotEmpty()) {
                Text(entry.username, style = MaterialTheme.typography.bodySmall)
            }
        }
        IconButton(onClick = { ClipboardGuard.copySecret(context, entry.password) }) {
            Icon(Icons.Filled.ContentCopy, contentDescription = "Copy password")
        }
        IconButton(enabled = !busy, onClick = onDelete) {
            Icon(Icons.Filled.Delete, contentDescription = "Delete")
        }
    }
}

@Composable
private fun EntryEditorScreen(vm: OneKeyViewModel, existing: Entry?, busy: Boolean) {
    var name by remember(existing?.id) { mutableStateOf(existing?.name ?: "") }
    var username by remember(existing?.id) { mutableStateOf(existing?.username ?: "") }
    var password by remember(existing?.id) { mutableStateOf(existing?.password ?: "") }
    var url by remember(existing?.id) { mutableStateOf(existing?.url ?: "") }
    var notes by remember(existing?.id) { mutableStateOf(existing?.notes ?: "") }
    var folder by remember(existing?.id) { mutableStateOf(existing?.folder ?: "") }
    var showPassword by remember { mutableStateOf(false) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(if (existing == null) "Add login" else "Edit login") },
                navigationIcon = {
                    IconButton(onClick = vm::closeEditor) {
                        Icon(Icons.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
                actions = {
                    TextButton(
                        enabled = !busy && (name.isNotBlank() || username.isNotBlank() || password.isNotBlank()),
                        onClick = { vm.saveEntry(existing?.id, name, username, password, url, notes, folder) },
                    ) { Text("Save") }
                },
            )
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).padding(16.dp).verticalScroll(rememberScrollState())) {
            LabeledField("Name", name, { name = it })
            Spacer(Modifier.height(12.dp))
            LabeledField("Username / email", username, { username = it }, keyboardType = KeyboardType.Email)
            Spacer(Modifier.height(12.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                OutlinedTextField(
                    value = password,
                    onValueChange = { password = it },
                    label = { Text("Password") },
                    visualTransformation = if (showPassword) androidx.compose.ui.text.input.VisualTransformation.None else PasswordVisualTransformation(),
                    trailingIcon = {
                        IconButton(onClick = { showPassword = !showPassword }) {
                            Icon(
                                if (showPassword) Icons.Filled.VisibilityOff else Icons.Filled.Visibility,
                                contentDescription = "Toggle visibility",
                            )
                        }
                    },
                    modifier = Modifier.weight(1f),
                )
            }
            Spacer(Modifier.height(4.dp))
            TextButton(onClick = { password = PasswordGenerator.generate() }) {
                Icon(Icons.Filled.Refresh, contentDescription = null, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(4.dp))
                Text("Generate password")
            }
            Spacer(Modifier.height(12.dp))
            LabeledField("Website", url, { url = it }, keyboardType = KeyboardType.Uri)
            Spacer(Modifier.height(12.dp))
            LabeledField("Folder", folder, { folder = it })
            Spacer(Modifier.height(12.dp))
            LabeledField("Notes", notes, { notes = it }, singleLine = false)
        }
    }
}

@Composable
private fun BackupPasswordDialog(title: String, confirmLabel: String, onDismiss: () -> Unit, onConfirm: (String) -> Unit) {
    var password by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = {
            Column {
                Text("This can differ from your master password. It's unrecoverable, so remember it.", style = MaterialTheme.typography.bodySmall)
                Spacer(Modifier.height(12.dp))
                PasswordField("Backup password", password, { password = it })
            }
        },
        confirmButton = {
            TextButton(enabled = PasswordPolicy.isAcceptable(password), onClick = { onConfirm(password) }) { Text(confirmLabel) }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

// --------------------------------------------------------------- small bits

@Composable
private fun CenteredColumn(content: @Composable ColumnScope.() -> Unit) {
    Column(
        Modifier.fillMaxSize().padding(24.dp),
        verticalArrangement = Arrangement.Center,
        content = content,
    )
}

@Composable
private fun PasswordField(label: String, value: String, onValueChange: (String) -> Unit, onDone: (() -> Unit)? = null) {
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        label = { Text(label) },
        singleLine = true,
        visualTransformation = PasswordVisualTransformation(),
        keyboardOptions = KeyboardOptions(
            keyboardType = KeyboardType.Password,
            imeAction = if (onDone != null) ImeAction.Done else ImeAction.Default,
        ),
        keyboardActions = KeyboardActions(onDone = { onDone?.invoke() }),
        modifier = Modifier.fillMaxWidth(),
    )
}

@Composable
private fun LabeledField(
    label: String,
    value: String,
    onValueChange: (String) -> Unit,
    keyboardType: KeyboardType = KeyboardType.Text,
    singleLine: Boolean = true,
) {
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        label = { Text(label) },
        singleLine = singleLine,
        keyboardOptions = KeyboardOptions(keyboardType = keyboardType),
        modifier = Modifier.fillMaxWidth(),
    )
}

@Composable
private fun HelperText(text: String) {
    Text(text, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
}

private fun queryDisplayName(context: android.content.Context, uri: Uri): String? {
    return context.contentResolver.query(uri, null, null, null, null)?.use { cursor ->
        val idx = cursor.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME)
        if (idx >= 0 && cursor.moveToFirst()) cursor.getString(idx) else null
    }
}

// ------------------------------------------------------- launcher wrappers

@Composable
private fun rememberLauncherForCreateDocument(onResult: (Uri?) -> Unit): (String) -> Unit {
    val launcher = androidx.activity.compose.rememberLauncherForActivityResult(
        ActivityResultContracts.CreateDocument("application/octet-stream"),
        onResult,
    )
    return { suggestedName -> launcher.launch(suggestedName) }
}

@Composable
private fun rememberLauncherForOpenDocument(onResult: (Uri?) -> Unit): (Array<String>) -> Unit {
    val launcher = androidx.activity.compose.rememberLauncherForActivityResult(
        ActivityResultContracts.OpenDocument(),
        onResult,
    )
    return { mimeTypes -> launcher.launch(mimeTypes) }
}
