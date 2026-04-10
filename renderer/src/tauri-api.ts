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

    // ── Octo CRUD ──
    createOcto: (params) =>
      invoke('create_octo', {
        folderPath: params.folderPath,
        name: params.name,
        role: params.role,
        icon: params.icon ?? null,
        color: params.color ?? null,
        permissions: params.permissions ?? null,
        mcpServers: params.mcpServers ?? null,
      }),
    updateOcto: (params) =>
      invoke('update_octo', {
        octoPath: params.octoPath,
        name: params.name ?? null,
        role: params.role ?? null,
        icon: params.icon ?? null,
        color: params.color ?? null,
        permissions: params.permissions ?? null,
        mcpServers: params.mcpServers ?? null,
      }),
    deleteOcto: (octoPath: string) => invoke('delete_octo', { octoPath }),

    // ── Agent Execution ──
    sendMessage: (params) =>
      invoke('send_message', {
        folderPath: params.folderPath,
        octoPath: params.octoPath,
        prompt: params.prompt,
        userTs: params.userTs,
        runId: params.runId,
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
      listen<{ runId: string; text: string }>('octo:activity', cb).then(
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
    onGitMergeConflict: (cb) => {
      let unlisten: UnlistenFn | null = null
      listen('git:mergeConflict', cb).then((u) => (unlisten = u))
      return () => unlisten?.()
    },
    onGitInterruptRollback: (cb) => {
      let unlisten: UnlistenFn | null = null
      listen('git:interruptRollback', cb).then((u) => (unlisten = u))
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

    // ── Dispatch & Observer ──
    dispatch: (params) =>
      invoke('dispatcher_route', {
        message: params.message,
        agents: params.agents,
        recentHistory: params.recentHistory,
        folderPath: params.folderPath ?? null,
      }),
    observerUpdate: (params) =>
      invoke('observer_update', {
        folderPath: params.folderPath,
        agentName: params.message.agentName,
        text: params.message.text,
        ts: params.message.ts,
      }),
    observerGetContext: (folderPath: string) =>
      invoke('observer_get_context', { folderPath }),
    observerReset: (folderPath: string) =>
      invoke('observer_reset', { folderPath }),

    // ── SmartObserver ──
    smartObserverGetContext: (folderPath: string) =>
      invoke('smart_observer_get_context', { folderPath }),
    smartObserverForceRefresh: (folderPath: string) =>
      invoke('smart_observer_force_refresh', { folderPath }),
    smartObserverSetEnabled: (enabled: boolean) =>
      invoke('smart_observer_set_enabled', { enabled }),
    smartObserverSetModel: (model: string) =>
      invoke('smart_observer_set_model', { model }),
    smartObserverGetModel: () => invoke('smart_observer_get_model'),
    smartObserverGetMetrics: () => invoke('smart_observer_get_metrics'),

    classifyMention: (params) =>
      invoke('classify_mention', {
        speakerName: params.speakerName,
        speakerText: params.speakerText,
        mentionedNames: params.mentionedNames,
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

    checkContext: (params) =>
      invoke('dispatcher_check_context', {
        originalPrompt: params.originalPrompt,
        newMessage: params.newMessage,
        agentName: params.agentName,
      }),

    getPlatform: () => invoke('get_platform'),

    // ── MCP ──
    mcpHealthCheck: (params) =>
      invoke('mcp_health_check', { mcpServers: params.mcpServers }),
    mcpInstallPackage: (params) =>
      invoke('mcp_install_package', { packageName: params.packageName }),

    // ── Git ──
    gitGetHistory: (params) =>
      invoke('git_get_history', {
        folderPath: params.folderPath,
        page: params.page ?? null,
        perPage: params.perPage ?? null,
      }),
    gitGetDiff: (params) =>
      invoke('git_get_diff', {
        folderPath: params.folderPath,
        hash: params.hash,
      }),
    gitRevert: (params) =>
      invoke('git_revert', {
        folderPath: params.folderPath,
        hash: params.hash,
        toHash: params.toHash ?? null,
      }),
    gitPush: (params) =>
      invoke('git_push', { folderPath: params.folderPath }),
    gitHasRemote: (params) =>
      invoke('git_has_remote', { folderPath: params.folderPath }),

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

    // ── Multi-window ──
    newWindow: () => invoke('new_window'),
    getWindowCount: () => invoke('get_window_count'),
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
  const attachDrag = (el: Element) => {
    if ((el as any).__tauriDrag) return
    ;(el as any).__tauriDrag = true
    el.addEventListener('mousedown', async (e: Event) => {
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
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window')
        await getCurrentWindow().startDragging()
      } catch {
        // Ignore — may not be available
      }
    })
  }

  // Attach to existing elements
  const init = () => {
    document.querySelectorAll('.drag').forEach(attachDrag)

    // Watch for new `.drag` elements
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node instanceof HTMLElement) {
            if (node.classList?.contains('drag')) attachDrag(node)
            node.querySelectorAll?.('.drag').forEach(attachDrag)
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
