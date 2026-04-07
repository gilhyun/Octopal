import { app, BrowserWindow, ipcMain, dialog, protocol, net, nativeImage, globalShortcut, Menu, shell } from 'electron'
import path from 'path'
import fs from 'fs'
import crypto from 'crypto'
import os from 'os'
import { spawn, ChildProcess } from 'child_process'

// OCTOPAL_PROD=1 forces the built renderer bundle even when running unpackaged,
// so `npm start` after `npm run build` behaves like a production app.
const IS_DEV = !app.isPackaged && process.env.OCTOPAL_PROD !== '1'

// Track running agent child processes so we can stop them
const runningAgents = new Map<string, ChildProcess>()

// Use a separate state file and userData dir in dev so you can run dev + prod
// side-by-side without them stomping on each other's workspaces.
const STATE_DIR = IS_DEV
  ? path.join(os.homedir(), '.octopal-dev')
  : path.join(os.homedir(), '.octopal')
const STATE_FILE = path.join(STATE_DIR, 'state.json')
if (IS_DEV) {
  // Cross-platform userData path for dev mode
  if (process.platform === 'darwin') {
    app.setPath('userData', path.join(os.homedir(), 'Library', 'Application Support', 'Octopal Dev'))
  } else if (process.platform === 'win32') {
    app.setPath('userData', path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Octopal Dev'))
  } else {
    app.setPath('userData', path.join(os.homedir(), '.config', 'octopal-dev'))
  }
}

// Folder watchers — notify renderer when .octo files change
const watchers = new Map<string, { watcher: fs.FSWatcher; debounce: ReturnType<typeof setTimeout> | null }>()

// ── Multi-window management ─────────────────────
const MAX_WINDOWS = 5
const windows = new Set<BrowserWindow>()

/** Broadcast an IPC event to ALL open windows */
function broadcastToWindows(channel: string, ...args: any[]) {
  for (const win of windows) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, ...args)
    }
  }
}

// Keep backward-compat — some code may still reference mainWindow
let mainWindow: BrowserWindow | null = null

function watchFolder(folderPath: string) {
  if (watchers.has(folderPath)) return
  if (!fs.existsSync(folderPath)) return
  try {
    const watcher = fs.watch(folderPath, (_eventType, filename) => {
      if (!filename || !filename.endsWith('.octo')) return
      const entry = watchers.get(folderPath)
      if (!entry) return
      if (entry.debounce) clearTimeout(entry.debounce)
      entry.debounce = setTimeout(() => {
        broadcastToWindows('folder:octosChanged', folderPath)
      }, 150)
    })
    watchers.set(folderPath, { watcher, debounce: null })
  } catch {}
}

function unwatchAll() {
  for (const { watcher, debounce } of watchers.values()) {
    if (debounce) clearTimeout(debounce)
    try { watcher.close() } catch {}
  }
  watchers.clear()
}

function createWindow(): BrowserWindow | null {
  if (windows.size >= MAX_WINDOWS) {
    // Notify the most recently focused window about the limit
    const last = BrowserWindow.getFocusedWindow() || [...windows][0]
    if (last && !last.isDestroyed()) {
      last.webContents.send('window:limitReached', MAX_WINDOWS)
    }
    return null
  }

  const iconPath = process.platform === 'win32'
    ? path.join(__dirname, '..', 'assets', 'icon.ico')
    : path.join(__dirname, '..', 'assets', 'icon-512.png')
  const win = new BrowserWindow({
    title: 'Octopal',
    width: 1200,
    height: 800,
    minWidth: 300,
    minHeight: 400,
    icon: iconPath,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    ...(process.platform === 'darwin' ? { trafficLightPosition: { x: 14, y: 16 } } : {}),
    backgroundColor: '#0e0e10',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  })

  windows.add(win)
  mainWindow = win

  win.on('closed', () => {
    windows.delete(win)
    if (mainWindow === win) {
      mainWindow = [...windows][0] || null
    }
  })

  win.on('focus', () => {
    mainWindow = win
  })

  // Open external links in the default browser instead of a new Electron window
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) {
      shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  if (IS_DEV) {
    win.loadURL('http://localhost:5173')
    win.webContents.openDevTools()
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'renderer', 'index.html'))
  }

  return win
}

// Register custom protocol for loading local files (uploads) in the renderer
protocol.registerSchemesAsPrivileged([
  { scheme: 'local-file', privileges: { bypassCSP: true, stream: true, supportFetchAPI: true } },
])

// Set the app name for macOS menu bar & about panel
app.setName('Octopal')

// ── Single instance lock ─────────────────────────
// Prevent multiple app processes — only allow multiple windows within one process
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    // Someone tried to run a second instance → focus our existing window
    const win = BrowserWindow.getFocusedWindow() || [...windows][0]
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })
}

app.whenReady().then(() => {
  // Handle local-file:// protocol — maps absolute paths to file responses
  protocol.handle('local-file', (request) => {
    // URL format: local-file:///absolute/path/to/file
    const filePath = decodeURIComponent(new URL(request.url).pathname)
    return net.fetch(`file://${filePath}`)
  })

  // Set macOS dock icon to our custom character
  if (process.platform === 'darwin') {
    const dockIconPath = path.join(__dirname, '..', 'assets', 'icon-512.png')
    if (fs.existsSync(dockIconPath)) {
      const dockIcon = nativeImage.createFromPath(dockIconPath)
      app.dock.setIcon(dockIcon)
    }
  }

  // ── Application menu with New Window ──────────
  const isMac = process.platform === 'darwin'
  const menuTemplate: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? [{
          label: app.name,
          submenu: [
            { role: 'about' as const },
            { type: 'separator' as const },
            { role: 'services' as const },
            { type: 'separator' as const },
            { role: 'hide' as const },
            { role: 'hideOthers' as const },
            { role: 'unhide' as const },
            { type: 'separator' as const },
            { role: 'quit' as const },
          ],
        }]
      : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'New Window',
          accelerator: 'CmdOrCtrl+Shift+N',
          click: () => createWindow(),
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac
          ? [
              { type: 'separator' as const },
              { role: 'front' as const },
            ]
          : [{ role: 'close' as const }]),
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate))

  // ── Dock menu (macOS right-click) ──────────────────
  if (process.platform === 'darwin' && app.dock) {
    const dockMenu = Menu.buildFromTemplate([
      {
        label: 'New Window',
        click: () => createWindow(),
      },
    ])
    app.dock.setMenu(dockMenu)
  }

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  unwatchAll()
  if (process.platform !== 'darwin') app.quit()
})

