import path from 'path'

// ── Security Utilities ────────────────────────────────────────────────────────

/** Sensitive paths that must NEVER be read, served, or written by any handler. */
export const SENSITIVE_PATH_PATTERNS = [
  '.ssh', '.gnupg', '.gpg',
  '.aws', '.azure', '.gcloud', '.config/gcloud',
  '.env', '.env.local', '.env.production', '.env.development',
  'credentials', 'credentials.json',
  '.npmrc', '.pypirc',
  '.docker/config.json',
  '.kube/config',
  '.gitconfig',
  'id_rsa', 'id_ed25519', 'id_ecdsa',
  '.pem', '.key', '.p12', '.pfx',
]

/** Returns true if `filePath` touches a sensitive location. */
export function isSensitivePath(filePath: string): boolean {
  const normalized = path.resolve(filePath).toLowerCase()
  return SENSITIVE_PATH_PATTERNS.some((p) => {
    const lp = p.toLowerCase()
    return normalized.includes(`/${lp}`) || normalized.includes(`\\${lp}`) || normalized.endsWith(lp)
  })
}

/**
 * Validate that `targetPath` is a `.octo` file residing within `allowedDir`.
 * Prevents path-traversal attacks on agent CRUD operations.
 */
export function validateOctoPath(targetPath: string, allowedDir?: string): { ok: true; resolved: string } | { ok: false; error: string } {
  const resolved = path.resolve(targetPath)

  // Must be a .octo file
  if (!resolved.endsWith('.octo')) {
    return { ok: false, error: 'Target must be a .octo file' }
  }

  // If allowedDir is provided, enforce containment
  if (allowedDir) {
    const resolvedDir = path.resolve(allowedDir)
    if (!resolved.startsWith(resolvedDir + path.sep) && resolved !== resolvedDir) {
      return { ok: false, error: 'Path escapes the allowed directory' }
    }
  }

  // Block sensitive locations
  if (isSensitivePath(resolved)) {
    return { ok: false, error: 'Access to sensitive path is denied' }
  }

  return { ok: true, resolved }
}

/**
 * Validate that a resolved path stays within its parent directory.
 * Used for file:readBase64, local-file://, etc.
 */
export function validatePathContainment(basePath: string, targetPath: string): { ok: true; resolved: string } | { ok: false; error: string } {
  const resolvedBase = path.resolve(basePath)
  const resolved = path.resolve(basePath, targetPath)

  if (!resolved.startsWith(resolvedBase + path.sep) && resolved !== resolvedBase) {
    return { ok: false, error: 'Path escapes the base directory' }
  }

  if (isSensitivePath(resolved)) {
    return { ok: false, error: 'Access to sensitive path is denied' }
  }

  return { ok: true, resolved }
}

/**
 * Build a sanitized copy of process.env for child processes.
 * Removes known-sensitive environment variables.
 */
export const SENSITIVE_ENV_KEYS = new Set([
  // API keys & tokens
  'ANTHROPIC_API_KEY', 'CLAUDE_API_KEY', 'OPENAI_API_KEY',
  'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN',
  'AZURE_CLIENT_SECRET', 'AZURE_TENANT_ID',
  'GOOGLE_APPLICATION_CREDENTIALS', 'GCP_SERVICE_ACCOUNT_KEY',
  'GITHUB_TOKEN', 'GH_TOKEN', 'GITLAB_TOKEN', 'BITBUCKET_TOKEN',
  'NPM_TOKEN', 'NPM_AUTH_TOKEN',
  'DOCKER_PASSWORD', 'DOCKER_AUTH_CONFIG',
  'DATABASE_URL', 'DB_PASSWORD', 'REDIS_URL',
  'STRIPE_SECRET_KEY', 'STRIPE_API_KEY',
  'SENDGRID_API_KEY', 'TWILIO_AUTH_TOKEN',
  'SLACK_TOKEN', 'SLACK_BOT_TOKEN',
  'JWT_SECRET', 'SESSION_SECRET', 'SECRET_KEY',
  'PRIVATE_KEY', 'ENCRYPTION_KEY',
])

/**
 * Classify a file path relative to a project folder.
 * - 'internal': path is within the project folder → auto-allow
 * - 'blocked': path matches sensitive patterns → always deny
 * - 'external': path is outside the project → needs user approval
 */
export type PathAccessClass = 'internal' | 'external' | 'blocked'

export function classifyPathAccess(resolvedPath: string, projectFolder: string): PathAccessClass {
  const normalizedPath = path.resolve(resolvedPath)
  const normalizedFolder = path.resolve(projectFolder)

  // Check blocked first — always deny
  if (isSensitivePath(normalizedPath)) {
    return 'blocked'
  }

  // Inside the project folder → auto-allow
  if (normalizedPath.startsWith(normalizedFolder + path.sep) || normalizedPath === normalizedFolder) {
    return 'internal'
  }

  return 'external'
}

// ── #5: Error message sanitization ──────────────────────────────────────────
// In production, never leak internal paths, stack traces, or system details.

/**
 * Sanitize an error for IPC responses.
 * - In dev mode: returns the full message for debugging.
 * - In production: returns a generic message, unless it's a known safe string.
 */
