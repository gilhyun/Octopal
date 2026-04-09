import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('api', {
  checkClaudeCli: () => ipcRenderer.invoke('claude:checkLogin') as Promise<{ installed: boolean; loggedIn: boolean }>,
  loadState: () => ipcRenderer.invoke('state:load'),
  createWorkspace: (name: string) => ipcRenderer.invoke('workspace:create', name),
  renameWorkspace: (id: string, name: string) =>
    ipcRenderer.invoke('workspace:rename', { id, name }),
  removeWorkspace: (id: string) => ipcRenderer.invoke('workspace:remove', id),
  setActiveWorkspace: (id: string) => ipcRenderer.invoke('workspace:setActive', id),
  pickFolder: (workspaceId: string) => ipcRenderer.invoke('folder:pick', workspaceId),
  removeFolder: (workspaceId: string, folderPath: string) =>
    ipcRenderer.invoke('folder:remove', { workspaceId, folderPath }),
  listOctos: (folderPath: string) => ipcRenderer.invoke('folder:listOctos', folderPath),
  loadHistory: (folderPath: string) => ipcRenderer.invoke('folder:loadHistory', folderPath),
  loadHistoryPaged: (params: { folderPath: string; limit: number; beforeTs?: number }) =>
    ipcRenderer.invoke('folder:loadHistoryPaged', params),
  appendUserMessage: (params: {
    folderPath: string
    message: { id: string; ts: number; text: string; attachments?: any[] }
  }) => ipcRenderer.invoke('room:appendUser', params),
  createOcto: (params: { folderPath: string; name: string; role: string; icon?: string; color?: string; permissions?: any }) =>
    ipcRenderer.invoke('octo:create', params),
  updateOcto: (params: {
    octoPath: string
    name?: string
    role?: string
    icon?: string
    color?: string
    permissions?: {
      fileWrite?: boolean
      bash?: boolean
      network?: boolean
      allowPaths?: string[]
      denyPaths?: string[]
    }
  }) => ipcRenderer.invoke('octo:update', params),
  deleteOcto: (octoPath: string) => ipcRenderer.invoke('octo:delete', octoPath),
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
  }) => ipcRenderer.invoke('octo:sendMessage', params),
  onActivity: (cb: (data: { runId: string; text: string }) => void) => {
    const handler = (_event: any, data: { runId: string; text: string }) => cb(data)
    ipcRenderer.on('octo:activity', handler)
    return () => ipcRenderer.removeListener('octo:activity', handler)
  },
  onActivityLog: (
    cb: (data: {
      folderPath: string
      agentName: string
      tool: string
      target: string
      ts: number
    }) => void,
  ) => {
    const handler = (_event: any, data: any) => cb(data)
    ipcRenderer.on('activity:log', handler)
    return () => ipcRenderer.removeListener('activity:log', handler)
  },
  dispatch: (params: {
    message: string
    agents: Array<{ name: string; role: string }>
    recentHistory: Array<{ agentName: string; text: string }>
  }) => ipcRenderer.invoke('dispatcher:route', params),
  classifyMention: (params: {
    speakerName: string
    speakerText: string
    mentionedNames: string[]
  }) => ipcRenderer.invoke('mention:classify', params),
  onOctosChanged: (cb: (folderPath: string) => void) => {
    const handler = (_event: any, folderPath: string) => cb(folderPath)
    ipcRenderer.on('folder:octosChanged', handler)
    return () => ipcRenderer.removeListener('folder:octosChanged', handler)
  },
  saveFile: (params: {
    folderPath: string
    fileName: string
    data: string
    mimeType: string
  }) => ipcRenderer.invoke('file:save', params),
  readFileBase64: (params: {
    folderPath: string
    relativePath: string
  }) => ipcRenderer.invoke('file:readBase64', params),
  getAbsolutePath: (params: {
    folderPath: string
    relativePath: string
  }) => ipcRenderer.invoke('file:getAbsolutePath', params),
  wikiList: (workspaceId: string) => ipcRenderer.invoke('wiki:list', workspaceId),
  wikiRead: (params: { workspaceId: string; name: string }) =>
    ipcRenderer.invoke('wiki:read', params),
  wikiWrite: (params: { workspaceId: string; name: string; content: string }) =>
    ipcRenderer.invoke('wiki:write', params),
  wikiDelete: (params: { workspaceId: string; name: string }) =>
    ipcRenderer.invoke('wiki:delete', params),
  stopAllAgents: () => ipcRenderer.invoke('agent:stopAll'),
  getPlatform: () => ipcRenderer.invoke('app:getPlatform'),

  // ── File Access Approval ──
  onFileAccessRequest: (
    cb: (data: {
      requestId: string
      agentName: string
      targetPath: string
      reason?: string
      blocked?: boolean
    }) => void,
  ) => {
    const handler = (_event: any, data: any) => cb(data)
    ipcRenderer.on('fileAccess:request', handler)
    return () => ipcRenderer.removeListener('fileAccess:request', handler)
  },
  respondFileAccess: (params: {
    requestId: string
    decision: 'allow_once' | 'allow_always' | 'deny'
    targetPath?: string
    projectFolder?: string
  }) => ipcRenderer.invoke('fileAccess:respond', params),

  // ── Settings ──
  loadSettings: () => ipcRenderer.invoke('settings:load'),
  saveSettings: (settings: any) => ipcRenderer.invoke('settings:save', settings),
  getVersion: () => ipcRenderer.invoke('settings:getVersion'),

  // ── Multi-window ──
  newWindow: () => ipcRenderer.invoke('window:new'),
  getWindowCount: () => ipcRenderer.invoke('window:count'),
  onWindowLimitReached: (cb: (maxWindows: number) => void) => {
    const handler = (_event: any, maxWindows: number) => cb(maxWindows)
    ipcRenderer.on('window:limitReached', handler)
    return () => ipcRenderer.removeListener('window:limitReached', handler)
  },
})