// ── Platform info ───────────────────────────────
ipcMain.handle('app:getPlatform', () => process.platform)

// ── Multi-window IPC ─────────────────────────────
ipcMain.handle('window:new', () => {
  const win = createWindow()
  if (!win) return { ok: false, error: `Maximum ${MAX_WINDOWS} windows allowed` }
  return { ok: true, windowId: win.id }
})

ipcMain.handle('window:count', () => {
  return { count: windows.size, max: MAX_WINDOWS }
})

// ── State persistence ─────────────────────────
interface Workspace {
  id: string
  name: string
  folders: string[]
}

interface State {
  workspaces: Workspace[]
  activeWorkspaceId: string | null
}

function loadState(): State {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'))
      // Migrate from legacy { folders: [] } shape
      if (raw && Array.isArray(raw.folders) && !raw.workspaces) {
        const id = 'default-' + Date.now()
        return {
          workspaces: [{ id, name: 'Personal', folders: raw.folders }],
          activeWorkspaceId: id,
        }
      }
      if (raw && Array.isArray(raw.workspaces)) {
        return {
          workspaces: raw.workspaces,
          activeWorkspaceId: raw.activeWorkspaceId || (raw.workspaces[0]?.id ?? null),
        }
      }
    }
  } catch {}
  return { workspaces: [], activeWorkspaceId: null }
}

function saveState(state: State) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true })
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
}

function getWorkspace(state: State, id: string | null): Workspace | null {
  if (!id) return null
  return state.workspaces.find((w) => w.id === id) || null
}

function findWorkspaceByFolder(folderPath: string): Workspace | null {
  const state = loadState()
  return state.workspaces.find((w) => w.folders.includes(folderPath)) || null
}

// ── IPC handlers ──────────────────────────────

// Check if Claude CLI is installed and logged in
ipcMain.handle('claude:checkLogin', async () => {
  return new Promise<{ installed: boolean; loggedIn: boolean }>((resolve) => {
    const child = spawn('claude', ['auth', 'status'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    })
    let stdout = ''
    child.stdout.on('data', (d) => { stdout += d.toString() })
    child.on('error', () => {
      // claude not found in PATH
      resolve({ installed: false, loggedIn: false })
    })
    child.on('close', (code) => {
      if (code !== 0) {
        resolve({ installed: true, loggedIn: false })
        return
      }
      try {
        const parsed = JSON.parse(stdout.trim())
        resolve({ installed: true, loggedIn: !!parsed.loggedIn })
      } catch {
        resolve({ installed: true, loggedIn: false })
      }
    })
  })
})

ipcMain.handle('state:load', () => loadState())

ipcMain.handle('workspace:create', (_event, name: string) => {
  const state = loadState()
  const id = 'ws-' + Date.now()
  state.workspaces.push({ id, name: name.trim() || 'Untitled', folders: [] })
  state.activeWorkspaceId = id
  saveState(state)

  // Auto-create onboarding wiki page for new workspace
  try {
    const wikiDir = getWikiDir(id)
    fs.mkdirSync(wikiDir, { recursive: true })
    const onboardingPath = path.join(wikiDir, 'getting-started.md')
    if (!fs.existsSync(onboardingPath)) {
      fs.writeFileSync(
        onboardingPath,
        `# Welcome to ${name.trim() || 'Untitled'} 🐙

## Quick Start

### 💬 Talking to Agents
- Type a message in the chat — an AI agent will respond.
- Use **@name** to talk to a specific agent (e.g. \`@assistant\`).
- Use **@all** to broadcast to every agent in the folder.

### 🤖 Hiring Teammates
- Click the **+ agent** button in the right sidebar to add a specialist (developer, designer, planner, etc.).
- Each agent has its own role, memory, and conversation history.

### 🔐 Permissions
- By default, agents can only read files and respond with text.
- To let an agent write files, run commands, or access the web, enable permissions in the agent's **settings panel** (click the agent card → gear icon).

### 📝 Wiki
- This wiki is shared across all folders in this workspace.
- Use it to record decisions, specs, and notes that all agents (and you) can reference.

### 👀 Activity Log
- Check the **Activity** tab to see a real-time log of everything agents do (file edits, shell commands, etc.).
`,
      )
    }
  } catch {}

  return state
})

ipcMain.handle('workspace:rename', (_event, params: { id: string; name: string }) => {
  const state = loadState()
  const ws = getWorkspace(state, params.id)
  if (ws) {
    ws.name = params.name.trim() || ws.name
    saveState(state)
  }
  return state
})

ipcMain.handle('workspace:remove', (_event, id: string) => {
  const state = loadState()
  state.workspaces = state.workspaces.filter((w) => w.id !== id)
  if (state.activeWorkspaceId === id) {
    state.activeWorkspaceId = state.workspaces[0]?.id || null
  }
  saveState(state)
  return state
})

ipcMain.handle('workspace:setActive', (_event, id: string) => {
  const state = loadState()
  if (state.workspaces.find((w) => w.id === id)) {
    state.activeWorkspaceId = id
    saveState(state)
  }
  return state
})

ipcMain.handle('folder:pick', async (_event, workspaceId: string) => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory'],
  })
  if (result.canceled || result.filePaths.length === 0) return null

  const folderPath = result.filePaths[0]
  const state = loadState()
  const ws = getWorkspace(state, workspaceId)
  if (ws && !ws.folders.includes(folderPath)) {
    ws.folders.push(folderPath)
    saveState(state)
  }
  return folderPath
})

ipcMain.handle('folder:remove', (_event, params: { workspaceId: string; folderPath: string }) => {
  const state = loadState()
  const ws = getWorkspace(state, params.workspaceId)
  if (ws) {
    ws.folders = ws.folders.filter((f) => f !== params.folderPath)
    saveState(state)
  }
  return state
})

