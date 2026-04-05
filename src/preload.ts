import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('api', {
  loadState: () => ipcRenderer.invoke('state:load'),
  createWorkspace: (name: string) => ipcRenderer.invoke('workspace:create', name),
  renameWorkspace: (id: string, name: string) =>
    ipcRenderer.invoke('workspace:rename', { id, name }),
  removeWorkspace: (id: string) => ipcRenderer.invoke('workspace:remove', id),
  setActiveWorkspace: (id: string) => ipcRenderer.invoke('workspace:setActive', id),
  pickFolder: (workspaceId: string) => ipcRenderer.invoke('folder:pick', workspaceId),
  removeFolder: (workspaceId: string, folderPath: string) =>
    ipcRenderer.invoke('folder:remove', { workspaceId, folderPath }),
  listRunes: (folderPath: string) => ipcRenderer.invoke('folder:listRunes', folderPath),
  loadHistory: (folderPath: string) => ipcRenderer.invoke('folder:loadHistory', folderPath),
  appendUserMessage: (params: {
    folderPath: string
    message: { id: string; ts: number; text: string; attachments?: any[] }
  }) => ipcRenderer.invoke('room:appendUser', params),
  createRune: (params: { folderPath: string; name: string; role: string; icon?: string; color?: string; permissions?: any }) =>
    ipcRenderer.invoke('rune:create', params),
  updateRune: (params: {
    runePath: string
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
  }) => ipcRenderer.invoke('rune:update', params),
  deleteRune: (runePath: string) => ipcRenderer.invoke('rune:delete', runePath),
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
  }) => ipcRenderer.invoke('rune:sendMessage', params),
  onActivity: (cb: (data: { runId: string; text: string }) => void) => {
    const handler = (_event: any, data: { runId: string; text: string }) => cb(data)
    ipcRenderer.on('rune:activity', handler)
    return () => ipcRenderer.removeListener('rune:activity', handler)
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
  onRunesChanged: (cb: (folderPath: string) => void) => {
    const handler = (_event: any, folderPath: string) => cb(folderPath)
    ipcRenderer.on('folder:runesChanged', handler)
    return () => ipcRenderer.removeListener('folder:runesChanged', handler)
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
  wikiList: (folderPath: string) => ipcRenderer.invoke('wiki:list', folderPath),
  wikiRead: (params: { folderPath: string; name: string }) =>
    ipcRenderer.invoke('wiki:read', params),
  wikiWrite: (params: { folderPath: string; name: string; content: string }) =>
    ipcRenderer.invoke('wiki:write', params),
  wikiDelete: (params: { folderPath: string; name: string }) =>
    ipcRenderer.invoke('wiki:delete', params),
})
