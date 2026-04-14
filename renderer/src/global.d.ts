interface OctoPermissions {
  fileWrite?: boolean
  bash?: boolean
  network?: boolean
  allowPaths?: string[]
  denyPaths?: string[]
}

interface McpServerConfig {
  command: string
  args?: string[]
  env?: Record<string, string>
}

interface McpServersConfig {
  [serverName: string]: McpServerConfig
}

type McpStatus = 'ok' | 'error' | 'checking'

interface OctoFile {
  path: string
  name: string
  role: string
  icon: string
  color?: string
  hidden?: boolean
  /**
   * When true, this agent is excluded from the dispatcher's auto-routing
   * and from other agents' peer lists. It can only be reached via an
   * explicit `@mention` in the user's message, and it never sees shared
   * room history or other peers. Used for single-shot research/analysis
   * agents that shouldn't pollute the group conversation.
   */
  isolated?: boolean
  permissions?: OctoPermissions | null
  mcpServers?: McpServersConfig | null
}

interface Workspace {
  id: string
  name: string
  folders: string[]
}

interface AppState {
  workspaces: Workspace[]
  activeWorkspaceId: string | null
}

interface HistoryMessage {
  id: string
  agentName: string
  text: string
  ts: number
}

interface TextShortcut {
  trigger: string
  expansion: string
  description?: string
}

interface AppSettings {
  general: {
    restoreLastWorkspace: boolean
    launchAtLogin: boolean
    language: string
  }
  agents: {
    defaultPermissions: {
      fileWrite: boolean
      bash: boolean
      network: boolean
    }
  }
  appearance: {
    chatFontSize: number
  }
  shortcuts: {
    textExpansions: TextShortcut[]
  }
  advanced: {
    defaultAgentModel: 'sonnet' | 'opus' | 'haiku'
    autoModelSelection: boolean
  }
  backup?: {
    maxBackupsPerWorkspace: number
    maxAgeDays: number
  }
}

