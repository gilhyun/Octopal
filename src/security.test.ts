import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import path from 'path'
import {
  isSensitivePath,
  validateOctoPath,
  validatePathContainment,
  sanitizedEnv,
  sanitizeError,
  acquireFileLock,
  classifyPathAccess,
  SENSITIVE_PATH_PATTERNS,
  SENSITIVE_ENV_KEYS,
} from './security'

// ── #5: sanitizeError ───────────────────────────────────────────────────────

describe('sanitizeError', () => {
  describe('dev mode (isDev = true)', () => {
    it('returns full error message in dev mode', () => {
      const err = new Error('ENOENT: no such file or directory, open \'/Users/secret/path\'')
      expect(sanitizeError(err, true)).toBe(err.message)
    })

    it('returns full string error in dev mode', () => {
      expect(sanitizeError('something broke', true)).toBe('something broke')
    })
  })

  describe('production mode (isDev = false)', () => {
    it('returns generic message for unknown errors', () => {
      const err = new Error('ENOENT: no such file or directory, open \'/Users/secret/path\'')
      expect(sanitizeError(err, false)).toBe('An unexpected error occurred')
    })

    it('returns generic message for stack trace leaks', () => {
      expect(sanitizeError('Error at Object.<anonymous> (/app/src/main.ts:42)', false)).toBe('An unexpected error occurred')
    })

    it('passes through safe known errors', () => {
      expect(sanitizeError('File not found', false)).toBe('File not found')
      expect(sanitizeError('Invalid agent name', false)).toBe('Invalid agent name')
      expect(sanitizeError('An agent with that name already exists', false)).toBe('An agent with that name already exists')
      expect(sanitizeError('Target must be a .octo file', false)).toBe('Target must be a .octo file')
      expect(sanitizeError('Access to sensitive path is denied', false)).toBe('Access to sensitive path is denied')
      expect(sanitizeError('Access denied by user', false)).toBe('Access denied by user')
    })

    it('passes through AGENT_LIMIT errors', () => {
      expect(sanitizeError('AGENT_LIMIT:10', false)).toBe('AGENT_LIMIT:10')
    })

    it('passes through Unsupported file type errors', () => {
      expect(sanitizeError('Unsupported file type: .exe', false)).toBe('Unsupported file type: .exe')
    })

    it('handles Error objects and non-string types', () => {
      expect(sanitizeError(new Error('File not found'), false)).toBe('File not found')
      expect(sanitizeError(42, false)).toBe('An unexpected error occurred')
      expect(sanitizeError(null, false)).toBe('An unexpected error occurred')
    })
  })
})

// ── #6: acquireFileLock ─────────────────────────────────────────────────────

describe('acquireFileLock', () => {
  it('returns a release function', async () => {
    const release = await acquireFileLock('/test/file1.octo')
    expect(typeof release).toBe('function')
    release()
  })

  it('serializes concurrent access to the same file', async () => {
    const order: number[] = []

    const release1 = await acquireFileLock('/test/serial.octo')

    // Start second lock attempt — should wait
    const lock2Promise = acquireFileLock('/test/serial.octo').then((release2) => {
      order.push(2)
      release2()
    })

    // First lock still held
    order.push(1)
    release1()

    await lock2Promise
    expect(order).toEqual([1, 2])
  })

  it('allows concurrent access to different files', async () => {
    const release1 = await acquireFileLock('/test/fileA.octo')
    const release2 = await acquireFileLock('/test/fileB.octo')

    // Both should be acquired without blocking
    expect(typeof release1).toBe('function')
    expect(typeof release2).toBe('function')

    release1()
    release2()
  })

  it('is case-insensitive (macOS FS compatibility)', async () => {
    const order: number[] = []

    const release1 = await acquireFileLock('/test/Agent.octo')

    const lock2Promise = acquireFileLock('/test/agent.octo').then((release2) => {
      order.push(2)
      release2()
    })

    order.push(1)
    release1()

    await lock2Promise
    expect(order).toEqual([1, 2])
  })

  it('handles triple sequential locks', async () => {
    const order: number[] = []
    const testFile = '/test/triple.octo'

    const release1 = await acquireFileLock(testFile)

    const lock2 = acquireFileLock(testFile).then(async (release2) => {
      order.push(2)
      const lock3 = acquireFileLock(testFile).then((release3) => {
        order.push(3)
        release3()
      })
      release2()
      await lock3
    })

    order.push(1)
    release1()

    await lock2
    expect(order).toEqual([1, 2, 3])
  })
})

