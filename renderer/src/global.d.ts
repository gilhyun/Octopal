interface RunePermissions {
  fileWrite?: boolean
  bash?: boolean
  network?: boolean
  allowPaths?: string[]
  denyPaths?: string[]
}

interface RuneFile {
  path: string
  name: string
  role: string
  icon: string
  color?: string
  permissions?: RunePermissions | null
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

interface Window {
  api: {
    loadState: () => Promise<AppState>
    createWorkspace: (name: string) => Promise<AppState>
    renameWorkspace: (id: string, name: string) => Promise<AppState>
    removeWorkspace: (id: string) => Promise<AppState>
    setActiveWorkspace: (id: string) => Promise<AppState>
    pickFolder: (workspaceId: string) => Promise<string | null>
    removeFolder: (workspaceId: string, folderPath: string) => Promise<AppState>
    listRunes: (folderPath: string) => Promise<RuneFile[]>
    loadHistory: (folderPath: string) => Promise<HistoryMessage[]>
    appendUserMessage: (params: {
      folderPath: string
      message: { id: string; ts: number; text: string; attachments?: any[] }
    }) => Promise<{ ok: true }>
    createRune: (params: { folderPath: string; name: string; role: string; icon?: string; color?: string; permissions?: RunePermissions }) =>
      Promise<{ ok: true; path: string } | { ok: false; error: string }>
    updateRune: (params: {
      runePath: string
      name?: string
      role?: string
      icon?: string
      color?: string
      permissions?: RunePermissions
    }) => Promise<{ ok: true; path: string } | { ok: false; error: string }>
    deleteRune: (runePath: string) =>
      Promise<{ ok: true } | { ok: false; error: string }>
    sendMessage: (params: {
      folderPath: string
      runePath: string
      prompt: string
      userTs: number
      runId: string
      peers?: Array<{ name: string; role: string }>
      collaborators?: Array<{ name: string; role: string }>
      isLeader?: boolean
      imagePaths?: string[]
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
    dispatch: (params: {
      message: string
      agents: Array<{ name: string; role: string }>
      recentHistory: Array<{ agentName: string; text: string }>
    }) => Promise<
      | { ok: true; leader: string; collaborators: string[] }
      | { ok: false; error: string }
    >
    classifyMention: (params: {
      speakerName: string
      speakerText: string
      mentionedNames: string[]
    }) => Promise<
      | { ok: true; decision: 'handoff' | 'approval' | 'ignore'; reason?: string }
      | { ok: false; error: string }
    >
    onRunesChanged: (cb: (folderPath: string) => void) => () => void
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
    wikiList: (folderPath: string) => Promise<
      Array<{ name: string; path: string; size: number; mtime: number }>
    >
    wikiRead: (params: { folderPath: string; name: string }) => Promise<
      { ok: true; content: string } | { ok: false; error: string }
    >
    wikiWrite: (params: { folderPath: string; name: string; content: string }) => Promise<
      { ok: true; name: string } | { ok: false; error: string }
    >
    wikiDelete: (params: { folderPath: string; name: string }) => Promise<
      { ok: true } | { ok: false; error: string }
    >
  }
}

interface WikiPage {
  name: string
  path: string
  size: number
  mtime: number
}