interface Window {
  api: {
    loadState: () => Promise<AppState>
    createWorkspace: (name: string) => Promise<AppState>
    renameWorkspace: (id: string, name: string) => Promise<AppState>
    removeWorkspace: (id: string) => Promise<AppState>
    setActiveWorkspace: (id: string) => Promise<AppState>
    pickFolder: (workspaceId: string) => Promise<string | null>
    removeFolder: (workspaceId: string, folderPath: string) => Promise<AppState>
    listOctos: (folderPath: string) => Promise<OctoFile[]>
    loadHistory: (folderPath: string) => Promise<HistoryMessage[]>
    loadHistoryPaged: (params: { folderPath: string; limit: number; beforeTs?: number }) =>
      Promise<{ messages: HistoryMessage[]; hasMore: boolean }>
    appendUserMessage: (params: {
      folderPath: string
      message: { id: string; ts: number; text: string; attachments?: any[] }
    }) => Promise<{ ok: true }>
    readPendingState: (folderPath: string) => Promise<Record<string, any>>
    writePendingState: (folderPath: string, state: Record<string, any>) => Promise<void>

    createOcto: (params: { folderPath: string; name: string; role: string; prompt?: string; icon?: string; color?: string; permissions?: OctoPermissions; mcpServers?: McpServersConfig }) =>
      Promise<{ ok: true; path: string } | { ok: false; error: string }>
    updateOcto: (params: {
      octoPath: string
      name?: string
      role?: string
      prompt?: string
      icon?: string
      color?: string
      permissions?: OctoPermissions
      mcpServers?: McpServersConfig | null
    }) => Promise<{ ok: true; path: string } | { ok: false; error: string }>
    deleteOcto: (octoPath: string) =>
      Promise<{ ok: true } | { ok: false; error: string }>
    readAgentPrompt: (octoPath: string) =>
      Promise<{ ok: true; path: string } | { ok: false; error: string }>
    sendMessage: (params: {
      folderPath: string
      octoPath: string
      prompt: string
      userTs: number
      runId: string
      /**
       * UI-side ID of the pending assistant bubble that this response will
       * fill in. When provided, the backend persists the assistant message
       * under the same ID in `room-history.json` so the folder watcher's
       * history reload can reconcile with the in-memory bubble instead of
       * producing a duplicate.
       */
      pendingId?: string
      peers?: Array<{ name: string; role: string }>
      collaborators?: Array<{ name: string; role: string }>
      isLeader?: boolean
      imagePaths?: string[]
      textPaths?: string[]
      model?: 'sonnet' | 'opus'
    }) => Promise<{ ok: true; output: string; usage?: import('./types').TokenUsage } | { ok: false; error: string }>
    onActivity: (cb: (data: { runId: string; text: string; folderPath?: string; agentName?: string }) => void) => () => void
    onActivityLog: (
      cb: (data: {
        folderPath: string
        agentName: string
        tool: string
        target: string
        ts: number
        backupId?: string
        conflictWith?: { runId: string; agentName: string; acquiredAtMs: number }
      }) => void,
    ) => () => void

    // Backup / Revert
    listBackups: (folderPath: string) => Promise<Array<{
      id: string
      runId: string
      agentName: string
      ts: number
      folderPath: string
      files: Array<{ path: string; existed: boolean }>
    }>>
    readBackupFile: (params: {
      folderPath: string
      backupId: string
      filePath: string
    }) => Promise<string>
    readCurrentFile: (params: {
      folderPath: string
      filePath: string
    }) => Promise<string>
    revertBackup: (params: {
      folderPath: string
      backupId: string
      filePath?: string
    }) => Promise<{ ok: boolean; reverted: string[]; failed: string[] }>
    pruneBackups: (folderPath: string) => Promise<number>
    onUsageReport: (
      cb: (data: {
        runId: string
        usage: {
          inputTokens: number
          outputTokens: number
          cacheReadTokens?: number
          cacheCreationTokens?: number
          costUsd?: number
          durationMs?: number
          model?: string
        }
      }) => void,
    ) => () => void
    dispatch: (params: {
      message: string
      agents: Array<{ name: string; role: string }>
      recentHistory: Array<{ agentName: string; text: string }>
      folderPath?: string
    }) => Promise<
      | { ok: true; leader: string; collaborators: string[]; model?: 'sonnet' | 'opus' }
      | { ok: false; error: string }
    >

    onOctosChanged: (cb: (folderPath: string) => void) => () => void
    saveFile: (params: {
      folderPath: string
      fileName: string
      data: string
      mimeType: string
    }) => Promise<
      | { ok: true; attachment: { id: string; type: string; filename: string; path: string; mimeType: string; size: number } }
      | { ok: false; error: string }
    >
    readFileBase64: (params: {
      folderPath: string
      relativePath: string
    }) => Promise<{ ok: true; data: string } | { ok: false; error: string }>
    getAbsolutePath: (params: {
      folderPath: string
      relativePath: string
    }) => Promise<string>
    readDroppedFile: (params: { path: string }) => Promise<{
      filename: string
      data: string
      mimeType: string
      size: number
    }>
    wikiList: (workspaceId: string) => Promise<
      Array<{ name: string; path: string; size: number; mtime: number }>
    >
    wikiRead: (params: { workspaceId: string; name: string }) => Promise<
      { ok: true; content: string } | { ok: false; error: string }
    >
    wikiWrite: (params: { workspaceId: string; name: string; content: string }) => Promise<
      { ok: true; name: string } | { ok: false; error: string }
    >
    wikiDelete: (params: { workspaceId: string; name: string }) => Promise<
      { ok: true } | { ok: false; error: string }
    >
    stopAllAgents: () => Promise<{ ok: true; stopped: number }>
    getPlatform: () => Promise<string>

    // MCP Health Check & Install
    mcpHealthCheck: (params: {
      mcpServers: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>
    }) => Promise<{
      ok: true
      results: Record<string, {
        status: 'ok' | 'package_missing' | 'spawn_error' | 'timeout'
        error?: string
        packageName?: string
      }>
    } | { ok: false; error: string }>
    mcpInstallPackage: (params: { packageName: string }) =>
      Promise<{ ok: boolean; error?: string }>
    onMcpTokenExpiry: (
      cb: (data: { agentName: string; serverName: string; message: string }) => void,
    ) => () => void

    // File Access Approval
    onFileAccessRequest: (
      cb: (data: {
        requestId: string
        agentName: string
        targetPath: string
        reason?: string
        blocked?: boolean
      }) => void,
    ) => () => void
    respondFileAccess: (params: {
      requestId: string
      decision: 'allow_once' | 'allow_always' | 'deny'
      targetPath?: string
      projectFolder?: string
    }) => Promise<void>

    // Settings
    loadSettings: () => Promise<AppSettings>
    saveSettings: (settings: AppSettings) => Promise<{ ok: true }>
    getVersion: () => Promise<{ version: string; electron: string; node: string }>

    // Multi-window
    newWindow: () => Promise<{ ok: true; windowId: number } | { ok: false; error: string }>
    getWindowCount: () => Promise<{ count: number; max: number }>
    onWindowLimitReached: (cb: (maxWindows: number) => void) => () => void
  }
}

interface WikiPage {
  name: string
  path: string
  size: number
  mtime: number
}