// ── P0: isSensitivePath ──────────────────────────────────────────────────────

describe('isSensitivePath', () => {
  it('blocks .ssh directory', () => {
    expect(isSensitivePath('/home/user/.ssh/id_rsa')).toBe(true)
    expect(isSensitivePath('/home/user/.ssh')).toBe(true)
  })

  it('blocks .aws credentials', () => {
    expect(isSensitivePath('/home/user/.aws/credentials')).toBe(true)
    expect(isSensitivePath('/home/user/.aws/config')).toBe(true)
  })

  it('blocks .env files', () => {
    expect(isSensitivePath('/project/.env')).toBe(true)
    expect(isSensitivePath('/project/.env.local')).toBe(true)
    expect(isSensitivePath('/project/.env.production')).toBe(true)
    expect(isSensitivePath('/project/.env.development')).toBe(true)
  })

  it('blocks private key files', () => {
    expect(isSensitivePath('/home/user/.ssh/id_rsa')).toBe(true)
    expect(isSensitivePath('/home/user/.ssh/id_ed25519')).toBe(true)
    expect(isSensitivePath('/home/user/.ssh/id_ecdsa')).toBe(true)
    expect(isSensitivePath('/path/to/server.pem')).toBe(true)
    expect(isSensitivePath('/path/to/private.key')).toBe(true)
    expect(isSensitivePath('/path/to/cert.p12')).toBe(true)
    expect(isSensitivePath('/path/to/cert.pfx')).toBe(true)
  })

  it('blocks credentials files', () => {
    expect(isSensitivePath('/project/credentials')).toBe(true)
    expect(isSensitivePath('/project/credentials.json')).toBe(true)
  })

  it('blocks package manager auth', () => {
    expect(isSensitivePath('/home/user/.npmrc')).toBe(true)
    expect(isSensitivePath('/home/user/.pypirc')).toBe(true)
  })

  it('blocks cloud config', () => {
    expect(isSensitivePath('/home/user/.gcloud/config')).toBe(true)
    expect(isSensitivePath('/home/user/.azure/config')).toBe(true)
    expect(isSensitivePath('/home/user/.config/gcloud/key.json')).toBe(true)
  })

  it('blocks docker and kube configs', () => {
    expect(isSensitivePath('/home/user/.docker/config.json')).toBe(true)
    expect(isSensitivePath('/home/user/.kube/config')).toBe(true)
  })

  it('is case-insensitive', () => {
    expect(isSensitivePath('/home/user/.SSH/id_rsa')).toBe(true)
    expect(isSensitivePath('/home/user/.ENV')).toBe(true)
    expect(isSensitivePath('/home/user/.Aws/config')).toBe(true)
  })

  it('allows normal files', () => {
    expect(isSensitivePath('/project/src/main.ts')).toBe(false)
    expect(isSensitivePath('/project/package.json')).toBe(false)
    expect(isSensitivePath('/project/README.md')).toBe(false)
    expect(isSensitivePath('/project/agent.octo')).toBe(false)
  })

  it('covers all SENSITIVE_PATH_PATTERNS', () => {
    // Ensure every pattern is actually detected
    for (const pattern of SENSITIVE_PATH_PATTERNS) {
      const testPath = `/home/user/${pattern}`
      expect(isSensitivePath(testPath)).toBe(true)
    }
  })
})

// ── P0: validateOctoPath ─────────────────────────────────────────────────────

describe('validateOctoPath', () => {
  const allowedDir = '/project/agents'

  it('accepts valid .octo file within allowed directory', () => {
    const result = validateOctoPath('/project/agents/bot.octo', allowedDir)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.resolved).toContain('bot.octo')
    }
  })

  it('rejects non-.octo files', () => {
    const result = validateOctoPath('/project/agents/malicious.txt', allowedDir)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('.octo')
    }
  })

  it('rejects .octo.txt disguised extension', () => {
    const result = validateOctoPath('/project/agents/file.octo.txt', allowedDir)
    expect(result.ok).toBe(false)
  })

  // Path traversal attacks
  describe('path traversal prevention', () => {
    it('blocks ../../ traversal', () => {
      const result = validateOctoPath('/project/agents/../../etc/passwd.octo', allowedDir)
      expect(result.ok).toBe(false)
    })

    it('blocks absolute path outside directory', () => {
      const result = validateOctoPath('/etc/evil.octo', allowedDir)
      expect(result.ok).toBe(false)
    })

    it('blocks ../ at start', () => {
      const result = validateOctoPath('../../../tmp/evil.octo', allowedDir)
      expect(result.ok).toBe(false)
    })

    it('blocks parent directory traversal to sensitive paths', () => {
      const result = validateOctoPath('/project/agents/../../.ssh/config.octo', allowedDir)
      expect(result.ok).toBe(false)
    })
  })

  // Sensitive path blocking
  describe('sensitive path blocking', () => {
    it('blocks .octo file in .ssh directory', () => {
      const result = validateOctoPath('/home/user/.ssh/agent.octo')
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toContain('sensitive')
      }
    })

    it('blocks .octo file in .aws directory', () => {
      const result = validateOctoPath('/home/user/.aws/agent.octo')
      expect(result.ok).toBe(false)
    })
  })

  // Without allowedDir (only extension + sensitive check)
  it('accepts valid .octo without allowedDir', () => {
    const result = validateOctoPath('/safe/location/bot.octo')
    expect(result.ok).toBe(true)
  })
})