// ── Wiki ──
// Workspace-scoped markdown notes stored at <STATE_DIR>/wiki/<workspaceId>/*.md.
// Both agents (via Read/Write tools) and the user (via the Wiki tab) can edit them.

function getWikiDir(workspaceId: string): string {
  return path.join(STATE_DIR, 'wiki', workspaceId)
}

function sanitizeWikiName(name: string): string | null {
  const trimmed = name.trim()
  if (!trimmed) return null
  // Only allow safe characters — block traversal.
  if (trimmed.includes('/') || trimmed.includes('\\') || trimmed.startsWith('.')) return null
  return trimmed.endsWith('.md') ? trimmed : `${trimmed}.md`
}

ipcMain.handle('wiki:list', (_event, workspaceId: string) => {
  try {
    const dir = getWikiDir(workspaceId)
    if (!fs.existsSync(dir)) return []
    return fs.readdirSync(dir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => {
        const full = path.join(dir, f)
        const stat = fs.statSync(full)
        return {
          name: f,
          path: full,
          size: stat.size,
          mtime: stat.mtimeMs,
        }
      })
      .sort((a, b) => b.mtime - a.mtime)
  } catch {
    return []
  }
})

ipcMain.handle('wiki:read', (_event, params: { workspaceId: string; name: string }) => {
  try {
    const safe = sanitizeWikiName(params.name)
    if (!safe) return { ok: false, error: 'Invalid name' }
    const filePath = path.join(getWikiDir(params.workspaceId), safe)
    if (!fs.existsSync(filePath)) return { ok: false, error: 'Not found' }
    return { ok: true, content: fs.readFileSync(filePath, 'utf-8') }
  } catch (e: any) {
    return { ok: false, error: e.message || String(e) }
  }
})

ipcMain.handle('wiki:write', (_event, params: { workspaceId: string; name: string; content: string }) => {
  try {
    const safe = sanitizeWikiName(params.name)
    if (!safe) return { ok: false, error: 'Invalid name' }
    const dir = getWikiDir(params.workspaceId)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, safe), params.content)
    return { ok: true, name: safe }
  } catch (e: any) {
    return { ok: false, error: e.message || String(e) }
  }
})

ipcMain.handle('wiki:delete', (_event, params: { workspaceId: string; name: string }) => {
  try {
    const safe = sanitizeWikiName(params.name)
    if (!safe) return { ok: false, error: 'Invalid name' }
    const filePath = path.join(getWikiDir(params.workspaceId), safe)
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
    return { ok: true }
  } catch (e: any) {
    return { ok: false, error: e.message || String(e) }
  }
})

// ── Room log (user messages) ──
// User messages are written immediately on send to a per-folder sidecar file so
// they survive even if no agent responds. Agent replies still live inside each
// .octo's own history array; loadHistory merges both.
interface RoomUserMessage {
  id: string
  ts: number
  text: string
  attachments?: any[]
}

function getRoomLogPath(folderPath: string): string {
  return path.join(folderPath, '.octopal', 'room-log.json')
}

function readRoomLog(folderPath: string): RoomUserMessage[] {
  try {
    const p = getRoomLogPath(folderPath)
    if (!fs.existsSync(p)) return []
    const data = JSON.parse(fs.readFileSync(p, 'utf-8'))
    return Array.isArray(data) ? data : []
  } catch {
    return []
  }
}

function writeRoomLog(folderPath: string, messages: RoomUserMessage[]) {
  try {
    const dir = path.join(folderPath, '.octopal')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(getRoomLogPath(folderPath), JSON.stringify(messages, null, 2))
  } catch {}
}

ipcMain.handle('room:appendUser', (_event, params: {
  folderPath: string
  message: RoomUserMessage
}) => {
  const log = readRoomLog(params.folderPath)
  // Skip exact duplicates by ts
  if (!log.some((m) => m.ts === params.message.ts && m.text === params.message.text)) {
    log.push(params.message)
    writeRoomLog(params.folderPath, log)
  }
  return { ok: true }
})

/** Collect ALL messages from room-log + .octo files, sorted chronologically. */
function collectAllMessages(folderPath: string) {
  const allMessages: Array<{
    id: string
    agentName: string
    text: string
    ts: number
    attachments?: any[]
  }> = []

  // 1) User messages from room-log.json
  const roomLog = readRoomLog(folderPath)
  for (const m of roomLog) {
    allMessages.push({
      id: `room-user-${m.ts}`,
      agentName: 'user',
      text: m.text,
      ts: m.ts,
      attachments: m.attachments,
    })
  }

  // 2) Assistant messages from each .octo history
  const files = fs.readdirSync(folderPath).filter((f) => f.endsWith('.octo'))
  for (const f of files) {
    const fullPath = path.join(folderPath, f)
    try {
      const octo = JSON.parse(fs.readFileSync(fullPath, 'utf-8'))
      const name = octo.name || f.replace('.octo', '')
      const history = octo.history || []
      for (let i = 0; i < history.length; i++) {
        const msg = history[i]
        // Skip user messages from .octo history — room-log is the source of truth now.
        if (msg.role === 'user') continue
        if (msg.roomTs) {
          allMessages.push({
            id: `${f}-${i}-${msg.roomTs}`,
            agentName: name,
            text: msg.text,
            ts: msg.roomTs,
          })
        }
      }
    } catch {}
  }

  // Sort chronologically
  allMessages.sort((a, b) => a.ts - b.ts)
  return allMessages
}

ipcMain.handle('folder:loadHistory', (_event, folderPath: string) => {
  try {
    if (!fs.existsSync(folderPath)) return []
    return collectAllMessages(folderPath)
  } catch {
    return []
  }
})

ipcMain.handle('folder:loadHistoryPaged', (_event, params: {
  folderPath: string
  limit: number
  beforeTs?: number
}) => {
  try {
    if (!fs.existsSync(params.folderPath)) return { messages: [], hasMore: false }
    const all = collectAllMessages(params.folderPath)

    let slice: typeof all
    if (params.beforeTs != null) {
      // Find the index of the first message with ts < beforeTs (going backwards)
      const cutoff = all.filter((m) => m.ts < params.beforeTs!)
      slice = cutoff.slice(-params.limit) // take last N before the cutoff
      const hasMore = cutoff.length > params.limit
      return { messages: slice, hasMore }
    } else {
      // Initial load: take the last N messages
      slice = all.slice(-params.limit)
      const hasMore = all.length > params.limit
      return { messages: slice, hasMore }
    }
  } catch {
    return { messages: [], hasMore: false }
  }
})

