import { app, BrowserWindow, ipcMain, dialog, protocol, net } from 'electron'
import path from 'path'
import fs from 'fs'
import crypto from 'crypto'
import os from 'os'
import { spawn } from 'child_process'

// RUNECHAT_PROD=1 forces the built renderer bundle even when running unpackaged,
// so `npm start` after `npm run build` behaves like a production app.
const IS_DEV = !app.isPackaged && process.env.RUNECHAT_PROD !== '1'

// Use a separate state file and userData dir in dev so you can run dev + prod
// side-by-side without them stomping on each other's workspaces.
const STATE_DIR = IS_DEV
  ? path.join(os.homedir(), '.runechat-dev')
  : path.join(os.homedir(), '.runechat')
const STATE_FILE = path.join(STATE_DIR, 'state.json')
if (IS_DEV) {
  app.setPath('userData', path.join(os.homedir(), 'Library', 'Application Support', 'RuneChat Dev'))
}

// Folder watchers — notify renderer when .rune files change
const watchers = new Map<string, { watcher: fs.FSWatcher; debounce: ReturnType<typeof setTimeout> | null }>()
let mainWindow: BrowserWindow | null = null

function watchFolder(folderPath: string) {
  if (watchers.has(folderPath)) return
  if (!fs.existsSync(folderPath)) return
  try {
    const watcher = fs.watch(folderPath, (_eventType, filename) => {
      if (!filename || !filename.endsWith('.rune')) return
      const entry = watchers.get(folderPath)
      if (!entry) return
      if (entry.debounce) clearTimeout(entry.debounce)
      entry.debounce = setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('folder:runesChanged', folderPath)
        }
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

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 14, y: 16 },
    backgroundColor: '#0e0e10',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  mainWindow = win
  win.on('closed', () => { mainWindow = null })

  if (IS_DEV) {
    win.loadURL('http://localhost:5173')
    win.webContents.openDevTools()
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'renderer', 'index.html'))
  }
}

// Register custom protocol for loading local files (uploads) in the renderer
protocol.registerSchemesAsPrivileged([
  { scheme: 'local-file', privileges: { bypassCSP: true, stream: true, supportFetchAPI: true } },
])