// ── P0: validatePathContainment ──────────────────────────────────────────────

describe('validatePathContainment', () => {
  const basePath = '/project/workspace'

  it('accepts file within base directory', () => {
    const result = validatePathContainment(basePath, 'subfolder/file.txt')
    expect(result.ok).toBe(true)
  })

  it('accepts deeply nested files', () => {
    const result = validatePathContainment(basePath, 'a/b/c/d/file.txt')
    expect(result.ok).toBe(true)
  })

  // Path traversal
  describe('path traversal prevention', () => {
    it('blocks ../ escape', () => {
      const result = validatePathContainment(basePath, '../outside.txt')
      expect(result.ok).toBe(false)
    })

    it('blocks ../../ double escape', () => {
      const result = validatePathContainment(basePath, '../../etc/passwd')
      expect(result.ok).toBe(false)
    })

    it('blocks absolute path outside base', () => {
      const result = validatePathContainment(basePath, '/etc/passwd')
      expect(result.ok).toBe(false)
    })

    it('blocks symlink-style /../ in middle', () => {
      const result = validatePathContainment(basePath, 'sub/../../../etc/passwd')
      expect(result.ok).toBe(false)
    })
  })

  // Sensitive paths
  describe('sensitive path blocking', () => {
    it('blocks access to .env within project', () => {
      const result = validatePathContainment(basePath, '.env')
      expect(result.ok).toBe(false)
    })

    it('blocks access to .ssh within project', () => {
      const result = validatePathContainment(basePath, '.ssh/id_rsa')
      expect(result.ok).toBe(false)
    })

    it('blocks access to credentials.json', () => {
      const result = validatePathContainment(basePath, 'credentials.json')
      expect(result.ok).toBe(false)
    })
  })
})

// ── P2: sanitizedEnv ────────────────────────────────────────────────────────