interface OctoPermissions {
  fileWrite?: boolean
  bash?: boolean
  network?: boolean
  allowPaths?: string[]
  denyPaths?: string[]
}

function buildPermissionArgs(permissions?: OctoPermissions): string[] {
  const args: string[] = []
  if (!permissions) return args
  const p = permissions
  const allowed: string[] = []
  const disallowed: string[] = []

  if (p.fileWrite === false) disallowed.push('Write', 'Edit')
  if (p.bash === false) disallowed.push('Bash')
  if (p.network === false) disallowed.push('WebFetch', 'WebSearch')

  if (p.allowPaths && p.allowPaths.length > 0) {
    for (const ap of p.allowPaths) {
      allowed.push(`Read(${ap})`, `Glob(${ap})`, `Grep(${ap})`)
      if (p.fileWrite !== false) allowed.push(`Write(${ap})`, `Edit(${ap})`)
    }
  }
  if (p.denyPaths && p.denyPaths.length > 0) {
    for (const dp of p.denyPaths) {
      disallowed.push(`Read(${dp})`, `Write(${dp})`, `Edit(${dp})`, `Glob(${dp})`, `Grep(${dp})`)
    }
  }

  if (allowed.length > 0) args.push('--allowedTools', allowed.join(' '))
  if (disallowed.length > 0) args.push('--disallowedTools', disallowed.join(' '))
  return args
}

ipcMain.handle('octo:update', (_event, params: {
  octoPath: string
  name?: string
  role?: string
  icon?: string
  color?: string
  permissions?: OctoPermissions
}) => {
  try {
    if (!fs.existsSync(params.octoPath)) {
      return { ok: false, error: 'File not found' }
    }
    const content = JSON.parse(fs.readFileSync(params.octoPath, 'utf-8'))
    let finalPath = params.octoPath
    if (params.name !== undefined) content.name = params.name.trim() || content.name
    if (params.role !== undefined) content.role = params.role
    if (params.icon !== undefined) content.icon = params.icon
    if (params.color !== undefined) content.color = params.color
    if (params.permissions !== undefined) content.permissions = params.permissions

    // Rename file if name changed
    if (params.name && params.name.trim()) {
      const dir = path.dirname(params.octoPath)
      const newFileName = params.name.trim().endsWith('.octo')
        ? params.name.trim()
        : `${params.name.trim()}.octo`
      const newPath = path.join(dir, newFileName)
      if (newPath !== params.octoPath) {
        if (fs.existsSync(newPath)) {
          return { ok: false, error: 'An agent with that name already exists' }
        }
        fs.writeFileSync(params.octoPath, JSON.stringify(content, null, 2))
        fs.renameSync(params.octoPath, newPath)
        finalPath = newPath
      } else {
        fs.writeFileSync(params.octoPath, JSON.stringify(content, null, 2))
      }
    } else {
      fs.writeFileSync(params.octoPath, JSON.stringify(content, null, 2))
    }
    return { ok: true, path: finalPath }
  } catch (e: any) {
    return { ok: false, error: e.message || String(e) }
  }
})

ipcMain.handle('octo:delete', (_event, octoPath: string) => {
  try {
    if (fs.existsSync(octoPath)) fs.unlinkSync(octoPath)
    return { ok: true }
  } catch (e: any) {
    return { ok: false, error: e.message || String(e) }
  }
})

ipcMain.handle('octo:create', (_event, params: { folderPath: string; name: string; role: string; icon?: string; color?: string; permissions?: any }) => {
  const { folderPath, name, role, icon, color, permissions } = params
  const safeName = name.trim()
  if (!safeName) return { ok: false, error: 'Name is required' }

  // Enforce max 10 visible (non-hidden) agents per folder
  const MAX_VISIBLE_AGENTS = 10
  try {
    const existingFiles = fs.readdirSync(folderPath).filter((f) => f.endsWith('.octo'))
    let visibleCount = 0
    for (const f of existingFiles) {
      try {
        const content = JSON.parse(fs.readFileSync(path.join(folderPath, f), 'utf-8'))
        if (!content.hidden) visibleCount++
      } catch { /* skip unreadable files */ }
    }
    if (visibleCount >= MAX_VISIBLE_AGENTS) {
      return { ok: false, error: `AGENT_LIMIT:${MAX_VISIBLE_AGENTS}` }
    }
  } catch { /* folder read failed — continue with creation */ }

  const fileName = safeName.endsWith('.octo') ? safeName : `${safeName}.octo`
  const filePath = path.join(folderPath, fileName)
  if (fs.existsSync(filePath)) {
    return { ok: false, error: 'An agent with that name already exists' }
  }
  const octoData: any = {
    name: safeName.replace('.octo', ''),
    role: role.trim() || 'Assistant',
    icon: icon || 'bot',
    createdAt: new Date().toISOString(),
    history: [],
  }
  if (permissions) {
    octoData.permissions = permissions
  }
  try {
    fs.writeFileSync(filePath, JSON.stringify(octoData, null, 2))
    return { ok: true, path: filePath }
  } catch (e: any) {
    return { ok: false, error: e.message || String(e) }
  }
})

ipcMain.handle('folder:listOctos', (_event, folderPath: string) => {
  try {
    if (!fs.existsSync(folderPath)) return []
    watchFolder(folderPath)
    const files = fs.readdirSync(folderPath)
      .filter((f) => f.endsWith('.octo'))
      .map((f) => {
        const fullPath = path.join(folderPath, f)
        try {
          const content = JSON.parse(fs.readFileSync(fullPath, 'utf-8'))
          return {
            path: fullPath,
            name: content.name || f.replace('.octo', ''),
            role: content.role || '',
            icon: content.icon || 'bot',
            hidden: content.hidden || false,
            permissions: content.permissions || null,
          }
        } catch {
          return null
        }
      })
      .filter(Boolean)
    return files
  } catch {
    return []
  }
})