app.whenReady().then(() => {
  // Handle local-file:// protocol — maps absolute paths to file responses
  protocol.handle('local-file', (request) => {
    // URL format: local-file:///absolute/path/to/file
    const filePath = decodeURIComponent(new URL(request.url).pathname)
    return net.fetch(`file://${filePath}`)
  })

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  unwatchAll()
  if (process.platform !== 'darwin') app.quit()
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

// ── IPC handlers ──────────────────────────────

ipcMain.handle('state:load', () => loadState())

ipcMain.handle('workspace:create', (_event, name: string) => {
  const state = loadState()
  const id = 'ws-' + Date.now()
  state.workspaces.push({ id, name: name.trim() || 'Untitled', folders: [] })
  state.activeWorkspaceId = id
  saveState(state)
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
// Project-scoped markdown notes stored at <folder>/.runechat/wiki/*.md.
// Both agents (via Read/Write tools) and the user (via the Wiki tab) can edit them.

function getWikiDir(folderPath: string): string {
  return path.join(folderPath, '.runechat', 'wiki')
}

function sanitizeWikiName(name: string): string | null {
  const trimmed = name.trim()
  if (!trimmed) return null
  // Only allow safe characters — block traversal.
  if (trimmed.includes('/') || trimmed.includes('\\') || trimmed.startsWith('.')) return null
  return trimmed.endsWith('.md') ? trimmed : `${trimmed}.md`
}

ipcMain.handle('wiki:list', (_event, folderPath: string) => {
  try {
    const dir = getWikiDir(folderPath)
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

ipcMain.handle('wiki:read', (_event, params: { folderPath: string; name: string }) => {
  try {
    const safe = sanitizeWikiName(params.name)
    if (!safe) return { ok: false, error: 'Invalid name' }
    const filePath = path.join(getWikiDir(params.folderPath), safe)
    if (!fs.existsSync(filePath)) return { ok: false, error: 'Not found' }
    return { ok: true, content: fs.readFileSync(filePath, 'utf-8') }
  } catch (e: any) {
    return { ok: false, error: e.message || String(e) }
  }
})

ipcMain.handle('wiki:write', (_event, params: { folderPath: string; name: string; content: string }) => {
  try {
    const safe = sanitizeWikiName(params.name)
    if (!safe) return { ok: false, error: 'Invalid name' }
    const dir = getWikiDir(params.folderPath)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, safe), params.content)
    return { ok: true, name: safe }
  } catch (e: any) {
    return { ok: false, error: e.message || String(e) }
  }
})

ipcMain.handle('wiki:delete', (_event, params: { folderPath: string; name: string }) => {
  try {
    const safe = sanitizeWikiName(params.name)
    if (!safe) return { ok: false, error: 'Invalid name' }
    const filePath = path.join(getWikiDir(params.folderPath), safe)
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
    return { ok: true }
  } catch (e: any) {
    return { ok: false, error: e.message || String(e) }
  }
})

// ── Room log (user messages) ──
// User messages are written immediately on send to a per-folder sidecar file so
// they survive even if no agent responds. Agent replies still live inside each
// .rune's own history array; loadHistory merges both.
interface RoomUserMessage {
  id: string
  ts: number
  text: string
  attachments?: any[]
}

function getRoomLogPath(folderPath: string): string {
  return path.join(folderPath, '.runechat', 'room-log.json')
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
    const dir = path.join(folderPath, '.runechat')
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

ipcMain.handle('folder:loadHistory', (_event, folderPath: string) => {
  // Merge user messages (from room-log) with assistant messages (from .rune files)
  try {
    if (!fs.existsSync(folderPath)) return []
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

    // 2) Assistant messages from each .rune history
    const files = fs.readdirSync(folderPath).filter((f) => f.endsWith('.rune'))
    for (const f of files) {
      const fullPath = path.join(folderPath, f)
      try {
        const rune = JSON.parse(fs.readFileSync(fullPath, 'utf-8'))
        const name = rune.name || f.replace('.rune', '')
        const history = rune.history || []
        for (let i = 0; i < history.length; i++) {
          const msg = history[i]
          // Skip user messages from .rune history — room-log is the source of truth now.
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
  } catch {
    return []
  }
})

interface RunePermissions {
  fileWrite?: boolean
  bash?: boolean
  network?: boolean
  allowPaths?: string[]
  denyPaths?: string[]
}

function buildPermissionArgs(permissions?: RunePermissions): string[] {
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

ipcMain.handle('rune:update', (_event, params: {
  runePath: string
  name?: string
  role?: string
  icon?: string
  color?: string
  permissions?: RunePermissions
}) => {
  try {
    if (!fs.existsSync(params.runePath)) {
      return { ok: false, error: 'File not found' }
    }
    const content = JSON.parse(fs.readFileSync(params.runePath, 'utf-8'))
    let finalPath = params.runePath
    if (params.name !== undefined) content.name = params.name.trim() || content.name
    if (params.role !== undefined) content.role = params.role
    if (params.icon !== undefined) content.icon = params.icon
    if (params.color !== undefined) content.color = params.color
    if (params.permissions !== undefined) content.permissions = params.permissions

    // Rename file if name changed
    if (params.name && params.name.trim()) {
      const dir = path.dirname(params.runePath)
      const newFileName = params.name.trim().endsWith('.rune')
        ? params.name.trim()
        : `${params.name.trim()}.rune`
      const newPath = path.join(dir, newFileName)
      if (newPath !== params.runePath) {
        if (fs.existsSync(newPath)) {
          return { ok: false, error: 'A rune with that name already exists' }
        }
        fs.writeFileSync(params.runePath, JSON.stringify(content, null, 2))
        fs.renameSync(params.runePath, newPath)
        finalPath = newPath
      } else {
        fs.writeFileSync(params.runePath, JSON.stringify(content, null, 2))
      }
    } else {
      fs.writeFileSync(params.runePath, JSON.stringify(content, null, 2))
    }
    return { ok: true, path: finalPath }
  } catch (e: any) {
    return { ok: false, error: e.message || String(e) }
  }
})

ipcMain.handle('rune:delete', (_event, runePath: string) => {
  try {
    if (fs.existsSync(runePath)) fs.unlinkSync(runePath)
    return { ok: true }
  } catch (e: any) {
    return { ok: false, error: e.message || String(e) }
  }
})

ipcMain.handle('rune:create', (_event, params: { folderPath: string; name: string; role: string; icon?: string; color?: string; permissions?: any }) => {
  const { folderPath, name, role, icon, color, permissions } = params
  const safeName = name.trim()
  if (!safeName) return { ok: false, error: 'Name is required' }
  const fileName = safeName.endsWith('.rune') ? safeName : `${safeName}.rune`
  const filePath = path.join(folderPath, fileName)
  if (fs.existsSync(filePath)) {
    return { ok: false, error: 'A rune with that name already exists' }
  }
  const runeData: any = {
    name: safeName.replace('.rune', ''),
    role: role.trim() || 'Assistant',
    icon: icon || 'bot',
    createdAt: new Date().toISOString(),
    history: [],
  }
  if (permissions) {
    runeData.permissions = permissions
  }
  try {
    fs.writeFileSync(filePath, JSON.stringify(runeData, null, 2))
    return { ok: true, path: filePath }
  } catch (e: any) {
    return { ok: false, error: e.message || String(e) }
  }
})

ipcMain.handle('folder:listRunes', (_event, folderPath: string) => {
  try {
    if (!fs.existsSync(folderPath)) return []
    watchFolder(folderPath)
    const files = fs.readdirSync(folderPath)
      .filter((f) => f.endsWith('.rune'))
      .map((f) => {
        const fullPath = path.join(folderPath, f)
        try {
          const content = JSON.parse(fs.readFileSync(fullPath, 'utf-8'))
          return {
            path: fullPath,
            name: content.name || f.replace('.rune', ''),
            role: content.role || '',
            icon: content.icon || 'bot',
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

ipcMain.handle('rune:sendMessage', async (_event, params: {
  folderPath: string
  runePath: string
  prompt: string
  userTs: number
  runId: string
  peers?: Array<{ name: string; role: string }>
  collaborators?: Array<{ name: string; role: string }>
  isLeader?: boolean
  imagePaths?: string[]
}) => {
  const { folderPath, runePath, prompt, userTs, runId, peers, collaborators, isLeader, imagePaths } = params

  const sendActivity = (text: string) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('rune:activity', { runId, text })
    }
  }

  const sendLogEntry = (entry: {
    agentName: string
    tool: string
    target: string
    ts: number
  }) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('activity:log', { folderPath, ...entry })
    }
  }

  try {
    const runeContent = JSON.parse(fs.readFileSync(runePath, 'utf-8'))
    const agentName = runeContent.name || path.basename(runePath, '.rune')
    const systemParts: string[] = []

    // ── Rune world context ──
    // Give every agent a shared understanding of the system they live in.
    systemParts.push(
      `You are an agent in RuneChat, a group-chat messenger for AI agents.

How your world works:
- You are a ".rune" file: a JSON file on disk that stores your name, role, memory, and conversation history. Deleting the file deletes you; copying it clones you.
- Your current project is the folder that contains your .rune file. Think of the folder as a workspace/project and each .rune file inside it as a coworker on that project.
- Other .rune files in the same folder are your peers. You can talk to them in the group chat by mentioning them with @name — they will see the message and may respond.
- The human user talks to the whole room and can @mention any agent directly. If no one is mentioned, a dispatcher decides who should respond based on roles and recent context.
- You persist across sessions: the user can close the app and come back days later, and your memory and history are still there.
- You are not Claude Code itself. You are a specific agent persona running on top of Claude Code. Stay in character based on your role below.`
    )

    if (runeContent.role) systemParts.push(`\nYour role: ${runeContent.role}`)
    systemParts.push(`Your name: ${runeContent.name || 'assistant'}`)
    if (runeContent.memory && runeContent.memory.length > 0) {
      systemParts.push('\nSaved memory:')
      runeContent.memory.forEach((m: string, i: number) => {
        systemParts.push(`${i + 1}. ${m}`)
      })
    }

    // Tell the agent about the project wiki.
    try {
      const wikiDir = getWikiDir(folderPath)
      if (fs.existsSync(wikiDir)) {
        const wikiFiles = fs.readdirSync(wikiDir).filter((f) => f.endsWith('.md'))
        if (wikiFiles.length > 0) {
          systemParts.push(
            `\nProject wiki (shared notes the whole team can read and write):
- Location: .runechat/wiki/
- Existing pages: ${wikiFiles.join(', ')}
- Use Read to check any page when you need project context (decisions, goals, conventions).
- Use Write to add or update pages when the team agrees on something important. Keep pages short and factual.`
          )
        } else {
          systemParts.push(
            `\nProject wiki: .runechat/wiki/ (empty — create pages with Write when the team needs shared notes).`
          )
        }
      } else {
        systemParts.push(
          `\nProject wiki: .runechat/wiki/ (not created yet — you may create it with Write when useful).`
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
    if (runeContent.history && runeContent.history.length > 0) {
      const recent = runeContent.history.slice(-10)
      systemParts.push('\nRecent conversation:')
      for (const msg of recent) {
        const who = msg.role === 'user' ? 'User' : 'Assistant'
        systemParts.push(`${who}: ${msg.text}`)
      }
    }

    // Decide whether the agent should be able to use tools.
    // Rule: if the .rune file has a `permissions` block with at least one
    // tool enabled (fileWrite, bash, or network explicitly true), we run in
    // "active" mode with --dangerously-skip-permissions + fine-grained tool
    // gates. Otherwise the agent is read-only (chat-only).
    const perms: RunePermissions | undefined = runeContent.permissions
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
          : `\n\nYou do NOT have permission to write files, run shell commands, or access the network. Answer with text only. If the user asks you to do something that requires these tools, explain that they need to grant the corresponding permission in your agent profile.`
      claudeArgs.push(
        '--system-prompt',
        systemParts.join('\n') + capLine + `\n\nWorking folder: ${folderPath}`
      )
    }
    // Attachments: prepend file references to the prompt so Claude Code reads them.
    // Claude Code auto-resolves `@relative/path` mentions by reading the file with
    // its Read tool (images included, for vision models).
    let finalPrompt = prompt
    if (imagePaths && imagePaths.length > 0) {
      const refs: string[] = []
      for (const imgRelPath of imagePaths) {
        const absImgPath = path.join(folderPath, imgRelPath)
        if (fs.existsSync(absImgPath)) {
          refs.push(`@${imgRelPath}`)
        }
      }
      if (refs.length > 0) {
        finalPrompt = `Attached files: ${refs.join(' ')}\n\n${prompt}`
      }
    }

    claudeArgs.push(finalPrompt)

    sendActivity('Thinking…')

    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn('claude', claudeArgs, {
        cwd: folderPath,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
      })

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

    // Update rune history with roomTs for cross-agent merging
    runeContent.history = runeContent.history || []
    runeContent.history.push({ role: 'user', text: prompt, ts: userTs, roomTs: userTs })
    runeContent.history.push({ role: 'assistant', text: output, ts: Date.now(), roomTs: Date.now() })
    fs.writeFileSync(runePath, JSON.stringify(runeContent, null, 2))

    return { ok: true, output }
  } catch (e: any) {
    return { ok: false, error: e.message || String(e) }
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

    const uploadsDir = path.join(folderPath, '.runechat', 'uploads')
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
        path: `.runechat/uploads/${safeFileName}`,
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
