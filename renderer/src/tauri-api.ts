/**
 * Tauri API Adapter
 *
 * Provides the same `window.api` interface as Electron's preload.ts,
 * but routes calls through Tauri's invoke() and event system.
 *
 * This file is loaded ONLY when running under Tauri (detected by __TAURI__).
 * When running under Electron, the original preload bridge is used.
 */

// Dynamic import — only resolves when Tauri runtime is present
const tauriCore = () => import('@tauri-apps/api/core')
const tauriEvent = () => import('@tauri-apps/api/event')

type UnlistenFn = () => void

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke: tauriInvoke } = await tauriCore()
  return tauriInvoke<T>(cmd, args)
}

async function listen<T>(event: string, handler: (payload: T) => void): Promise<UnlistenFn> {
  const { listen: tauriListen } = await tauriEvent()
  const unlisten = await tauriListen<T>(event, (ev) => handler(ev.payload))
  return unlisten
}

export function createTauriApi(): typeof window.api {
  return {
    // ── Check Claude CLI ──
    checkClaudeCli: () => invoke('check_claude_cli'),

    // ── State & Workspace ──
    loadState: () => invoke('load_state'),
    createWorkspace: (name: string) => invoke('create_workspace', { name }),
    renameWorkspace: (id: string, name: string) =>
      invoke('rename_workspace', { id, name }),
    removeWorkspace: (id: string) => invoke('remove_workspace', { id }),
    setActiveWorkspace: (id: string) =>
      invoke('set_active_workspace', { id }),

    // ── Folder ──
    pickFolder: (workspaceId: string) =>
      invoke('pick_folder', { workspaceId }),
    removeFolder: (workspaceId: string, folderPath: string) =>
      invoke('remove_folder', { workspaceId, folderPath }),
    listOctos: (folderPath: string) =>
      invoke('list_octos', { folderPath }),
    loadHistory: (folderPath: string) =>
      invoke('load_history', { folderPath }),
    loadHistoryPaged: (params: { folderPath: string; limit: number; beforeTs?: number }) =>
      invoke('load_history_paged', {
        folderPath: params.folderPath,
        limit: params.limit,
        beforeTs: params.beforeTs ?? null,
      }),
    appendUserMessage: (params: {
      folderPath: string
      message: { id: string; ts: number; text: string; attachments?: any[] }
    }) =>
      invoke('append_user_message', {
        folderPath: params.folderPath,
        id: params.message.id,
        ts: params.message.ts,
        text: params.message.text,
        attachments: params.message.attachments ?? null,
      }),
    readPendingState: (folderPath: string) =>
      invoke('read_pending_state', { folderPath }),
    writePendingState: (folderPath: string, state: Record<string, any>) =>
      invoke('write_pending_state', { folderPath, state }),

    // ── Octo CRUD ──
    createOcto: (params) =>
      invoke('create_octo', {
        folderPath: params.folderPath,
        name: params.name,
        role: params.role,
        prompt: params.prompt ?? null,
        icon: params.icon ?? null,
        color: params.color ?? null,
        permissions: params.permissions ?? null,
        mcpServers: params.mcpServers ?? null,
        // Phase 6 — undefined ⇒ omit field from config.json (inherits
        // workspace default at turn time).
        provider: params.provider ?? null,
        model: params.model ?? null,
      }),
    updateOcto: (params) =>
      invoke('update_octo', {
        octoPath: params.octoPath,
        name: params.name ?? null,
        role: params.role ?? null,
        prompt: params.prompt ?? null,
        icon: params.icon ?? null,
        color: params.color ?? null,
        permissions: params.permissions ?? null,
        mcpServers: params.mcpServers ?? null,
        // Phase 6 — 3-state forwarding:
        //   undefined → null on the wire ⇒ Rust treats as None ⇒ don't touch
        //   ""        → "" on the wire ⇒ Rust removes the field
        //   "<value>" → "<value>" ⇒ Rust sets the field
        provider: params.provider ?? null,
        model: params.model ?? null,
      }),
    deleteOcto: (octoPath: string) => invoke('delete_octo', { octoPath }),
    readAgentPrompt: (octoPath: string) => invoke('read_agent_prompt', { octoPath }),

    // ── Agent Execution ──
    sendMessage: (params) =>
      invoke('send_message', {
        folderPath: params.folderPath,
        octoPath: params.octoPath,
        prompt: params.prompt,
        userTs: params.userTs,
        runId: params.runId,
        pendingId: params.pendingId ?? null,
        peers: params.peers ?? null,
        collaborators: params.collaborators ?? null,
        isLeader: params.isLeader ?? null,
        imagePaths: params.imagePaths ?? null,
        textPaths: params.textPaths ?? null,
        model: params.model ?? null,
      }),

    // ── Events (push from backend) ──
    onActivity: (cb) => {
      let unlisten: UnlistenFn | null = null
      listen<{ runId: string; text: string; folderPath?: string; agentName?: string }>('octo:activity', cb).then(
        (u) => (unlisten = u),
      )
      return () => unlisten?.()
    },
    onTextChunk: (cb) => {
      let unlisten: UnlistenFn | null = null
      listen<{ runId: string; delta: string; folderPath?: string; agentName?: string }>('octo:textChunk', cb).then(
        (u) => (unlisten = u),
      )
      return () => unlisten?.()
    },
    onActivityLog: (cb) => {
      let unlisten: UnlistenFn | null = null
      listen('activity:log', cb).then((u) => (unlisten = u))
      return () => unlisten?.()
    },
    onUsageReport: (cb) => {
      let unlisten: UnlistenFn | null = null
      listen('octo:usage', cb).then((u) => (unlisten = u))
      return () => unlisten?.()
    },
    onOctosChanged: (cb) => {
      let unlisten: UnlistenFn | null = null
      listen<string>('folder:octosChanged', cb).then((u) => (unlisten = u))
      return () => unlisten?.()
    },
    onMcpTokenExpiry: (cb) => {
      let unlisten: UnlistenFn | null = null
      listen('mcp:tokenExpiry', cb).then((u) => (unlisten = u))
      return () => unlisten?.()
    },
    onFileAccessRequest: (cb) => {
      let unlisten: UnlistenFn | null = null
      listen('fileAccess:request', cb).then((u) => (unlisten = u))
      return () => unlisten?.()
    },
    onWindowLimitReached: (cb) => {
      let unlisten: UnlistenFn | null = null
      listen<number>('window:limitReached', cb).then((u) => (unlisten = u))
      return () => unlisten?.()
    },

    // ── Dispatch ──
    dispatch: (params) =>
      invoke('dispatcher_route', {
        message: params.message,
        agents: params.agents,
        recentHistory: params.recentHistory,
        folderPath: params.folderPath ?? null,
      }),

    // ── File operations ──
    saveFile: (params) =>
      invoke('save_file', {
        folderPath: params.folderPath,
        fileName: params.fileName,
        data: params.data,
        mimeType: params.mimeType,
      }),
    readFileBase64: (params) =>
      invoke('read_file_base64', {
        folderPath: params.folderPath,
        relativePath: params.relativePath,
      }),
    getAbsolutePath: (params) =>
      invoke('get_absolute_path', {
        folderPath: params.folderPath,
        relativePath: params.relativePath,
      }),
    readDroppedFile: (params) => invoke('read_dropped_file', { path: params.path }),

    // ── Wiki ──
    wikiList: (workspaceId: string) =>
      invoke('wiki_list', { workspaceId }),
    wikiRead: (params) =>
      invoke('wiki_read', {
        workspaceId: params.workspaceId,
        name: params.name,
      }),
    wikiWrite: (params) =>
      invoke('wiki_write', {
        workspaceId: params.workspaceId,
        name: params.name,
        content: params.content,
      }),
    wikiDelete: (params) =>
      invoke('wiki_delete', {
        workspaceId: params.workspaceId,
        name: params.name,
      }),

    // ── Agent control ──
    stopAgent: (runId: string) => invoke('stop_agent', { runId }),
    stopAllAgents: () => invoke('stop_all_agents'),

    getPlatform: () => invoke('get_platform'),

    // ── MCP ──
    mcpHealthCheck: (params) =>
      invoke('mcp_health_check', { mcpServers: params.mcpServers }),
    mcpInstallPackage: (params) =>
      invoke('mcp_install_package', { packageName: params.packageName }),

    // ── File Access ──
    respondFileAccess: (params) =>
      invoke('respond_file_access', {
        requestId: params.requestId,
        decision: params.decision,
        targetPath: params.targetPath ?? null,
        projectFolder: params.projectFolder ?? null,
      }),

    // ── Settings ──
    loadSettings: () => invoke('load_settings'),
    saveSettings: (settings) => invoke('save_settings', { settings }),
    getVersion: () => invoke('get_version'),

    // ── Phase 4: API keys (keyring-backed) ──
    // No `loadApiKey` — by design. Keys flow Rust-internal only.
    saveApiKey: (provider, key) =>
      invoke('save_api_key_cmd', { provider, key }),
    deleteApiKey: (provider) => invoke('delete_api_key_cmd', { provider }),
    hasApiKey: (provider) => invoke('has_api_key_cmd', { provider }),
    keyringAvailable: () => invoke('keyring_available_cmd'),
    keyringStatus: () => invoke('keyring_status_cmd'),
    testProviderConnection: (provider) =>
      invoke('test_provider_connection', { provider }),
    getProvidersManifest: () => invoke('get_providers_manifest'),

    // ── Phase 5a — Claude CLI subscription ──
    detectClaude: () => invoke('detect_claude'),
    // Phase 5a-finalize §3.2 — generic binary detection for any
    // CLI-subscription provider. Driven by providers.json's
    // `authMethods[].detectBinary`. detectClaude above is a
    // back-compat alias the Anthropic card still uses.
    detectBinary: (name) => invoke('detect_binary', { name }),
    setAuthMode: (provider, mode) =>
      invoke('set_auth_mode_cmd', { provider, mode }),
    clearAuthMode: (provider) =>
      invoke('clear_auth_mode_cmd', { provider }),
    getAuthMode: (provider) =>
      invoke('get_auth_mode_cmd', { provider }),

    // ── Model probe ──
    getBestOpusModel: () => invoke('get_best_opus_model'),
    reprobeBestOpusModel: () => invoke('reprobe_best_opus_model'),

    // ── Multi-window ──
    newWindow: () => invoke('new_window'),
    getWindowCount: () => invoke('get_window_count'),
    // ── Backup / Revert ──
    listBackups: (folderPath: string) => invoke('list_backups', { folderPath }),
    readBackupFile: (params) =>
      invoke('read_backup_file', {
        folderPath: params.folderPath,
        backupId: params.backupId,
        filePath: params.filePath,
      }),
    readCurrentFile: (params) =>
      invoke('read_current_file', {
        folderPath: params.folderPath,
        filePath: params.filePath,
      }),
    revertBackup: (params) =>
      invoke('revert_backup', {
        folderPath: params.folderPath,
        backupId: params.backupId,
        filePath: params.filePath ?? null,
      }),
    pruneBackups: (folderPath: string) => invoke('prune_backups', { folderPath }),
  }
}