// Classify @mentions inside an agent's response.
// Returns whether the mentions are a real handoff (auto-call), a question
// that needs user approval, or a passing reference (do nothing).
ipcMain.handle('mention:classify', async (_event, params: {
  speakerName: string
  speakerText: string
  mentionedNames: string[]
}): Promise<
  | { ok: true; decision: 'handoff' | 'approval' | 'ignore'; reason?: string }
  | { ok: false; error: string }
> => {
  const { speakerName, speakerText, mentionedNames } = params
  if (mentionedNames.length === 0) return { ok: true, decision: 'ignore' }

  const systemPrompt = `You are a classifier for a group chat of AI agents. One agent (${speakerName}) has written a message that contains @mentions of other agents: ${mentionedNames.map((n) => '@' + n).join(', ')}.

Your job: decide whether those mentions should actually trigger the other agents to respond.

Reply with ONLY a JSON object, nothing else:
{"decision": "handoff" | "approval" | "ignore", "reason": "<very short reason>"}

Rules:
- "handoff" — the speaker is clearly delegating or handing off work RIGHT NOW. Examples: "I'll handle X, @designer please do Y", "Passing this to @reviewer", "@coder, implement this." The mention is an imperative / assignment.
- "approval" — the speaker is PROPOSING to involve those agents but waiting for the human's green light. Examples: "Should I hand this to @designer?", "Want me to loop in @reviewer?", "Shall we ask @developer to start?", any mention inside a question the user is expected to answer. If the message ends with a question mark and the question is about whether to involve those agents, it's approval.
- "ignore" — the speaker is just name-dropping, thanking, or referencing in passing. Examples: "as @architect said earlier", "thanks @reviewer for the note", "this is similar to what @designer made last time". The mention is not an invitation to respond.

When in doubt between handoff and approval, prefer "approval" — the human can always confirm.`

  try {
    const claudeArgs = [
      '-p', '--print',
      '--mcp-config', '{"mcpServers":{}}',
      '--strict-mcp-config',
      '--system-prompt', systemPrompt,
      '--',
      speakerText.slice(0, 2000),
    ]

    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn('claude', claudeArgs, {
        cwd: os.tmpdir(),
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
      })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (d) => { stdout += d.toString() })
      child.stderr.on('data', (d) => { stderr += d.toString() })
      child.on('close', (code) => {
        if (code !== 0) reject(new Error(stderr || `exited with ${code}`))
        else resolve(stdout.trim())
      })
    })

    const match = output.match(/\{[\s\S]*?\}/)
    if (match) {
      try {
        const parsed = JSON.parse(match[0])
        if (parsed && ['handoff', 'approval', 'ignore'].includes(parsed.decision)) {
          return { ok: true, decision: parsed.decision, reason: parsed.reason }
        }
      } catch {}
    }
    // Fallback: safest default is to ask the user.
    return { ok: true, decision: 'approval' }
  } catch (e: any) {
    return { ok: false, error: e.message || String(e) }
  }
})

ipcMain.handle('dispatcher:route', async (_event, params: {
  message: string
  agents: Array<{ name: string; role: string }>
  recentHistory: Array<{ agentName: string; text: string }>
}): Promise<
  | { ok: true; leader: string; collaborators: string[] }
  | { ok: false; error: string }
> => {
  const { message, agents, recentHistory } = params
  if (agents.length === 0) return { ok: false, error: 'no agents' }

  const agentList = agents.map((a) => `- ${a.name}: ${a.role || 'assistant'}`).join('\n')
  const historyText = recentHistory.length > 0
    ? '\n\nRecent conversation:\n' + recentHistory
        .map((h) => `${h.agentName === 'user' ? 'User' : h.agentName}: ${h.text.slice(0, 300)}`)
        .join('\n')
    : ''

  const systemPrompt = `You are a message dispatcher in a group chat of AI agents. Given a user message, recent conversation context, and a list of agents with their roles, decide WHO should lead the response and who should collaborate.

Available agents:
${agentList}${historyText}

Output format — reply with ONLY a JSON object, nothing else:
{"leader": "<name>", "collaborators": ["<name>", ...]}

Rules for choosing the leader:
- The leader is the ONE agent who will start the response. If the task requires concrete action (writing files, running commands, implementing something), the leader should be the agent whose role matches that action. When in doubt, the implementer leads.
- If the user is clearly continuing a conversation with a specific agent (short replies like "why?", "explain more", "ok do it"), that agent is the leader.
- If the message is small talk or ambiguous, pick the most generally-suited single agent as leader, with empty collaborators.

Rules for collaborators:
- Only include collaborators when their expertise is clearly needed in addition to the leader's.
- If the task could be handled by one agent alone, leave collaborators empty. Do NOT add collaborators "just to be polite".
- For tasks that modify the same file or resource, keep collaborators empty — the leader should handle it alone to avoid conflicts.
- Collaborators can be mentioned by the leader using @name during their response; they will then be invoked automatically.

Never include agents not in the list. The leader field is required.`

  try {
    const claudeArgs = [
      '-p',
      '--print',
      '--mcp-config',
      '{"mcpServers":{}}',
      '--strict-mcp-config',
      '--system-prompt',
      systemPrompt,
      '--',
      message,
    ]

    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn('claude', claudeArgs, {
        cwd: os.tmpdir(),
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
      })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (d) => { stdout += d.toString() })
      child.stderr.on('data', (d) => { stderr += d.toString() })
      child.on('close', (code) => {
        if (code !== 0) reject(new Error(stderr || `exited with ${code}`))
        else resolve(stdout.trim())
      })
    })

    const resolveName = (raw: string): string | null => {
      const found = agents.find((a) => a.name.toLowerCase() === raw.toLowerCase())
      return found ? found.name : null
    }

    // Parse JSON object from output (leader + collaborators)
    const objMatch = output.match(/\{[\s\S]*?\}/)
    if (objMatch) {
      try {
        const parsed = JSON.parse(objMatch[0])
        if (parsed && typeof parsed.leader === 'string') {
          const leader = resolveName(parsed.leader)
          if (leader) {
            const collaborators = Array.isArray(parsed.collaborators)
              ? parsed.collaborators
                  .map((n: any) => (typeof n === 'string' ? resolveName(n) : null))
                  .filter((n: string | null): n is string => !!n && n !== leader)
              : []
            return { ok: true, leader, collaborators }
          }
        }
      } catch {}
    }

    // Legacy fallback: JSON array -> first element becomes leader
    const match = output.match(/\[[\s\S]*?\]/)
    if (!match) {
      return { ok: true, leader: agents[0].name, collaborators: [] }
    }
    try {
      const parsed = JSON.parse(match[0])
      if (Array.isArray(parsed)) {
        const resolved = parsed
          .map((n: any) => (typeof n === 'string' ? resolveName(n) : null))
          .filter((n: string | null): n is string => !!n)
        if (resolved.length > 0) {
          return { ok: true, leader: resolved[0], collaborators: resolved.slice(1) }
        }
      }
    } catch {}
    return { ok: true, leader: agents[0].name, collaborators: [] }
  } catch (e: any) {
    return { ok: false, error: e.message || String(e) }
  }
})

