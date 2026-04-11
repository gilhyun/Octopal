import { app, BrowserWindow, ipcMain, dialog, protocol, net, nativeImage, globalShortcut, Menu, shell } from 'electron'
import path from 'path'
import fs from 'fs'
import crypto from 'crypto'
import os from 'os'
import { spawn, execFile, ChildProcess } from 'child_process'
import { isSensitivePath, validateOctoPath, validatePathContainment, sanitizedEnv, sanitizeError, acquireFileLock, classifyPathAccess, validateMcpConfig, type PathAccessClass } from './security'
import { takeSnapshot, autoCommit, extractCommitSummary, isGitAvailable, createAgentBranch, mergeAgentBranch, cleanupAgentBranch, getCommitHistory, getCommitDiff, revertCommit, revertRange, pushToRemote, hasRemote, discardAgentBranch } from './git-service'
import { observer } from './observer'
import { ruleRouter, CONFIDENCE_THRESHOLD } from './rule-router'
import { smartObserver } from './smart-observer'
import {
  compressHistory,
  formatCompressedHistory,
  compressRouterHistory,
  COMPACT_WORLD_CONTEXT,
  COMPACT_APP_CONTEXT,
  compactWikiSection,
  compactPeerSection,
} from './token-optimizer'

// OCTOPAL_PROD=1 forces the built renderer bundle even when running unpackaged,
// so `npm start` after `npm run build` behaves like a production app.
const IS_DEV = !app.isPackaged && process.env.OCTOPAL_PROD !== '1'

// Track running agent child processes so we can stop them
const runningAgents = new Map<string, ChildProcess>()

// Track interrupted runs — these resolve with '[interrupted]' instead of rejecting
const interruptedRuns = new Set<string>()

// Track agent branch info per runId (for interrupt rollback — Phase 2 bundling)
const runBranchInfo = new Map<string, {
  folderPath: string
  agentName: string
  baseBranch: string
  agentBranch: string
}>()

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

// ── File Access Approval System (P1) ───────────────────
type FileAccessDecision = 'allow_once' | 'allow_always' | 'deny'

// Persistent "allow_always" grants — keyed by `${projectFolder}::${resolvedPath}`
const permanentGrants = new Set<string>()

// Pending approval requests — keyed by requestId
const pendingApprovals = new Map<string, {
  resolve: (decision: FileAccessDecision) => void
  timer: ReturnType<typeof setTimeout>
}>()

/**
 * Request user approval for file access outside the project folder.
 * Returns the user's decision, or 'deny' on timeout (30s).
 */