export function sanitizeError(error: unknown, isDev: boolean): string {
  const raw = error instanceof Error ? error.message : String(error)

  // In dev, always return the full message for debugging
  if (isDev) return raw

  // Known safe error messages that are fine to show users
  const SAFE_ERRORS = [
    'Name is required',
    'Invalid name',
    'Not found',
    'File not found',
    'Target must be a .octo file',
    'Path escapes the allowed directory',
    'Access to sensitive path is denied',
    'Access denied by user',
    'Invalid agent name',
    'An agent with that name already exists',
    'Agent not found',
    'Unsupported file type',
    'File exceeds 10MB limit',
  ]

  // Check if the error starts with or matches a safe pattern
  if (SAFE_ERRORS.some((safe) => raw.startsWith(safe))) return raw
  // AGENT_LIMIT messages are safe (they carry a number, not internal info)
  if (raw.startsWith('AGENT_LIMIT:')) return raw

  return 'An unexpected error occurred'
}

// ── #6: File mutex for .octo race condition prevention ──────────────────────
// Prevents concurrent read-modify-write on the same .octo file.

const fileLocks = new Map<string, Promise<void>>()

/**
 * Acquire a per-file mutex. Returns a release function.
 * Prevents concurrent read-modify-write cycles on the same .octo file.
 *
 * Usage:
 *   const release = await acquireFileLock(filePath)
 *   try { ... } finally { release() }
 */
export async function acquireFileLock(filePath: string): Promise<() => void> {
  const key = filePath.toLowerCase() // normalize for case-insensitive FS (macOS)

  // Wait for any existing lock on this file
  while (fileLocks.has(key)) {
    await fileLocks.get(key)
  }

  let releaseFn!: () => void
  const lockPromise = new Promise<void>((resolve) => {
    releaseFn = () => {
      fileLocks.delete(key)
      resolve()
    }
  })

  fileLocks.set(key, lockPromise)
  return releaseFn
}

// ── MCP Config Validation ─────────────────────────────────────────────────

/** Allowed commands for MCP server spawning. Rejects suspicious binaries. */
const MCP_ALLOWED_COMMANDS = new Set([
  'npx', 'node', 'python', 'python3', 'uvx', 'uv', 'deno', 'bun',
  'docker', 'podman',
])

/**
 * Validate an MCP servers config object.
 * - Each server must have a `command` string from the allow-list (or an absolute path).
 * - `args` must be a string array (if present).
 * - `env` must be a flat string→string object (if present).
 * - Server names must be safe (no path separators or shell metacharacters).
 */
export function validateMcpConfig(
  mcpServers: unknown,
): { ok: true; sanitized: Record<string, { command: string; args?: string[]; env?: Record<string, string> }> } | { ok: false; error: string } {
  if (!mcpServers || typeof mcpServers !== 'object' || Array.isArray(mcpServers)) {
    return { ok: false, error: 'MCP config must be a JSON object' }
  }

  const sanitized: Record<string, { command: string; args?: string[]; env?: Record<string, string> }> = {}

  for (const [name, config] of Object.entries(mcpServers as Record<string, any>)) {
    // Validate server name — no shell metacharacters or path separators
    if (!name || /[\/\\;|&`${}()<>!]/.test(name)) {
      return { ok: false, error: `Invalid MCP server name: "${name}"` }
    }
    if (name.length > 64) {
      return { ok: false, error: `MCP server name too long: "${name}"` }
    }

    if (!config || typeof config !== 'object') {
      return { ok: false, error: `MCP server "${name}": config must be an object` }
    }

    // Validate command
    const cmd = config.command
    if (typeof cmd !== 'string' || !cmd.trim()) {
      return { ok: false, error: `MCP server "${name}": command is required` }
    }
    const cmdBase = path.basename(cmd)
    const isAbsolutePath = path.isAbsolute(cmd)
    if (!isAbsolutePath && !MCP_ALLOWED_COMMANDS.has(cmdBase)) {
      return { ok: false, error: `MCP server "${name}": command "${cmd}" is not in the allow-list. Allowed: ${[...MCP_ALLOWED_COMMANDS].join(', ')} (or use an absolute path)` }
    }

    // Validate args
    if (config.args !== undefined) {
      if (!Array.isArray(config.args) || !config.args.every((a: any) => typeof a === 'string')) {
        return { ok: false, error: `MCP server "${name}": args must be a string array` }
      }
    }

    // Validate env — must be flat string→string, no sensitive key leaking
    let env: Record<string, string> | undefined
    if (config.env !== undefined) {
      if (typeof config.env !== 'object' || Array.isArray(config.env)) {
        return { ok: false, error: `MCP server "${name}": env must be a { key: value } object` }
      }
      env = {}
      for (const [k, v] of Object.entries(config.env as Record<string, any>)) {
        if (typeof v !== 'string') {
          return { ok: false, error: `MCP server "${name}": env value for "${k}" must be a string` }
        }
        env[k] = v
      }
    }

    sanitized[name] = {
      command: cmd.trim(),
      ...(config.args ? { args: config.args } : {}),
      ...(env ? { env } : {}),
    }
  }

  return { ok: true, sanitized }
}

export function sanitizedEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    const upperKey = key.toUpperCase()
    if (SENSITIVE_ENV_KEYS.has(upperKey) ||
        upperKey.includes('SECRET') ||
        upperKey.includes('PASSWORD') ||
        (upperKey.includes('_KEY') && upperKey !== 'SSH_AUTH_SOCK') ||
        upperKey.includes('_TOKEN') && upperKey !== 'TERM_SESSION_ID') {
      delete env[key]
    }
  }
  return env
}