ipcMain.handle('octo:sendMessage', async (_event, params: {
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
}) => {
  const { folderPath, octoPath, prompt, userTs, runId, peers, collaborators, isLeader, imagePaths, textPaths } = params

  const sendActivity = (text: string) => {
    broadcastToWindows('octo:activity', { runId, text })
  }

  const sendLogEntry = (entry: {
    agentName: string
    tool: string
    target: string
    ts: number
  }) => {
    broadcastToWindows('activity:log', { folderPath, ...entry })
  }

  try {
    const octoContent = JSON.parse(fs.readFileSync(octoPath, 'utf-8'))
    const agentName = octoContent.name || path.basename(octoPath, '.octo')
    const systemParts: string[] = []

    // ── Octo world context ──
    // Give every agent a shared understanding of the system they live in.
    systemParts.push(
      `You are an agent in Octopal, a group-chat messenger for AI agents.

How your world works:
- You are a ".octo" file: a JSON file on disk that stores your name, role, memory, and conversation history. Deleting the file deletes you; copying it clones you.
- Your current project is the folder that contains your .octo file. Think of the folder as a workspace/project and each .octo file inside it as a coworker on that project.
- Other .octo files in the same folder are your peers. You can talk to them in the group chat by mentioning them with @name — they will see the message and may respond.
- The human user talks to the whole room and can @mention any agent directly. If no one is mentioned, a dispatcher decides who should respond based on roles and recent context.
- You persist across sessions: the user can close the app and come back days later, and your memory and history are still there.
- You are not Claude Code itself. You are a specific agent persona running on top of Claude Code. Stay in character based on your role below.`
    )

    // ── App Context (L1 + L2) ──
    // Inject shared knowledge about Octopal so every agent understands the
    // app it lives in. This costs ~250 tokens and dramatically improves the
    // agent's ability to guide users.
    systemParts.push(
      `\nAbout Octopal — things you should know:
- **Creating agents**: Anyone can create a new AI teammate by adding a .octo file to the project folder (or asking you to do it). Each .octo file = one agent with its own name, role, and memory.
- **Mentioning**: Use @name to talk to another agent. The mentioned agent will see the message and respond. The user can also @mention agents directly.
- **Wiki**: A shared knowledge base for the team. Write .md files to the wiki directory to share notes, decisions, and context across all agents and sessions.
- **Permissions**: Each agent's capabilities (file write, shell commands, network access) are configured independently. The user controls these in the agent's settings panel.
- **Workspaces & Folders**: A workspace groups related project folders. Each folder can have its own set of agents. The wiki is shared across all folders in the same workspace.
- **Activity log**: The user can see a real-time log of everything agents do (tool calls, file edits, etc.) in the sidebar — full transparency.
- **Hiring teammates**: The user can add specialized agents (developers, designers, planners, reviewers, etc.) to collaborate. Agents can also suggest bringing in a teammate when the task calls for it.`
    )

    if (octoContent.role) systemParts.push(`\nYour role: ${octoContent.role}`)
    systemParts.push(`Your name: ${octoContent.name || 'assistant'}`)
    if (octoContent.memory && octoContent.memory.length > 0) {
      systemParts.push('\nSaved memory:')
      octoContent.memory.forEach((m: string, i: number) => {
        systemParts.push(`${i + 1}. ${m}`)
      })
    }

    // Tell the agent about the workspace wiki, and make sure the wiki
    // directory exists so we can grant access to it via --add-dir below.
    let agentWikiDir: string | null = null
    try {
      const ws = findWorkspaceByFolder(folderPath)
      if (ws) {
        const wikiDir = getWikiDir(ws.id)
        fs.mkdirSync(wikiDir, { recursive: true })
        agentWikiDir = wikiDir
        const wikiFiles = fs.existsSync(wikiDir)
          ? fs.readdirSync(wikiDir).filter((f) => f.endsWith('.md'))
          : []
        const pageList =
          wikiFiles.length > 0 ? wikiFiles.join(', ') : '(none yet)'
        systemParts.push(
          `\nWorkspace wiki — shared notes the whole team (you, your peers, and the user) can read and write:
- Wiki directory (absolute path): ${wikiDir}
- Existing pages: ${pageList}
- The wiki is shared across all folders in this workspace.
- To READ a page: use the Read tool with the absolute path, e.g. Read "${wikiDir}/<page>.md".
- To LIST pages: use Glob with "${wikiDir}/*.md".
- To WRITE or UPDATE a page: use Write/Edit with the absolute path under this directory. Only .md files, flat (no subfolders).
- Check the wiki at the start of non-trivial tasks to pick up team context, decisions, and goals. Update it when you learn something durable the team should remember.`
        )
      }
    } catch {}
    // Tell the agent about its peers so it can @mention them
    if (peers && peers.length > 0) {
      systemParts.push('\nYou are in a group chat with these other agents:')
      peers.forEach((p) => {
        systemParts.push(`- @${p.name}: ${p.role || 'assistant'}`)
      })
      systemParts.push(
        '\nIf another agent\'s expertise would help answer this, you can mention them with @name in your response. They will automatically see your message and may respond. Only mention peers when it genuinely adds value — do not mention them just to be polite.'
      )
    }

    // Collaboration leader mode — assigned by the dispatcher
    if (isLeader && collaborators && collaborators.length > 0) {
      const collabList = collaborators
        .map((c) => `- @${c.name} (${c.role || 'assistant'})`)
        .join('\n')
      systemParts.push(
        `\n=== COLLABORATION MODE ===
You are the LEAD on this task. These teammates have been assigned to help you:
${collabList}

How to collaborate (very important):
1. You start. Think about the task and decide what parts need your teammates' expertise.
2. Do the parts that fall under your own role. Then, if you need a teammate's input or work, mention them with @name in your response.
3. They will be invoked automatically AFTER you finish and will see what you did, then respond in turn. They run SEQUENTIALLY after you — never in parallel — so there are no file conflicts.
4. Be explicit: "@<name>, please handle X" or "@<name>, what do you think about Y?" Clear handoffs.
5. If the task is small enough that you can handle it alone, just do it and don't mention anyone. Do not drag teammates in unnecessarily.
6. NEVER assume a teammate has already done something. You are first. Whatever needs doing right now, you do.`
      )
    }
    // Include recent history so the agent remembers prior turns
    if (octoContent.history && octoContent.history.length > 0) {
      const recent = octoContent.history.slice(-10)
      systemParts.push('\nRecent conversation:')
      for (const msg of recent) {
        const who = msg.role === 'user' ? 'User' : 'Assistant'
        systemParts.push(`${who}: ${msg.text}`)
      }
    }

    // Decide whether the agent should be able to use tools.
    // Rule: if the .octo file has a `permissions` block with at least one
    // tool enabled (fileWrite, bash, or network explicitly true), we run in
    // "active" mode with --dangerously-skip-permissions + fine-grained tool
    // gates. Otherwise the agent is read-only (chat-only).
    const perms: OctoPermissions | undefined = octoContent.permissions
    const hasActivePerms =
      perms &&
      (perms.fileWrite === true ||
        perms.bash === true ||
        perms.network === true)

    const claudeArgs = [
      '-p', '--print',
      '--mcp-config', '{"mcpServers":{}}',
      '--strict-mcp-config',
      '--verbose',
      '--output-format', 'stream-json',
    ]

    // Give the agent access to the workspace wiki directory in addition to
    // its own folder. Without this, Read/Write tools can't touch the wiki
    // because it lives outside the agent's cwd.
    if (agentWikiDir) {
      claudeArgs.push('--add-dir', agentWikiDir)
    }

    if (hasActivePerms) {
      claudeArgs.push('--dangerously-skip-permissions')
      claudeArgs.push(...buildPermissionArgs(perms))
    }

    if (systemParts.length > 0) {
      const capabilities: string[] = []
      if (hasActivePerms) {
        if (perms?.fileWrite === true) capabilities.push('write and edit files')
        if (perms?.bash === true) capabilities.push('run shell commands')
        if (perms?.network === true) capabilities.push('make web requests')
      }
      const capLine =
        capabilities.length > 0
          ? `\n\nYou have permission to: ${capabilities.join(', ')}. Use these tools when the user or a peer asks you to do something concrete.`
          : [
              `\n\nYou do NOT have permission to write files, run shell commands, or access the network. Answer with text only.`,
              `If the user asks you to do something that requires these tools, briefly explain what you need and then output a permission request tag at the END of your message in this exact format:`,
              `<!--NEEDS_PERMISSIONS: fileWrite, bash, network-->`,
              `Only include the specific permissions you actually need (fileWrite for writing/editing files, bash for running shell commands, network for web access). The app will show the user a button to grant these permissions directly.`,
              `Example: if the user asks you to create a file, say you need file write permission and end with <!--NEEDS_PERMISSIONS: fileWrite-->`,
              `Example: if the user asks you to run a build, you need bash permission: <!--NEEDS_PERMISSIONS: bash-->`,
              `Example: if you need multiple permissions: <!--NEEDS_PERMISSIONS: fileWrite, bash-->`,
            ].join('\n')
      claudeArgs.push(
        '--system-prompt',
        systemParts.join('\n') + capLine + `\n\nWorking folder: ${folderPath}`
      )
    }
    // Attachments: prepend file references to the prompt so Claude Code reads them.
    // Claude Code auto-resolves `@relative/path` mentions by reading the file with
    // its Read tool (images included, for vision models).
    let finalPrompt = prompt
    const refs: string[] = []
    if (imagePaths && imagePaths.length > 0) {
      for (const imgRelPath of imagePaths) {
        const absImgPath = path.join(folderPath, imgRelPath)
        if (fs.existsSync(absImgPath)) {
          refs.push(`@${imgRelPath}`)
        }
      }
    }
    if (textPaths && textPaths.length > 0) {
      for (const txtRelPath of textPaths) {
        const absTxtPath = path.join(folderPath, txtRelPath)
        if (fs.existsSync(absTxtPath)) {
          refs.push(`@${txtRelPath}`)
        }
      }
    }
    if (refs.length > 0) {
      finalPrompt = `Attached files: ${refs.join(' ')}\n\n${prompt}`
    }

    claudeArgs.push(finalPrompt)

    sendActivity('Thinking…')

    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn('claude', claudeArgs, {
        cwd: folderPath,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
      })

      // Track this child process for stop functionality
      runningAgents.set(runId, child)
      child.on('exit', () => { runningAgents.delete(runId) })

      let finalResult = ''
      let buffer = ''
      let stderr = ''

      child.stdout.on('data', (data) => {
        buffer += data.toString()
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''
        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const event = JSON.parse(line)
            if (event.type === 'assistant' && event.message?.content) {
              for (const block of event.message.content) {
                if (block.type === 'tool_use') {
                  const tool = block.name || 'tool'
                  const input = block.input || {}
                  let label = tool
                  let logTarget = ''
                  if (tool === 'Bash') {
                    label = `Running: ${(input.command || '').slice(0, 80)}`
                    logTarget = (input.command || '').slice(0, 120)
                  }
                  else if (tool === 'Write') {
                    label = `Writing ${path.basename(input.file_path || '')}`
                    logTarget = input.file_path || ''
                  }
                  else if (tool === 'Edit') {
                    label = `Editing ${path.basename(input.file_path || '')}`
                    logTarget = input.file_path || ''
                  }
                  else if (tool === 'Read') label = `Reading ${path.basename(input.file_path || '')}`
                  else if (tool === 'Grep') label = `Searching for "${(input.pattern || '').slice(0, 40)}"`
                  else if (tool === 'Glob') label = `Finding ${(input.pattern || '').slice(0, 40)}`
                  else if (tool === 'WebFetch') {
                    label = 'Fetching web page'
                    logTarget = input.url || ''
                  }
                  else if (tool === 'WebSearch') label = 'Searching the web'
                  sendActivity(label)
                  // Log meaningful actions (skip read-only tools to keep the log useful)
                  if (tool === 'Write' || tool === 'Edit' || tool === 'Bash' || tool === 'WebFetch') {
                    sendLogEntry({
                      agentName,
                      tool,
                      target: logTarget,
                      ts: Date.now(),
                    })
                  }
                } else if (block.type === 'text' && block.text?.trim()) {
                  sendActivity('Writing response…')
                }
              }
            }
            if (event.type === 'result') {
              finalResult = event.result || ''
            }
          } catch {}
        }
      })
      child.stderr.on('data', (d) => { stderr += d.toString() })
      child.on('close', (code) => {
        if (code !== 0) reject(new Error(stderr || `exited with ${code}`))
        else resolve(finalResult.trim())
      })
    })

    // Update octo history with roomTs for cross-agent merging
    octoContent.history = octoContent.history || []
    octoContent.history.push({ role: 'user', text: prompt, ts: userTs, roomTs: userTs })
    octoContent.history.push({ role: 'assistant', text: output, ts: Date.now(), roomTs: Date.now() })
    fs.writeFileSync(octoPath, JSON.stringify(octoContent, null, 2))

    return { ok: true, output }
  } catch (e: any) {
    return { ok: false, error: e.message || String(e) }
  }
})