async function requestFileAccessApproval(
  resolvedPath: string,
  projectFolder: string,
  agentName?: string,
  reason?: string,
): Promise<FileAccessDecision> {
  const grantKey = `${projectFolder}::${resolvedPath}`

  // Check permanent grants first
  if (permanentGrants.has(grantKey)) {
    return 'allow_once' // already allowed permanently
  }

  const classification = classifyPathAccess(resolvedPath, projectFolder)

  if (classification === 'internal') return 'allow_once'
  if (classification === 'blocked') return 'deny'

  // External — ask the user
  const requestId = crypto.randomUUID()

  return new Promise<FileAccessDecision>((resolve) => {
    const timer = setTimeout(() => {
      pendingApprovals.delete(requestId)
      resolve('deny') // timeout → deny
    }, 30_000)

    pendingApprovals.set(requestId, { resolve, timer })

    // Send to renderer for modal display
    broadcastToWindows('fileAccess:request', {
      requestId,
      agentName: agentName || 'unknown',
      targetPath: resolvedPath,
      reason,
      blocked: false,
    })
  })
}

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
// Use separate lock per environment so dev & prod can run simultaneously
const gotTheLock = app.requestSingleInstanceLock({ env: IS_DEV ? 'dev' : 'prod' })
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
  protocol.handle('local-file', async (request) => {
    // URL format: local-file:///absolute/path/to/file
    const filePath = decodeURIComponent(new URL(request.url).pathname)
    const resolved = path.resolve(filePath)

    // P0: Block access to sensitive paths (always deny)
    if (isSensitivePath(resolved)) {
      return new Response('Forbidden: access to sensitive path denied', { status: 403 })
    }

    // Note: local-file:// doesn't carry project folder context,
    // so external path approval is handled at the IPC level (file:readBase64,
    // file:getAbsolutePath) before URLs are constructed.
    // This handler retains P0 sensitive path blocking as a defense-in-depth layer.

    return net.fetch(`file://${resolved}`)
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

  // Apply saved observer model on startup
  try {
    const initialSettings = loadSettings()
    if (initialSettings.advanced?.observerModel) {
      smartObserver.model = initialSettings.advanced.observerModel
    }
  } catch {}

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
      env: sanitizedEnv(),
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
    return { ok: false, error: sanitizeError(e, IS_DEV) }
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
    return { ok: false, error: sanitizeError(e, IS_DEV) }
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
    return { ok: false, error: sanitizeError(e, IS_DEV) }
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
    console.log('[loadHistoryPaged] folderPath:', params.folderPath, 'total messages:', all.length, 'limit:', params.limit, 'beforeTs:', params.beforeTs)

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

ipcMain.handle('octo:update', async (_event, params: {
  octoPath: string
  name?: string
  role?: string
  icon?: string
  color?: string
  permissions?: OctoPermissions
  mcpServers?: Record<string, { command: string; args?: string[]; env?: Record<string, string> }> | null
}) => {
  // P0: Validate path is a .octo file
  const check = validateOctoPath(params.octoPath)
  if (!check.ok) return { ok: false, error: check.error }
  const safePath = check.resolved

  // #6: Acquire file lock to prevent race conditions
  const release = await acquireFileLock(safePath)
  try {
    if (!fs.existsSync(safePath)) {
      return { ok: false, error: 'File not found' }
    }
    const content = JSON.parse(fs.readFileSync(safePath, 'utf-8'))
    let finalPath = safePath
    if (params.name !== undefined) content.name = params.name.trim() || content.name
    if (params.role !== undefined) content.role = params.role
    if (params.icon !== undefined) content.icon = params.icon
    if (params.color !== undefined) content.color = params.color
    if (params.permissions !== undefined) content.permissions = params.permissions
    if (params.mcpServers !== undefined) {
      if (params.mcpServers === null || Object.keys(params.mcpServers).length === 0) {
        delete content.mcpServers
      } else {
        const mcpCheck = validateMcpConfig(params.mcpServers)
        if (!mcpCheck.ok) return { ok: false, error: mcpCheck.error }
        content.mcpServers = mcpCheck.sanitized
      }
    }

    // Rename file if name changed
    if (params.name && params.name.trim()) {
      const dir = path.dirname(safePath)
      // Sanitize name: reject path separators and leading dots
      const trimmedName = params.name.trim()
      if (trimmedName.includes('/') || trimmedName.includes('\\') || trimmedName.startsWith('.')) {
        return { ok: false, error: 'Invalid agent name' }
      }
      const newFileName = trimmedName.endsWith('.octo')
        ? trimmedName
        : `${trimmedName}.octo`
      const newPath = path.join(dir, newFileName)
      // Validate the new path also stays in the same directory
      const newCheck = validateOctoPath(newPath, dir)
      if (!newCheck.ok) return { ok: false, error: newCheck.error }

      if (newCheck.resolved !== safePath) {
        if (fs.existsSync(newCheck.resolved)) {
          return { ok: false, error: 'An agent with that name already exists' }
        }
        fs.writeFileSync(safePath, JSON.stringify(content, null, 2))
        fs.renameSync(safePath, newCheck.resolved)
        finalPath = newCheck.resolved
      } else {
        fs.writeFileSync(safePath, JSON.stringify(content, null, 2))
      }
    } else {
      fs.writeFileSync(safePath, JSON.stringify(content, null, 2))
    }
    return { ok: true, path: finalPath }
  } catch (e: any) {
    return { ok: false, error: sanitizeError(e, IS_DEV) }
  } finally {
    release()
  }
})

ipcMain.handle('octo:delete', async (_event, octoPath: string) => {
  // P0: Validate path is a .octo file before deleting
  const check = validateOctoPath(octoPath)
  if (!check.ok) return { ok: false, error: check.error }

  // #6: Acquire file lock
  const release = await acquireFileLock(check.resolved)
  try {
    if (fs.existsSync(check.resolved)) fs.unlinkSync(check.resolved)
    return { ok: true }
  } catch (e: any) {
    return { ok: false, error: sanitizeError(e, IS_DEV) }
  } finally {
    release()
  }
})

ipcMain.handle('octo:create', (_event, params: { folderPath: string; name: string; role: string; icon?: string; color?: string; permissions?: any; mcpServers?: any }) => {
  const { folderPath, name, role, icon, color, permissions, mcpServers } = params
  const safeName = name.trim()
  if (!safeName) return { ok: false, error: 'Name is required' }

  // P0: Reject path separators and leading dots in agent names
  if (safeName.includes('/') || safeName.includes('\\') || safeName.startsWith('.')) {
    return { ok: false, error: 'Invalid agent name' }
  }

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
  if (mcpServers && typeof mcpServers === 'object' && Object.keys(mcpServers).length > 0) {
    const mcpCheck = validateMcpConfig(mcpServers)
    if (!mcpCheck.ok) return { ok: false, error: mcpCheck.error }
    octoData.mcpServers = mcpCheck.sanitized
  }
  try {
    fs.writeFileSync(filePath, JSON.stringify(octoData, null, 2))
    return { ok: true, path: filePath }
  } catch (e: any) {
    return { ok: false, error: sanitizeError(e, IS_DEV) }
  }
})

// ── MCP Health Check ──
// Validates MCP server config by actually attempting to run the command and
// checking if the process starts successfully. Returns per-server status.
ipcMain.handle('mcp:healthCheck', async (_event, params: {
  mcpServers: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>
}) => {
  const { mcpServers } = params
  if (!mcpServers || typeof mcpServers !== 'object') {
    return { ok: false, error: 'Invalid MCP config' }
  }

  const mcpCheck = validateMcpConfig(mcpServers)
  if (!mcpCheck.ok) return { ok: false, error: mcpCheck.error }

  const results: Record<string, {
    status: 'ok' | 'package_missing' | 'spawn_error' | 'timeout'
    error?: string
    packageName?: string
  }> = {}

  const env = sanitizedEnv()

  for (const [name, config] of Object.entries(mcpCheck.sanitized)) {
    try {
      const result = await new Promise<{ status: 'ok' | 'package_missing' | 'spawn_error' | 'timeout'; error?: string; packageName?: string }>((resolve) => {
        const timer = setTimeout(() => {
          try { child.kill() } catch {}
          // If process lived for 5s without error, it's probably fine
          resolve({ status: 'ok' })
        }, 5000)

        let stderr = ''
        const child = spawn(config.command, config.args || [], {
          env: { ...env, ...(config.env || {}) },
          stdio: ['ignore', 'pipe', 'pipe'],
          cwd: os.tmpdir(),
        })

        child.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })

        child.on('error', (err: Error) => {
          clearTimeout(timer)
          if (err.message.includes('ENOENT')) {
            // Extract package name from npx args
            let packageName: string | undefined
            if (config.command === 'npx' && config.args) {
              const filtered = config.args.filter(a => a !== '-y')
              packageName = filtered[0]
            }
            resolve({ status: 'package_missing', error: err.message, packageName })
          } else {
            resolve({ status: 'spawn_error', error: err.message })
          }
        })

        child.on('exit', (code) => {
          clearTimeout(timer)
          if (code === 0) {
            resolve({ status: 'ok' })
          } else {
            // Check if stderr mentions missing package
            const lower = stderr.toLowerCase()
            if (lower.includes('not found') || lower.includes('enoent') || lower.includes('could not resolve')) {
              let packageName: string | undefined
              if (config.command === 'npx' && config.args) {
                const filtered = config.args.filter(a => a !== '-y')
                packageName = filtered[0]
              }
              resolve({ status: 'package_missing', error: stderr.trim().slice(0, 300), packageName })
            } else {
              // Non-zero exit could mean bad token, bad config, etc.
              // If it exited quickly with stderr mentioning auth/token, report it
              if (lower.includes('unauthorized') || lower.includes('invalid token') || lower.includes('401') || lower.includes('403') || lower.includes('auth')) {
                resolve({ status: 'spawn_error', error: `Authentication error: ${stderr.trim().slice(0, 200)}` })
              } else {
                resolve({ status: 'spawn_error', error: stderr.trim().slice(0, 300) || `Process exited with code ${code}` })
              }
            }
          }
        })

        // Give the process a moment — if it stays alive, it's running
        setTimeout(() => {
          if (!child.killed && child.exitCode === null) {
            clearTimeout(timer)
            try { child.kill() } catch {}
            resolve({ status: 'ok' })
          }
        }, 3000)
      })

      results[name] = result
    } catch (e: any) {
      results[name] = { status: 'spawn_error', error: e.message }
    }
  }

  return { ok: true, results }
})