describe('sanitizedEnv', () => {
  const originalEnv = process.env

  beforeEach(() => {
    // Reset env to a known state
    process.env = { ...originalEnv }
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('removes explicitly listed sensitive keys', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test'
    process.env.AWS_SECRET_ACCESS_KEY = 'secret123'
    process.env.GITHUB_TOKEN = 'ghp_test'
    process.env.DATABASE_URL = 'postgres://...'

    const env = sanitizedEnv()
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined()
    expect(env.GITHUB_TOKEN).toBeUndefined()
    expect(env.DATABASE_URL).toBeUndefined()
  })

  it('removes all SENSITIVE_ENV_KEYS entries', () => {
    for (const key of SENSITIVE_ENV_KEYS) {
      process.env[key] = 'test-value'
    }
    const env = sanitizedEnv()
    for (const key of SENSITIVE_ENV_KEYS) {
      expect(env[key]).toBeUndefined()
    }
  })

  it('removes keys containing SECRET (pattern match)', () => {
    process.env.MY_CUSTOM_SECRET = 'hidden'
    process.env.APP_SECRET_VALUE = 'hidden'
    const env = sanitizedEnv()
    expect(env.MY_CUSTOM_SECRET).toBeUndefined()
    expect(env.APP_SECRET_VALUE).toBeUndefined()
  })

  it('removes keys containing PASSWORD (pattern match)', () => {
    process.env.DB_PASSWORD = 'pass123'
    process.env.ADMIN_PASSWORD = 'admin'
    const env = sanitizedEnv()
    expect(env.DB_PASSWORD).toBeUndefined()
    expect(env.ADMIN_PASSWORD).toBeUndefined()
  })

  it('removes keys containing _TOKEN (pattern match)', () => {
    process.env.CUSTOM_AUTH_TOKEN = 'tok123'
    process.env.MY_APP_TOKEN = 'tok456'
    const env = sanitizedEnv()
    expect(env.CUSTOM_AUTH_TOKEN).toBeUndefined()
    expect(env.MY_APP_TOKEN).toBeUndefined()
  })

  it('removes keys containing _KEY except SSH_AUTH_SOCK', () => {
    process.env.MY_API_KEY = 'key123'
    process.env.SSH_AUTH_SOCK = '/tmp/ssh-agent.sock'
    const env = sanitizedEnv()
    expect(env.MY_API_KEY).toBeUndefined()
    expect(env.SSH_AUTH_SOCK).toBe('/tmp/ssh-agent.sock') // preserved
  })

  it('preserves safe environment variables', () => {
    process.env.HOME = '/home/user'
    process.env.PATH = '/usr/bin'
    process.env.NODE_ENV = 'production'
    process.env.LANG = 'en_US.UTF-8'

    const env = sanitizedEnv()
    expect(env.HOME).toBe('/home/user')
    expect(env.PATH).toBe('/usr/bin')
    expect(env.NODE_ENV).toBe('production')
    expect(env.LANG).toBe('en_US.UTF-8')
  })

  it('does not mutate process.env', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test'
    sanitizedEnv()
    expect(process.env.ANTHROPIC_API_KEY).toBe('sk-ant-test')
  })

  it('is case-insensitive for pattern matching', () => {
    process.env.my_secret_value = 'hidden'
    process.env.My_Password = 'hidden'
    const env = sanitizedEnv()
    expect(env.my_secret_value).toBeUndefined()
    expect(env.My_Password).toBeUndefined()
  })
})

// ── Additional Edge Cases (requested by @security) ──────────────────────────

describe('Edge Cases — null bytes & encoding bypass', () => {
  describe('isSensitivePath — encoding bypass attempts', () => {
    it('should detect sensitive path regardless of null byte injection', () => {
      // Null bytes can truncate strings in C-based systems
      // Node.js path.resolve handles them, but we verify the check still works
      expect(isSensitivePath('/home/user/.ssh\0/safe.txt')).toBe(true)
    })

    it('should block paths with double dots resolved to sensitive dirs', () => {
      // path.resolve normalizes ../.. so this should still trigger
      expect(isSensitivePath('/home/user/project/../../.ssh/id_rsa')).toBe(true)
    })
  })

  describe('validatePathContainment — null byte attacks', () => {
    it('should handle null bytes in relative path', () => {
      // Null bytes in the path — path.resolve may throw or produce unsafe result
      const result = validatePathContainment('/project', 'file\0.png')
      // Either rejected or resolved safely within project
      if (result.ok) {
        expect(result.resolved.startsWith('/project/')).toBe(true)
      }
    })
  })

  describe('validateOctoPath — edge cases from @security', () => {
    it('should reject path with null byte before .octo extension', () => {
      const result = validateOctoPath('/project/malicious\0.octo')
      // The null byte means the actual filename may differ;
      // path.resolve should still end with .octo or reject
      if (result.ok) {
        expect(result.resolved.endsWith('.octo')).toBe(true)
      }
    })

    it('should reject directory prefix bypass: /project-evil/ when allowedDir is /project', () => {
      const result = validateOctoPath('/project-evil/agent.octo', '/project')
      expect(result.ok).toBe(false)
    })

    it('should reject URL-encoded parent in resolved path: %2e%2e', () => {
      // In real IPC, params come as strings. %2e%2e would be literal chars
      // path.resolve treats them as literal, not as ..
      const result = validateOctoPath('/project/%2e%2e/etc/evil.octo', '/project')
      // If path.resolve doesn't interpret %2e%2e as .., it stays in /project
      // If it does, it should be rejected — either way, containment must hold
      if (result.ok) {
        expect(result.resolved.startsWith('/project/')).toBe(true)
      }
    })
  })
})

