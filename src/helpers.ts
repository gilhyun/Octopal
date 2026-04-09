import path from 'path'
import fs from 'fs'
import { isSensitivePath } from './security'

// ── Wiki name sanitization ──────────────────────────────────────────────────

/**
 * Sanitize a wiki page name.
 * Rejects names with `/`, `\`, or leading `.` to prevent path traversal.
 * Auto-appends `.md` if not present.
 */
export function sanitizeWikiName(name: string): string | null {
  const trimmed = name.trim()
  if (!trimmed) return null
  // Only allow safe characters — block traversal.
  if (trimmed.includes('/') || trimmed.includes('\\') || trimmed.startsWith('.')) return null
  return trimmed.endsWith('.md') ? trimmed : `${trimmed}.md`
}

// ── Agent name validation ───────────────────────────────────────────────────

/**
 * Validate an agent name for creation/rename.
 * Rejects empty, path separators, and leading dots.
 */
export function validateAgentName(name: string): { ok: true; safeName: string } | { ok: false; error: string } {
  const safeName = name.trim()
  if (!safeName) return { ok: false, error: 'Name is required' }
  if (safeName.includes('/') || safeName.includes('\\') || safeName.startsWith('.')) {
    return { ok: false, error: 'Invalid agent name' }
  }
  return { ok: true, safeName }
}

// ── Permission args builder ─────────────────────────────────────────────────

export interface OctoPermissions {
  fileWrite?: boolean
  bash?: boolean
  network?: boolean
  allowPaths?: string[]
  denyPaths?: string[]
}

/**
 * Build Claude CLI permission arguments from an OctoPermissions object.
 */
export function buildPermissionArgs(permissions?: OctoPermissions): string[] {
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

// ── State management helpers ────────────────────────────────────────────────

export interface Workspace {
  id: string
  name: string
  folders: string[]
}

export interface State {
  workspaces: Workspace[]
  activeWorkspaceId: string | null
}

/**
 * Parse raw JSON into a State object, handling legacy format migration.
 */
export function parseState(raw: any): State {
  if (!raw) return { workspaces: [], activeWorkspaceId: null }

  // Migrate from legacy { folders: [] } shape
  if (Array.isArray(raw.folders) && !raw.workspaces) {
    const id = 'default-' + Date.now()
    return {
      workspaces: [{ id, name: 'Personal', folders: raw.folders }],
      activeWorkspaceId: id,
    }
  }

  if (Array.isArray(raw.workspaces)) {
    return {
      workspaces: raw.workspaces,
      activeWorkspaceId: raw.activeWorkspaceId || (raw.workspaces[0]?.id ?? null),
    }
  }

  return { workspaces: [], activeWorkspaceId: null }
}

/**
 * Get a workspace by ID from state.
 */
export function getWorkspace(state: State, id: string | null): Workspace | null {
  if (!id) return null
  return state.workspaces.find((w) => w.id === id) || null
}

// ── Room log helpers ────────────────────────────────────────────────────────

export interface RoomUserMessage {
  id: string
  ts: number
  text: string
  attachments?: any[]
}

export interface MergedMessage {
  id: string
  agentName: string
  text: string
  ts: number
  attachments?: any[]
}

/**
 * Check if a room log already contains a message with the same ts and text.
 */
export function isDuplicateMessage(
  log: RoomUserMessage[],
  message: RoomUserMessage,
): boolean {
  return log.some((m) => m.ts === message.ts && m.text === message.text)
}

/**
 * Merge room log (user messages) and agent history (.octo files) into
 * a single chronologically sorted array.
 */
export function mergeMessages(
  roomLog: RoomUserMessage[],
  agentHistories: Array<{
    agentName: string
    history: Array<{ role: string; text: string; roomTs?: number }>
    fileName: string
  }>,
): MergedMessage[] {
  const allMessages: MergedMessage[] = []

  // User messages from room-log
  for (const m of roomLog) {
    allMessages.push({
      id: `room-user-${m.ts}`,
      agentName: 'user',
      text: m.text,
      ts: m.ts,
      attachments: m.attachments,
    })
  }

  // Agent messages from .octo history
  for (const agent of agentHistories) {
    for (let i = 0; i < agent.history.length; i++) {
      const msg = agent.history[i]
      // Skip user messages — room-log is the source of truth
      if (msg.role === 'user') continue
      if (msg.roomTs) {
        allMessages.push({
          id: `${agent.fileName}-${i}-${msg.roomTs}`,
          agentName: agent.agentName,
          text: msg.text,
          ts: msg.roomTs,
        })
      }
    }
  }

  // Sort chronologically
  allMessages.sort((a, b) => a.ts - b.ts)
  return allMessages
}

/**
 * Paginate a message array.
 * Returns the last `limit` messages before `beforeTs`, or the last `limit` if no cutoff.
 */
export function paginateMessages(
  allMessages: MergedMessage[],
  limit: number,
  beforeTs?: number,
): { messages: MergedMessage[]; hasMore: boolean } {
  if (beforeTs != null) {
    const cutoff = allMessages.filter((m) => m.ts < beforeTs)
    const slice = cutoff.slice(-limit)
    return { messages: slice, hasMore: cutoff.length > limit }
  } else {
    const slice = allMessages.slice(-limit)
    return { messages: slice, hasMore: allMessages.length > limit }
  }
}

// ── File upload validation ──────────────────────────────────────────────────

export const ALLOWED_IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.webp']
export const ALLOWED_TEXT_EXTS = ['.txt', '.log', '.json', '.csv']
export const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10MB

/**
 * Validate a file for upload. Returns the file type or an error.
 */
export function validateFileUpload(
  fileName: string,
  fileSize: number,
): { ok: true; type: 'image' | 'text' } | { ok: false; error: string } {
  if (fileSize > MAX_FILE_SIZE) {
    return { ok: false, error: 'File exceeds 10MB limit' }
  }
  const ext = path.extname(fileName).toLowerCase()
  if (ALLOWED_IMAGE_EXTS.includes(ext)) return { ok: true, type: 'image' }
  if (ALLOWED_TEXT_EXTS.includes(ext)) return { ok: true, type: 'text' }
  return { ok: false, error: `Unsupported file type: ${ext}` }
}

// ── Settings helpers ────────────────────────────────────────────────────────

export interface AppSettings {
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
}

export const DEFAULT_SETTINGS: AppSettings = {
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

/**
 * Merge raw settings JSON with defaults (handles partial/corrupted settings).
 */
export function mergeSettings(raw: any): AppSettings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_SETTINGS }
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

// ── Octo file parsing ───────────────────────────────────────────────────────

export interface ParsedOcto {
  path: string
  name: string
  role: string
  icon: string
  hidden: boolean
  permissions: OctoPermissions | null
}

/**
 * Parse a .octo JSON file content into a structured agent object.
 */
export function parseOctoFile(
  fullPath: string,
  content: any,
  fileName: string,
): ParsedOcto {
  return {
    path: fullPath,
    name: content.name || fileName.replace('.octo', ''),
    role: content.role || '',
    icon: content.icon || 'bot',
    hidden: content.hidden || false,
    permissions: content.permissions || null,
  }
}

/**
 * Count visible (non-hidden) agents from a list.
 */
export function countVisibleAgents(agents: ParsedOcto[]): number {
  return agents.filter((a) => !a.hidden).length
}

export const MAX_VISIBLE_AGENTS = 10