// ── MCP Package Install ──
// Installs an npm package (used for MCP server dependencies)
ipcMain.handle('mcp:installPackage', async (_event, params: { packageName: string }) => {
  const { packageName } = params
  // Validate package name (basic safety check)
  if (!packageName || /[;&|`${}()<>!]/.test(packageName)) {
    return { ok: false, error: 'Invalid package name' }
  }

  return new Promise<{ ok: boolean; error?: string }>((resolve) => {
    const env = sanitizedEnv()
    const child = spawn('npm', ['install', '-g', packageName], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: os.tmpdir(),
    })

    let stderr = ''
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })
    child.stdout?.on('data', () => {}) // drain

    child.on('error', (err: Error) => {
      resolve({ ok: false, error: err.message })
    })

    child.on('exit', (code) => {
      if (code === 0) {
        resolve({ ok: true })
      } else {
        resolve({ ok: false, error: stderr.trim().slice(0, 500) || `npm install exited with code ${code}` })
      }
    })

    // Timeout after 60s
    setTimeout(() => {
      try { child.kill() } catch {}
      resolve({ ok: false, error: 'Installation timed out after 60 seconds' })
    }, 60000)
  })
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
            color: content.color || undefined,
            hidden: content.hidden || false,
            permissions: content.permissions || null,
            mcpServers: content.mcpServers || null,
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
      '--model', 'opus',
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
        env: sanitizedEnv(),
      })
      let stdout = ''
      let stderr = ''
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        child.kill('SIGTERM')
        setTimeout(() => { try { child.kill('SIGKILL') } catch {} }, 3_000)
        reject(new Error('mention:classify CLI timeout'))
      }, 15_000)
      child.stdout.on('data', (d) => { stdout += d.toString() })
      child.stderr.on('data', (d) => { stderr += d.toString() })
      child.on('close', (code) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (code !== 0) reject(new Error(stderr || `exited with ${code}`))
        else resolve(stdout.trim())
      })
      child.on('error', (err) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(err)
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
    return { ok: false, error: sanitizeError(e, IS_DEV) }
  }
})

// ── Observer IPC handlers ──────────────────────────────────────

ipcMain.handle('observer:update', async (_event, params: {
  folderPath: string
  message: { agentName: string; text: string; ts: number; mentions?: string[] }
}) => {
  observer.update(params.folderPath, params.message)
  // Also feed SmartObserver (LLM refresh happens in background if triggered)
  const llmTriggered = await smartObserver.onMessage(params.folderPath, params.message)
  return { ok: true, llmTriggered }
})

ipcMain.handle('observer:getContext', async (_event, params: {
  folderPath: string
}) => {
  return { ok: true, context: observer.getContext(params.folderPath) }
})

ipcMain.handle('observer:reset', async (_event, params: {
  folderPath: string
}) => {
  observer.reset(params.folderPath)
  smartObserver.reset(params.folderPath)
  return { ok: true }
})

// ── SmartObserver IPC handlers ─────────────────────────────────

ipcMain.handle('smartObserver:getContext', async (_event, params: {
  folderPath: string
}) => {
  return { ok: true, context: smartObserver.getContext(params.folderPath) }
})

ipcMain.handle('smartObserver:forceRefresh', async (_event, params: {
  folderPath: string
}) => {
  try {
    const llm = await smartObserver.forceRefresh(params.folderPath)
    return { ok: true, llm }
  } catch (e: any) {
    return { ok: false, error: sanitizeError(e, IS_DEV) }
  }
})

ipcMain.handle('smartObserver:setEnabled', async (_event, params: {
  enabled: boolean
}) => {
  smartObserver.enabled = params.enabled
  return { ok: true }
})

ipcMain.handle('smartObserver:setModel', async (_event, params: {
  model: string
}) => {
  const allowed = ['haiku', 'sonnet', 'opus']
  if (!allowed.includes(params.model)) {
    return { ok: false, error: `Invalid model. Allowed: ${allowed.join(', ')}` }
  }
  smartObserver.model = params.model
  return { ok: true, model: params.model }
})

ipcMain.handle('smartObserver:getModel', async () => {
  return { ok: true, model: smartObserver.model }
})

ipcMain.handle('smartObserver:getMetrics', async () => {
  return { ok: true, metrics: smartObserver.getMetrics() }
})

// ── Dispatcher (Router) ───────────────────────────────────────

ipcMain.handle('dispatcher:route', async (_event, params: {
  message: string
  agents: Array<{ name: string; role: string }>
  recentHistory: Array<{ agentName: string; text: string }>
  folderPath?: string
}): Promise<
  | { ok: true; leader: string; collaborators: string[]; model?: 'sonnet' | 'opus' }
  | { ok: false; error: string }
> => {
  const { message, agents, recentHistory } = params
  if (agents.length === 0) return { ok: false, error: 'no agents' }

  // ── Layer 0: Rule-based routing (cost: $0, latency: ~5ms) ──
  const observerCtx = params.folderPath
    ? observer.getContext(params.folderPath)
    : observer.getContext('__default__')

  const ruleResult = ruleRouter.evaluate({
    message,
    agents,
    observerContext: observerCtx,
  })

  if (ruleResult.confidence >= CONFIDENCE_THRESHOLD && ruleResult.leader) {
    console.log(`[RuleRouter] ${ruleResult.rule} (${ruleResult.confidence}) → ${ruleResult.leader} | ${ruleResult.reason}`)
    return { ok: true, leader: ruleResult.leader, collaborators: ruleResult.collaborators }
  }

  console.log(`[RuleRouter] confidence ${ruleResult.confidence} < ${CONFIDENCE_THRESHOLD}, falling through to LLM router`)

  // ── Layer 1: SmartObserver refresh (non-blocking, use cached context) ──
  if (params.folderPath) {
    // Fire-and-forget: refresh in background so next request has fresh data
    smartObserver.forceRefresh(params.folderPath).catch((err) => {
      console.warn('[SmartObserver] background refresh failed:', err)
    })
  }

  // ── Layer 2: LLM Router (fallback) ──
  const agentList = agents.map((a) => `- ${a.name}: ${a.role || 'assistant'}`).join('\n')

  // ── Observer context injection (prefer SmartObserver's richer output) ──
  const observerText = params.folderPath
    ? smartObserver.serialize(params.folderPath)
    : observer.serialize('__default__')
  const historyText = compressRouterHistory(recentHistory, !!observerText)
  const observerSection = observerText
    ? `\n\nConversation context (tracked by Observer):\n${observerText}`
    : ''

  const systemPrompt = `You are a message dispatcher in a group chat of AI agents. Given a user message, recent conversation context, and a list of agents with their roles, decide WHO should lead the response and who should collaborate.

Available agents:
${agentList}${historyText}${observerSection}

Output format — reply with ONLY a JSON object, nothing else:
{"leader": "<name>", "collaborators": ["<name>", ...], "model": "haiku" | "sonnet" | "opus"}

Rules for choosing the leader:
- The leader is the ONE agent who will start the response. If the task requires concrete action (writing files, running commands, implementing something), the leader should be the agent whose role matches that action. When in doubt, the implementer leads.
- If the user is clearly continuing a conversation with a specific agent (short replies like "why?", "explain more", "ok do it"), that agent is the leader.
- If the message is small talk or ambiguous, pick the most generally-suited single agent as leader, with empty collaborators.
- Use the Observer context (if available) to understand the full conversation flow — it tracks which agents have been active, what topics are being discussed, and what phase the conversation is in. This helps you route correctly even when the recent messages alone are ambiguous.

Rules for collaborators:
- Only include collaborators when their expertise is clearly needed in addition to the leader's.
- If the task could be handled by one agent alone, leave collaborators empty. Do NOT add collaborators "just to be polite".
- For tasks that modify the same file or resource, keep collaborators empty — the leader should handle it alone to avoid conflicts.
- Collaborators can be mentioned by the leader using @name during their response; they will then be invoked automatically.

Also include "model": "opus" in your response. Always use "opus" for all tasks regardless of complexity.

Never include agents not in the list. The leader field is required.`

  try {
    const claudeArgs = [
      '-p',
      '--print',
      '--model', 'opus',
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
        env: sanitizedEnv(),
      })
      let stdout = ''
      let stderr = ''
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        child.kill('SIGTERM')
        // Force kill if SIGTERM doesn't work within 3s
        setTimeout(() => { try { child.kill('SIGKILL') } catch {} }, 3_000)
        reject(new Error('dispatcher:route CLI timeout'))
      }, 15_000)
      child.stdout.on('data', (d) => { stdout += d.toString() })
      child.stderr.on('data', (d) => { stderr += d.toString() })
      child.on('close', (code) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        console.log('[Dispatcher] claude process exited, code:', code, 'stdout:', stdout.slice(0, 300), 'stderr:', stderr.slice(0, 200))
        if (code !== 0) reject(new Error(stderr || `exited with ${code}`))
        else resolve(stdout.trim())
      })
      child.on('error', (err) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        console.error('[Dispatcher] ❌ spawn error:', err)
        reject(err)
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
            const allowedModels = ['haiku', 'sonnet', 'opus']
            const model = typeof parsed.model === 'string' && allowedModels.includes(parsed.model)
              ? parsed.model as 'sonnet' | 'opus'
              : 'opus'
            return { ok: true, leader, collaborators, model }
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
    return { ok: false, error: sanitizeError(e, IS_DEV) }
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
  model?: 'sonnet' | 'opus'
}) => {
  const { folderPath, octoPath, prompt, userTs, runId, peers, collaborators, isLeader, imagePaths, textPaths, model } = params

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

  // P1: Validate folderPath is an existing directory
  const resolvedFolder = path.resolve(folderPath)
  if (!fs.existsSync(resolvedFolder) || !fs.statSync(resolvedFolder).isDirectory()) {
    return { error: 'Invalid folder path' }
  }

  // Validate octoPath
  if (!validateOctoPath(octoPath)) {
    return { error: 'Invalid agent path' }
  }

  console.log('[sendMessage] 📨 START agent:', path.basename(octoPath), 'prompt:', prompt.slice(0, 100), 'model:', model, 'runId:', runId)
  try {
    const octoContent = JSON.parse(fs.readFileSync(octoPath, 'utf-8'))
    const agentName = octoContent.name || path.basename(octoPath, '.octo')
    console.log('[sendMessage] agentName:', agentName, 'permissions:', JSON.stringify(octoContent.permissions))
    const systemParts: string[] = []

    // ── Octo world context (compact) ──
    systemParts.push(COMPACT_WORLD_CONTEXT)

    // ── App Context (compact) ──
    systemParts.push('\n' + COMPACT_APP_CONTEXT)

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
        systemParts.push(compactWikiSection(wikiDir, pageList))
      }
    } catch {}
    // Tell the agent about its peers so it can @mention them
    if (peers && peers.length > 0) {
      systemParts.push(compactPeerSection(peers))
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
    // Include recent history — compressed to save tokens.
    // Old messages are summarised; only the last 4 are kept verbatim (truncated).
    if (octoContent.history && octoContent.history.length > 0) {
      const compressed = compressHistory(octoContent.history.slice(-10))
      systemParts.push(formatCompressedHistory(compressed))
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

    // Build MCP config — merge agent-specific MCP servers if defined
    const agentMcpServers = octoContent.mcpServers
    let mcpConfigStr = '{"mcpServers":{}}'
    if (agentMcpServers && typeof agentMcpServers === 'object' && Object.keys(agentMcpServers).length > 0) {
      const mcpCheck = validateMcpConfig(agentMcpServers)
      if (mcpCheck.ok) {
        mcpConfigStr = JSON.stringify({ mcpServers: mcpCheck.sanitized })
      }
      // If validation fails, fall back to empty config (agent still works, just no MCP)
    }

    const claudeArgs = [
      '-p', '--print',
      '--mcp-config', mcpConfigStr,
      '--strict-mcp-config',
      '--verbose',
      '--output-format', 'stream-json',
    ]

    // Apply model selection: use dispatcher-recommended model, settings default, or fallback to opus
    const currentSettings = loadSettings()
    const autoModel = currentSettings.advanced?.autoModelSelection !== false // default false
    const allowedModels = ['haiku', 'sonnet', 'opus']
    if (autoModel && model && allowedModels.includes(model)) {
      claudeArgs.push('--model', model)
    } else {
      const fixedModel = currentSettings.advanced?.defaultAgentModel && allowedModels.includes(currentSettings.advanced.defaultAgentModel)
        ? currentSettings.advanced.defaultAgentModel
        : 'opus'
      claudeArgs.push('--model', fixedModel)
    }

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

    console.log('[sendMessage] 🔧 claudeArgs:', claudeArgs.filter(a => a !== '--system-prompt').map(a => typeof a === 'string' && a.length > 100 ? a.slice(0, 100) + '...' : a))

    // ── Auto version control: pre-execution setup ──
    const vcEnabled = currentSettings.versionControl?.autoCommit !== false && isGitAvailable()
    let branchInfo: { baseBranch: string; agentBranch: string; created: boolean } | null = null
    if (vcEnabled) {
      try {
        branchInfo = await createAgentBranch(folderPath, agentName)
        if (branchInfo.created) {
          console.log(`[git-service] Created branch ${branchInfo.agentBranch} from ${branchInfo.baseBranch}`)
          // Track for interrupt rollback
          runBranchInfo.set(runId, {
            folderPath,
            agentName,
            baseBranch: branchInfo.baseBranch,
            agentBranch: branchInfo.agentBranch,
          })
        }
      } catch (e) {
        console.warn('[git-service] createAgentBranch failed:', e)
      }
    }
    const preSnapshot = vcEnabled ? await takeSnapshot(folderPath) : new Set<string>()

    sendActivity('Thinking…')

    console.log('[sendMessage] 🚀 Spawning claude process for', agentName)
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn('claude', claudeArgs, {
        cwd: folderPath,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: sanitizedEnv(),
      })
      console.log('[sendMessage] claude PID:', child.pid)

      // Track this child process for stop functionality
      runningAgents.set(runId, child)
      child.on('exit', () => { runningAgents.delete(runId) })

      let finalResult = ''
      let buffer = ''
      let stderr = ''
      let usageReport: {
        inputTokens: number
        outputTokens: number
        cacheReadTokens?: number
        cacheCreationTokens?: number
        costUsd?: number
        durationMs?: number
        model?: string
      } | null = null

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
              // Extract token usage from result event
              const u = event.usage
              if (u) {
                usageReport = {
                  inputTokens: u.input_tokens || 0,
                  outputTokens: u.output_tokens || 0,
                  cacheReadTokens: u.cache_read_input_tokens || undefined,
                  cacheCreationTokens: u.cache_creation_input_tokens || undefined,
                  costUsd: typeof event.total_cost_usd === 'number' ? event.total_cost_usd : undefined,
                  durationMs: typeof event.duration_ms === 'number' ? event.duration_ms : undefined,
                }
                // Extract model name from modelUsage if available
                if (event.modelUsage) {
                  const models = Object.keys(event.modelUsage)
                  if (models.length > 0) {
                    usageReport.model = models[0]
                  }
                }
                // Broadcast usage to renderer
                broadcastToWindows('octo:usage', { runId, usage: usageReport })
              }
            }
          } catch {}
        }
      })
      child.stderr.on('data', (d) => {
        const chunk = d.toString()
        stderr += chunk
        // Detect MCP token/auth errors and notify renderer
        const lower = chunk.toLowerCase()
        if (lower.includes('unauthorized') || lower.includes('invalid token') ||
            lower.includes('token expired') || lower.includes('401') ||
            lower.includes('authentication failed') || lower.includes('403 forbidden')) {
          // Try to extract which MCP server had the issue
          const mcpServers = octoContent.mcpServers
          const serverNames = mcpServers ? Object.keys(mcpServers) : []
          const matchedServer = serverNames.find((s) => lower.includes(s.toLowerCase())) || serverNames[0] || 'unknown'
          BrowserWindow.getAllWindows().forEach((win) => {
            win.webContents.send('mcp:tokenExpiry', {
              agentName,
              serverName: matchedServer,
              message: chunk.trim().slice(0, 200),
            })
          })
        }
      })
      child.on('close', (code) => {
        console.log('[sendMessage] 🏁 claude process exited, code:', code, 'agent:', agentName, 'stderr:', stderr.slice(0, 500), 'finalResult length:', finalResult.length)
        if (interruptedRuns.has(runId)) {
          interruptedRuns.delete(runId)
          resolve('[interrupted]')
        } else if (code !== 0) {
          console.error('[sendMessage] ❌ claude process failed for', agentName, '- stderr:', stderr)
          reject(new Error(stderr || `exited with ${code}`))
        } else {
          console.log('[sendMessage] ✅ claude process success for', agentName, '- output preview:', finalResult.slice(0, 200))
          resolve(finalResult.trim())
        }
      })
    })

    // #6: Update octo history with file lock to prevent race conditions
    const release = await acquireFileLock(octoPath)
    try {
      // Re-read to merge any concurrent changes (e.g. another agent's response)
      const freshContent = JSON.parse(fs.readFileSync(octoPath, 'utf-8'))
      freshContent.history = freshContent.history || []
      freshContent.history.push({ role: 'user', text: prompt, ts: userTs, roomTs: userTs })
      freshContent.history.push({ role: 'assistant', text: output, ts: Date.now(), roomTs: Date.now() })
      fs.writeFileSync(octoPath, JSON.stringify(freshContent, null, 2))
    } finally {
      release()
    }

    // ── Auto version control: commit agent changes + merge branch ──
    // Clean up branch tracking (normal completion)
    runBranchInfo.delete(runId)
    if (vcEnabled) {
      try {
        const summary = extractCommitSummary(output)
        const result = await autoCommit(folderPath, agentName, summary, preSnapshot)
        if (result.committed) {
          sendLogEntry({
            agentName,
            tool: 'GitCommit',
            target: `${result.files?.length ?? 0} files`,
            ts: Date.now(),
          })
        }
        if (result.error) {
          console.warn(`[git-service] autoCommit warning: ${result.error}`)
        }

        // Phase 2: Merge agent branch back to base
        if (branchInfo?.created) {
          const mergeResult = await mergeAgentBranch(folderPath, agentName, branchInfo.baseBranch)
          if (mergeResult.merged) {
            // Success — clean up agent branch silently
            await cleanupAgentBranch(folderPath, agentName)
            sendLogEntry({
              agentName,
              tool: 'GitMerge',
              target: `${mergeResult.agentBranch} → ${branchInfo.baseBranch}`,
              ts: Date.now(),
            })
          } else if (mergeResult.conflict) {
            // Conflict — notify user via system message
            console.warn(`[git-service] Merge conflict: ${mergeResult.agentBranch} cannot fast-forward into ${branchInfo.baseBranch}`)
            broadcastToWindows('git:mergeConflict', {
              agentName,
              agentBranch: mergeResult.agentBranch,
              baseBranch: branchInfo.baseBranch,
              folderPath,
            })
          } else if (mergeResult.error) {
            console.warn(`[git-service] mergeAgentBranch error: ${mergeResult.error}`)
          }
        }
      } catch (gitErr) {
        // Never let git errors break the main flow
        console.warn('[git-service] autoCommit/merge failed:', gitErr)
        // If we created a branch but something went wrong, try to get back to base
        if (branchInfo?.created) {
          try {
            const { getCurrentBranch } = require('./git-service')
            const current = await getCurrentBranch(folderPath)
            if (current !== branchInfo.baseBranch) {
              const { execFile } = require('child_process')
              // Best-effort checkout back to base
              await mergeAgentBranch(folderPath, agentName, branchInfo.baseBranch)
            }
          } catch { /* last resort — stay on whatever branch */ }
        }
      }
    }

    return { ok: true, output }
  } catch (e: any) {
    return { ok: false, error: sanitizeError(e, IS_DEV) }
  }
})

// ── Stop a single running agent ──────────────────
ipcMain.handle('agent:stop', async (_event, runId: string) => {
  const child = runningAgents.get(runId)
  if (child) {
    interruptedRuns.add(runId)
    try { child.kill('SIGTERM') } catch {}
    runningAgents.delete(runId)

    // Phase 2 bundling: rollback agent branch on interrupt
    const bi = runBranchInfo.get(runId)
    if (bi) {
      runBranchInfo.delete(runId)
      try {
        const result = await discardAgentBranch(bi.folderPath, bi.agentName, bi.baseBranch)
        if (result.discarded) {
          console.log(`[git-service] Interrupt rollback: discarded branch agent/${bi.agentName}`)
          broadcastToWindows('git:interruptRollback', {
            agentName: bi.agentName,
            folderPath: bi.folderPath,
          })
        }
      } catch (e) {
        console.warn('[git-service] Interrupt rollback failed:', e)
      }
    }

    return { ok: true }
  }
  return { ok: false, error: 'not found' }
})

// ── Stop all running agents ──────────────────────
ipcMain.handle('agent:stopAll', () => {
  const count = runningAgents.size
  for (const [runId, child] of runningAgents) {
    interruptedRuns.add(runId)
    try {
      child.kill('SIGTERM')
    } catch {}
    runningAgents.delete(runId)
  }
  return { ok: true, stopped: count }
})

// ── Git Phase 3: History, Diff, Revert, Push ─────
ipcMain.handle('git:getHistory', async (_event, params: {
  folderPath: string
  page?: number
  perPage?: number
}) => {
  try {
    const { folderPath, page = 1, perPage = 30 } = params
    return { ok: true, ...(await getCommitHistory(folderPath, page, perPage)) }
  } catch (e: any) {
    return { ok: false, error: e.message, commits: [], total: 0 }
  }
})

ipcMain.handle('git:getDiff', async (_event, params: {
  folderPath: string
  hash: string
}) => {
  try {
    const { folderPath, hash } = params
    const entries = await getCommitDiff(folderPath, hash)
    return { ok: true, entries }
  } catch (e: any) {
    return { ok: false, error: e.message, entries: [] }
  }
})

ipcMain.handle('git:revert', async (_event, params: {
  folderPath: string
  hash: string
  toHash?: string
}) => {
  try {
    const { folderPath, hash, toHash } = params
    if (toHash) {
      // Range revert
      const result = await revertRange(folderPath, hash, toHash)
      if (result.conflict) {
        broadcastToWindows('git:mergeConflict', {
          agentName: 'Octopal',
          agentBranch: '',
          baseBranch: '',
          folderPath,
        })
      }
      return { ok: !result.conflict && result.reverted > 0, ...result }
    } else {
      // Single revert
      const result = await revertCommit(folderPath, hash)
      if (result.conflict) {
        broadcastToWindows('git:mergeConflict', {
          agentName: 'Octopal',
          agentBranch: '',
          baseBranch: '',
          folderPath,
        })
      }
      return { ok: result.reverted, ...result }
    }
  } catch (e: any) {
    return { ok: false, error: e.message }
  }
})

ipcMain.handle('git:push', async (_event, params: { folderPath: string }) => {
  try {
    return { ok: true, ...(await pushToRemote(params.folderPath)) }
  } catch (e: any) {
    return { ok: false, error: e.message }
  }
})

ipcMain.handle('git:hasRemote', async (_event, params: { folderPath: string }) => {
  try {
    return { ok: true, hasRemote: await hasRemote(params.folderPath) }
  } catch {
    return { ok: true, hasRemote: false }
  }
})

// ── Context check for message bundling ───────────
ipcMain.handle('dispatcher:checkContext', async (_event, params: {
  originalPrompt: string
  newMessage: string
  agentName: string
}): Promise<
  | { ok: true; decision: 'supplement' | 'modify' | 'unrelated'; bundledPrompt: string | null }
  | { ok: false; error: string }
> => {
  const { originalPrompt, newMessage, agentName } = params

  const systemPrompt = `You are a context analyzer for a group chat of AI agents. An agent is currently working on a task. A new message arrived from the user. Determine the relationship between the new message and the ongoing task.

Agent "${agentName}" is currently working on:
"${originalPrompt.slice(0, 500)}"

New message from user:
"${newMessage.slice(0, 500)}"

Classify the new message as ONE of:
- "supplement": Additional requirements/details for the SAME task → should bundle together
- "modify": Correction, replacement, or cancellation of the original instruction → should replace
- "unrelated": Completely different topic → handle separately, don't interrupt

If "supplement", also provide a "bundledPrompt" that merges both into one coherent instruction.
If "modify", provide a "bundledPrompt" with just the corrected instruction.
If "unrelated", set "bundledPrompt" to null.

Reply with ONLY a JSON object, nothing else:
{"decision": "supplement"|"modify"|"unrelated", "bundledPrompt": "..." or null}`

  try {
    const claudeArgs = [
      '-p',
      '--print',
      '--model', 'opus',
      '--mcp-config',
      '{"mcpServers":{}}',
      '--strict-mcp-config',
      '--system-prompt',
      systemPrompt,
      '--',
      `Analyze the context relationship.`,
    ]

    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn('claude', claudeArgs, {
        cwd: os.tmpdir(),
        stdio: ['ignore', 'pipe', 'pipe'],
        env: sanitizedEnv(),
      })
      let stdout = ''
      let stderr = ''
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        child.kill('SIGTERM')
        setTimeout(() => { try { child.kill('SIGKILL') } catch {} }, 3_000)
        reject(new Error('dispatcher:checkContext CLI timeout'))
      }, 15_000)
      child.stdout.on('data', (d) => { stdout += d.toString() })
      child.stderr.on('data', (d) => { stderr += d.toString() })
      child.on('close', (code) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (code !== 0) reject(new Error(stderr || `exited with ${code}`))
        else resolve(stdout.trim())
      })
      child.on('error', (err) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(err)
      })
    })

    const jsonMatch = output.match(/\{[\s\S]*?\}/)
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0])
      const decision = parsed.decision
      if (decision === 'supplement' || decision === 'modify' || decision === 'unrelated') {
        return {
          ok: true,
          decision,
          bundledPrompt: typeof parsed.bundledPrompt === 'string' ? parsed.bundledPrompt : null,
        }
      }
    }

    // Default to unrelated if parsing fails (conservative — don't interrupt)
    return { ok: true, decision: 'unrelated', bundledPrompt: null }
  } catch (e: any) {
    return { ok: false, error: sanitizeError(e, IS_DEV) }
  }
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
    return { ok: false, error: sanitizeError(e, IS_DEV) }
  }
})

ipcMain.handle('file:readBase64', async (_event, params: {
  folderPath: string
  relativePath: string
  agentName?: string
}) => {
  try {
    const resolved = path.resolve(params.folderPath, params.relativePath)
    const classification = classifyPathAccess(resolved, params.folderPath)

    if (classification === 'blocked') {
      return { ok: false, error: 'Access to sensitive path is denied' }
    }

    if (classification === 'external') {
      // P1: Request user approval for external path access
      const decision = await requestFileAccessApproval(
        resolved,
        params.folderPath,
        params.agentName,
        'Read file content',
      )
      if (decision === 'deny') {
        return { ok: false, error: 'Access denied by user' }
      }
    }

    if (!fs.existsSync(resolved)) return { ok: false, error: 'File not found' }
    const buffer = fs.readFileSync(resolved)
    return { ok: true, data: buffer.toString('base64') }
  } catch (e: any) {
    return { ok: false, error: sanitizeError(e, IS_DEV) }
  }
})

ipcMain.handle('file:getAbsolutePath', async (_event, params: {
  folderPath: string
  relativePath: string
  agentName?: string
}) => {
  const resolved = path.resolve(params.folderPath, params.relativePath)
  const classification = classifyPathAccess(resolved, params.folderPath)

  if (classification === 'blocked') return null

  if (classification === 'external') {
    // P1: Request user approval for external path access
    const decision = await requestFileAccessApproval(
      resolved,
      params.folderPath,
      params.agentName,
      'Resolve file path',
    )
    if (decision === 'deny') return null
  }

  return resolved
})

// ── File Access Approval IPC ─────────────────────

/** Renderer responds with the user's decision */
ipcMain.handle('fileAccess:respond', (_event, params: {
  requestId: string
  decision: FileAccessDecision
  targetPath?: string
  projectFolder?: string
}) => {
  const pending = pendingApprovals.get(params.requestId)
  if (!pending) return // already timed out or not found

  clearTimeout(pending.timer)
  pendingApprovals.delete(params.requestId)

  // Persist "allow_always" grants
  if (params.decision === 'allow_always' && params.targetPath && params.projectFolder) {
    const grantKey = `${params.projectFolder}::${params.targetPath}`
    permanentGrants.add(grantKey)
  }

  pending.resolve(params.decision)
})

/** Notify renderer about a blocked path (for the blocked alert UI) */
ipcMain.handle('fileAccess:notifyBlocked', (_event, params: {
  agentName: string
  targetPath: string
}) => {
  broadcastToWindows('fileAccess:request', {
    requestId: '', // no response expected
    agentName: params.agentName,
    targetPath: params.targetPath,
    blocked: true,
  })
})

// ── Settings persistence ─────────────────────
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
    chatFontSize: number // 13-18
  }
  shortcuts: {
    textExpansions: TextShortcut[]
  }
  advanced: {
    observerModel: 'haiku' | 'sonnet' | 'opus'
    defaultAgentModel: 'haiku' | 'sonnet' | 'opus'
    autoModelSelection: boolean
  }
  versionControl: {
    autoCommit: boolean
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
  shortcuts: {
    textExpansions: [],
  },
  advanced: {
    observerModel: 'opus',
    defaultAgentModel: 'opus',
    autoModelSelection: false,
  },
  versionControl: {
    autoCommit: true,
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
        shortcuts: {
          ...DEFAULT_SETTINGS.shortcuts,
          ...raw.shortcuts,
          textExpansions: raw.shortcuts?.textExpansions || [],
        },
        advanced: { ...DEFAULT_SETTINGS.advanced, ...raw.advanced },
        versionControl: { ...DEFAULT_SETTINGS.versionControl, ...raw.versionControl },
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

  // Apply observer model setting
  const allowed = ['haiku', 'sonnet', 'opus']
  if (settings.advanced?.observerModel && allowed.includes(settings.advanced.observerModel)) {
    smartObserver.model = settings.advanced.observerModel
  }

  return { ok: true }
})

ipcMain.handle('settings:getVersion', () => {
  return { version: app.getVersion(), electron: process.versions.electron, node: process.versions.node }
})