// ── Stop all running agents ──────────────────────
ipcMain.handle('agent:stopAll', () => {
  const count = runningAgents.size
  for (const [runId, child] of runningAgents) {
    try {
      child.kill('SIGTERM')
    } catch {}
    runningAgents.delete(runId)
  }
  return { ok: true, stopped: count }
})

// ── File upload handlers ──────────────────────

const ALLOWED_IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.webp']
const ALLOWED_TEXT_EXTS = ['.txt', '.log', '.json', '.csv']
const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10MB

ipcMain.handle('file:save', async (_event, params: {
  folderPath: string
  fileName: string
  data: string        // base64-encoded file content
  mimeType: string
}) => {
  try {
    const { folderPath, fileName, data, mimeType } = params
    const buffer = Buffer.from(data, 'base64')

    if (buffer.length > MAX_FILE_SIZE) {
      return { ok: false, error: 'File exceeds 10MB limit' }
    }

    const ext = path.extname(fileName).toLowerCase()
    const isImage = ALLOWED_IMAGE_EXTS.includes(ext)
    const isText = ALLOWED_TEXT_EXTS.includes(ext)
    if (!isImage && !isText) {
      return { ok: false, error: `Unsupported file type: ${ext}` }
    }

    const uploadsDir = path.join(folderPath, '.octopal', 'uploads')
    fs.mkdirSync(uploadsDir, { recursive: true })

    const hash = crypto.createHash('md5').update(buffer).digest('hex').slice(0, 8)
    const timestamp = Date.now()
    const safeFileName = `${timestamp}-${hash}${ext}`
    const filePath = path.join(uploadsDir, safeFileName)

    fs.writeFileSync(filePath, buffer)

    return {
      ok: true,
      attachment: {
        id: `att-${timestamp}-${hash}`,
        type: isImage ? 'image' : 'text',
        filename: fileName,
        path: `.octopal/uploads/${safeFileName}`,
        mimeType,
        size: buffer.length,
      },
    }
  } catch (e: any) {
    return { ok: false, error: e.message || String(e) }
  }
})

