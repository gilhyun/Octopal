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

interface OctoFile {
  path: string
  name: string
  role: string
  icon: string
  color?: string
  hidden?: boolean
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

interface ObserverMetrics {
  totalCalls: number
  successes: number
  parseFailures: number
  validationFailures: number
  timeouts: number
  errors: number
  avgLatencyMs: number
  lastSuccessAt: number | null
  lastFailureReason: string | null
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
    observerModel: 'sonnet' | 'opus'
    defaultAgentModel: 'sonnet' | 'opus'
    autoModelSelection: boolean
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
    createOcto: (params: { folderPath: string; name: string; role: string; icon?: string; color?: string; permissions?: OctoPermissions; mcpServers?: McpServersConfig }) =>
      Promise<{ ok: true; path: string } | { ok: false; error: string }>
    updateOcto: (params: {
      octoPath: string
      name?: string
      role?: string
      icon?: string
      color?: string
      permissions?: OctoPermissions
      mcpServers?: McpServersConfig | null
    }) => Promise<{ ok: true; path: string } | { ok: false; error: string }>
    deleteOcto: (octoPath: string) =>
      Promise<{ ok: true } | { ok: false; error: string }>
    sendMessage: (params: {
      folderPath: string
      octoPath: string
      prompt: string
      userTs: number
      runId: string
      peers?: Array<{ name: string; role: string }>
      collaborators?: Array<{ name: string; role: string }>
      isLeader?: boolean
      imagePaths?: string[]
      textPaths?: string[]
      model?: 'sonnet' | 'opus'
    }) => Promise<{ ok: true; output: string } | { ok: false; error: string }>
    onActivity: (cb: (data: { runId: string; text: string }) => void) => () => void
    onActivityLog: (
      cb: (data: {
        folderPath: string
        agentName: string
        tool: string
        target: string
        ts: number
      }) => void,
    ) => () => void
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

    // Observer
    observerUpdate: (params: {
      folderPath: string
      message: { agentName: string; text: string; ts: number; mentions?: string[] }
    }) => Promise<{ ok: true }>
    observerGetContext: (folderPath: string) => Promise<{
      ok: true
      context: {
        currentTopic: string | null
        recentTopics: string[]
        agentActivity: Record<string, {
          lastActiveTs: number
          messageCount: number
          lastWorkingOn: string
          recentKeywords: string[]
        }>
        pendingMentions: string[]
        conversationPhase: 'idle' | 'planning' | 'implementation' | 'review' | 'discussion'
        messageCount: number
        lastRespondent: string | null
        lastActivityTs: number
      }
    }>
    observerReset: (folderPath: string) => Promise<{ ok: true }>

    // SmartObserver (Layer 1 — LLM-powered context tracker)
    smartObserverGetContext: (folderPath: string) => Promise<{
      ok: true
      context: {
        rule: {
          currentTopic: string | null
          recentTopics: string[]
          agentActivity: Record<string, {
            lastActiveTs: number
            messageCount: number
            lastWorkingOn: string
            recentKeywords: string[]
          }>
          pendingMentions: string[]
          conversationPhase: 'idle' | 'planning' | 'implementation' | 'review' | 'discussion'
          messageCount: number
          lastRespondent: string | null
          lastActivityTs: number
        }
        llm: {
          conversationSummary: string
          currentTopic: string
          topicHistory: string[]
          conversationPhase: string
          agentContext: Record<string, {
            workingOn: string
            lastContribution: string
          }>
          userIntent: string
          openThreads: string[]
          updatedAt: number
        } | null
      }
    }>
    smartObserverForceRefresh: (folderPath: string) => Promise<
      | { ok: true; llm: any }
      | { ok: false; error: string }
    >
    smartObserverSetEnabled: (enabled: boolean) => Promise<{ ok: true }>
    smartObserverSetModel: (model: string) => Promise<
      | { ok: true; model: string }
      | { ok: false; error: string }
    >
    smartObserverGetModel: () => Promise<{ ok: true; model: string }>
    smartObserverGetMetrics: () => Promise<{ ok: true; metrics: ObserverMetrics }>

    classifyMention: (params: {
      speakerName: string
      speakerText: string
      mentionedNames: string[]
    }) => Promise<
      | { ok: true; decision: 'handoff' | 'approval' | 'ignore'; reason?: string }
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