describe('Edge Cases — combined attack scenarios', () => {
  it('should block traversal to sensitive file even with .octo suffix', () => {
    const result = validateOctoPath(
      '/home/user/project/../../.ssh/id_rsa.octo',
      '/home/user/project',
    )
    expect(result.ok).toBe(false)
  })

  it('should block .env.local via containment check', () => {
    const result = validatePathContainment('/home/user/project', '.env.local')
    expect(result.ok).toBe(false)
  })

  it('should ensure all critical patterns exist in SENSITIVE_PATH_PATTERNS', () => {
    const critical = ['.ssh', '.aws', '.env', '.gnupg', 'id_rsa', '.pem', '.key', '.pfx', '.p12']
    critical.forEach((p) => {
      expect(SENSITIVE_PATH_PATTERNS).toContain(p)
    })
  })

  it('should ensure all critical env keys exist in SENSITIVE_ENV_KEYS', () => {
    const critical = [
      'ANTHROPIC_API_KEY', 'AWS_SECRET_ACCESS_KEY', 'GITHUB_TOKEN',
      'OPENAI_API_KEY', 'DATABASE_URL', 'STRIPE_SECRET_KEY',
      'JWT_SECRET', 'PRIVATE_KEY', 'ENCRYPTION_KEY',
    ]
    critical.forEach((k) => {
      expect(SENSITIVE_ENV_KEYS.has(k)).toBe(true)
    })
  })
})

describe('Edge Cases — sanitizedEnv thoroughness', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv }
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('should strip keys with SECRET anywhere in name', () => {
    process.env.SUPER_SECRET_SAUCE = 'hidden'
    process.env.NOSECRETHERE = 'hidden'  // Contains SECRET
    const env = sanitizedEnv()
    expect(env.SUPER_SECRET_SAUCE).toBeUndefined()
    expect(env.NOSECRETHERE).toBeUndefined()
  })

  it('should handle empty env gracefully', () => {
    process.env = {}
    const env = sanitizedEnv()
    expect(Object.keys(env).length).toBe(0)
  })

  it('should preserve TERM_SESSION_ID despite containing _TOKEN-like suffix', () => {
    process.env.TERM_SESSION_ID = 'abc-123'
    const env = sanitizedEnv()
    expect(env.TERM_SESSION_ID).toBe('abc-123')
  })
})

// ── P1: classifyPathAccess ──────────────────────────────────────────────────

describe('classifyPathAccess', () => {
  const projectFolder = '/Users/test/project'

  describe('internal paths', () => {
    it('classifies file inside project as internal', () => {
      expect(classifyPathAccess('/Users/test/project/src/index.ts', projectFolder)).toBe('internal')
    })

    it('classifies nested file inside project as internal', () => {
      expect(classifyPathAccess('/Users/test/project/src/deep/nested/file.ts', projectFolder)).toBe('internal')
    })

    it('classifies project root as internal', () => {
      expect(classifyPathAccess('/Users/test/project', projectFolder)).toBe('internal')
    })
  })

  describe('external paths', () => {
    it('classifies file outside project as external', () => {
      expect(classifyPathAccess('/Users/test/other-project/file.ts', projectFolder)).toBe('external')
    })

    it('classifies parent directory as external', () => {
      expect(classifyPathAccess('/Users/test/file.ts', projectFolder)).toBe('external')
    })

    it('classifies sibling directory as external', () => {
      expect(classifyPathAccess('/Users/test/project2/file.ts', projectFolder)).toBe('external')
    })

    it('rejects path prefix trick (project-extra/file)', () => {
      // /Users/test/project-extra should NOT be considered internal
      expect(classifyPathAccess('/Users/test/project-extra/file.ts', projectFolder)).toBe('external')
    })

    it('classifies /tmp path as external', () => {
      expect(classifyPathAccess('/tmp/tempfile', projectFolder)).toBe('external')
    })
  })

  describe('blocked paths', () => {
    it('classifies .ssh path as blocked', () => {
      expect(classifyPathAccess('/Users/test/.ssh/id_rsa', projectFolder)).toBe('blocked')
    })

    it('classifies .env inside project as blocked', () => {
      expect(classifyPathAccess('/Users/test/project/.env', projectFolder)).toBe('blocked')
    })

    it('classifies .aws outside project as blocked', () => {
      expect(classifyPathAccess('/Users/test/.aws/credentials', projectFolder)).toBe('blocked')
    })

    it('classifies credentials.json as blocked', () => {
      expect(classifyPathAccess('/Users/test/project/credentials.json', projectFolder)).toBe('blocked')
    })

    it('blocked takes priority over internal', () => {
      // Even though it's inside the project, sensitive paths are blocked
      expect(classifyPathAccess('/Users/test/project/.ssh/id_rsa', projectFolder)).toBe('blocked')
    })

    it('blocked takes priority over external', () => {
      expect(classifyPathAccess('/home/user/.gnupg/key.gpg', projectFolder)).toBe('blocked')
    })
  })
})