/**
 * Detect runtime and install the appropriate API bridge.
 * Call this from main.tsx before rendering.
 */
export function installApiAdapter() {
  // Check if we're running in Tauri
  if ('__TAURI__' in window || '__TAURI_INTERNALS__' in window) {
    console.log('[Octopal] Running in Tauri — installing Tauri API adapter')
    ;(window as any).api = createTauriApi()

    // Set up window drag for elements with `.drag` class
    // Tauri v2 on macOS needs explicit startDragging() call
    setupTauriDragRegions()
  }
  // Otherwise, Electron's preload.ts already set up window.api
}

/**
 * Attach mousedown listeners to `.drag` elements so Tauri can drag the window.
 * Uses MutationObserver to handle dynamically added elements.
 */
function setupTauriDragRegions() {
  // Pre-load the window module so the mousedown handler can call startDragging()
  // synchronously. macOS requires startDragging() to be invoked while [NSApp currentEvent]
  // is still the mousedown — any await on a cold dynamic import drops that gesture and
  // the window will not move (especially noticeable on freshly opened webview windows
  // where the chunk is not yet cached).
  let currentWindow: { startDragging: () => Promise<void> } | null = null
  import('@tauri-apps/api/window')
    .then((mod) => {
      currentWindow = mod.getCurrentWindow()
    })
    .catch(() => {
      // Ignore — may not be available
    })

  const attachDrag = (el: Element) => {
    if ((el as any).__tauriDrag) return
    ;(el as any).__tauriDrag = true
    el.addEventListener('mousedown', (e: Event) => {
      const me = e as MouseEvent
      // Don't drag if clicking on interactive elements
      const target = me.target as HTMLElement
      if (
        target.closest('button, input, select, textarea, a, [role="button"]') ||
        target.closest('[style*="no-drag"]') ||
        getComputedStyle(target).getPropertyValue('-webkit-app-region') === 'no-drag'
      ) {
        return
      }
      // Only left mouse button
      if (me.button !== 0) return
      // Fire-and-forget — must NOT await before startDragging(), or the OS-level
      // mousedown event will already be gone by the time the call reaches AppKit.
      currentWindow?.startDragging().catch(() => {
        // Ignore — may not be available
      })
    })
  }

  // Attach to existing elements
  const init = () => {
    Array.from(document.querySelectorAll('.drag')).forEach(attachDrag)

    // Watch for new `.drag` elements
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of Array.from(mutation.addedNodes)) {
          if (node instanceof HTMLElement) {
            if (node.classList?.contains('drag')) attachDrag(node)
            Array.from(node.querySelectorAll('.drag')).forEach(attachDrag)
          }
        }
      }
    })
    observer.observe(document.body, { childList: true, subtree: true })
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init)
  } else {
    init()
  }
}