ipcMain.handle('file:readBase64', async (_event, params: {
  folderPath: string
  relativePath: string
}) => {
  try {
    const fullPath = path.join(params.folderPath, params.relativePath)
    if (!fs.existsSync(fullPath)) return { ok: false, error: 'File not found' }
    const buffer = fs.readFileSync(fullPath)
    return { ok: true, data: buffer.toString('base64') }
  } catch (e: any) {
    return { ok: false, error: e.message || String(e) }
  }
})

ipcMain.handle('file:getAbsolutePath', (_event, params: {
  folderPath: string
  relativePath: string
}) => {
  return path.join(params.folderPath, params.relativePath)
})

// ── Settings persistence ─────────────────────
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
    chatFontSize: number // 13-18
  }
}

const SETTINGS_FILE = path.join(STATE_DIR, 'settings.json')

const DEFAULT_SETTINGS: AppSettings = {
  general: {
    restoreLastWorkspace: true,
    launchAtLogin: false,
    language: 'en',
  },
  agents: {
    defaultPermissions: {
      fileWrite: false,
      bash: false,
      network: false,
    },
  },
  appearance: {
    chatFontSize: 14,
  },
}

function loadSettings(): AppSettings {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'))
      return {
        general: { ...DEFAULT_SETTINGS.general, ...raw.general },
        agents: {
          defaultPermissions: {
            ...DEFAULT_SETTINGS.agents.defaultPermissions,
            ...raw.agents?.defaultPermissions,
          },
        },
        appearance: { ...DEFAULT_SETTINGS.appearance, ...raw.appearance },
      }
    }
  } catch {}
  return { ...DEFAULT_SETTINGS }
}

function saveSettings(settings: AppSettings) {
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true })
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2))
}

ipcMain.handle('settings:load', () => loadSettings())

ipcMain.handle('settings:save', (_event, settings: AppSettings) => {
  saveSettings(settings)

  // Apply launch-at-login setting
  if (app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin: settings.general.launchAtLogin })
  }

  return { ok: true }
})

ipcMain.handle('settings:getVersion', () => {
  return { version: app.getVersion(), electron: process.versions.electron, node: process.versions.node }
})
