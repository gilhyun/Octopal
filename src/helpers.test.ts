import { describe, it, expect } from 'vitest'
import {
  sanitizeWikiName,
  validateAgentName,
  buildPermissionArgs,
  parseState,
  getWorkspace,
  isDuplicateMessage,
  mergeMessages,
  paginateMessages,
  validateFileUpload,
  mergeSettings,
  parseOctoFile,
  countVisibleAgents,
  DEFAULT_SETTINGS,
  MAX_VISIBLE_AGENTS,
  ALLOWED_IMAGE_EXTS,
  ALLOWED_TEXT_EXTS,
  MAX_FILE_SIZE,
  type RoomUserMessage,
  type State,
  type OctoPermissions,
  type ParsedOcto,
} from './helpers'

// ═══════════════════════════════════════════════════════════════════════════
// 1. WIKI NAME SANITIZATION
// ═══════════════════════════════════════════════════════════════════════════

describe('sanitizeWikiName', () => {
  describe('valid names', () => {
    it('accepts plain name and appends .md', () => {
      expect(sanitizeWikiName('meeting-notes')).toBe('meeting-notes.md')
    })

    it('accepts name already ending with .md', () => {
      expect(sanitizeWikiName('readme.md')).toBe('readme.md')
    })

    it('trims whitespace and appends .md', () => {
      expect(sanitizeWikiName('  my page  ')).toBe('my page.md')
    })

    it('accepts Korean characters', () => {
      expect(sanitizeWikiName('회의록')).toBe('회의록.md')
    })

    it('accepts emoji in names', () => {
      expect(sanitizeWikiName('🚀 launch plan')).toBe('🚀 launch plan.md')
    })

    it('accepts hyphens, underscores, spaces', () => {
      expect(sanitizeWikiName('my_page-2024 notes')).toBe('my_page-2024 notes.md')
    })
  })

  describe('invalid names — path traversal prevention', () => {
    it('rejects empty string', () => {
      expect(sanitizeWikiName('')).toBeNull()
    })

    it('rejects whitespace only', () => {
      expect(sanitizeWikiName('   ')).toBeNull()
    })

    it('rejects forward slash (path traversal)', () => {
      expect(sanitizeWikiName('../etc/passwd')).toBeNull()
    })

    it('rejects backslash (Windows traversal)', () => {
      expect(sanitizeWikiName('..\\secret')).toBeNull()
    })

    it('rejects leading dot (hidden file)', () => {
      expect(sanitizeWikiName('.env')).toBeNull()
    })

    it('rejects .ssh attempt', () => {
      expect(sanitizeWikiName('.ssh')).toBeNull()
    })

    it('rejects nested path with slash', () => {
      expect(sanitizeWikiName('sub/page')).toBeNull()
    })
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 2. AGENT NAME VALIDATION
// ═══════════════════════════════════════════════════════════════════════════

describe('validateAgentName', () => {
  describe('valid names', () => {
    it('accepts simple name', () => {
      const result = validateAgentName('developer')
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.safeName).toBe('developer')
    })

    it('trims whitespace', () => {
      const result = validateAgentName('  assistant  ')
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.safeName).toBe('assistant')
    })

    it('accepts Korean names', () => {
      const result = validateAgentName('개발자')
      expect(result.ok).toBe(true)
    })

    it('accepts names with spaces', () => {
      const result = validateAgentName('my agent')
      expect(result.ok).toBe(true)
    })

    it('accepts names with hyphens and underscores', () => {
      const result = validateAgentName('agent-v2_final')
      expect(result.ok).toBe(true)
    })
  })

  describe('invalid names', () => {
    it('rejects empty string', () => {
      expect(validateAgentName('').ok).toBe(false)
    })

    it('rejects whitespace only', () => {
      expect(validateAgentName('   ').ok).toBe(false)
    })

    it('rejects forward slash', () => {
      const result = validateAgentName('../../evil')
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('Invalid agent name')
    })

    it('rejects backslash', () => {
      expect(validateAgentName('foo\\bar').ok).toBe(false)
    })

    it('rejects leading dot', () => {
      expect(validateAgentName('.hidden').ok).toBe(false)
    })
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 3. PERMISSION ARGS BUILDER
// ═══════════════════════════════════════════════════════════════════════════

describe('buildPermissionArgs', () => {
  it('returns empty array for undefined permissions', () => {
    expect(buildPermissionArgs(undefined)).toEqual([])
  })

  it('returns empty array for empty permissions', () => {
    expect(buildPermissionArgs({})).toEqual([])
  })

  describe('disallowed tools', () => {
    it('disallows Write and Edit when fileWrite is false', () => {
      const args = buildPermissionArgs({ fileWrite: false })
      expect(args).toContain('--disallowedTools')
      const idx = args.indexOf('--disallowedTools')
      expect(args[idx + 1]).toContain('Write')
      expect(args[idx + 1]).toContain('Edit')
    })

    it('disallows Bash when bash is false', () => {
      const args = buildPermissionArgs({ bash: false })
      const idx = args.indexOf('--disallowedTools')
      expect(args[idx + 1]).toContain('Bash')
    })

    it('disallows WebFetch and WebSearch when network is false', () => {
      const args = buildPermissionArgs({ network: false })
      const idx = args.indexOf('--disallowedTools')
      expect(args[idx + 1]).toContain('WebFetch')
      expect(args[idx + 1]).toContain('WebSearch')
    })

    it('combines multiple disabled permissions', () => {
      const args = buildPermissionArgs({ fileWrite: false, bash: false, network: false })
      const idx = args.indexOf('--disallowedTools')
      const tools = args[idx + 1]
      expect(tools).toContain('Write')
      expect(tools).toContain('Edit')
      expect(tools).toContain('Bash')
      expect(tools).toContain('WebFetch')
      expect(tools).toContain('WebSearch')
    })
  })

  describe('allow paths', () => {
    it('generates Read/Glob/Grep/Write/Edit for allowPaths with fileWrite enabled', () => {
      const args = buildPermissionArgs({ allowPaths: ['/src'] })
      const idx = args.indexOf('--allowedTools')
      const tools = args[idx + 1]
      expect(tools).toContain('Read(/src)')
      expect(tools).toContain('Glob(/src)')
      expect(tools).toContain('Grep(/src)')
      expect(tools).toContain('Write(/src)')
      expect(tools).toContain('Edit(/src)')
    })

    it('omits Write/Edit for allowPaths when fileWrite is false', () => {
      const args = buildPermissionArgs({ fileWrite: false, allowPaths: ['/src'] })
      const allowIdx = args.indexOf('--allowedTools')
      const allowTools = args[allowIdx + 1]
      expect(allowTools).toContain('Read(/src)')
      expect(allowTools).not.toContain('Write(/src)')
      expect(allowTools).not.toContain('Edit(/src)')
    })

    it('handles multiple allowPaths', () => {
      const args = buildPermissionArgs({ allowPaths: ['/src', '/tests'] })
      const idx = args.indexOf('--allowedTools')
      const tools = args[idx + 1]
      expect(tools).toContain('Read(/src)')
      expect(tools).toContain('Read(/tests)')
    })
  })

  describe('deny paths', () => {
    it('generates all tool denials for denyPaths', () => {
      const args = buildPermissionArgs({ denyPaths: ['/secret'] })
      const idx = args.indexOf('--disallowedTools')
      const tools = args[idx + 1]
      expect(tools).toContain('Read(/secret)')
      expect(tools).toContain('Write(/secret)')
      expect(tools).toContain('Edit(/secret)')
      expect(tools).toContain('Glob(/secret)')
      expect(tools).toContain('Grep(/secret)')
    })
  })

  describe('combined permissions', () => {
    it('handles allowPaths + denyPaths + disabled tools together', () => {
      const args = buildPermissionArgs({
        bash: false,
        allowPaths: ['/src'],
        denyPaths: ['/src/secrets'],
      })
      expect(args).toContain('--allowedTools')
      expect(args).toContain('--disallowedTools')

      const disIdx = args.indexOf('--disallowedTools')
      const disallowed = args[disIdx + 1]
      expect(disallowed).toContain('Bash')
      expect(disallowed).toContain('Read(/src/secrets)')
    })
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 4. STATE MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════

describe('parseState', () => {
  describe('normal state', () => {
    it('parses valid state with workspaces', () => {
      const raw = {
        workspaces: [
          { id: 'ws-1', name: 'Work', folders: ['/project'] },
          { id: 'ws-2', name: 'Personal', folders: [] },
        ],
        activeWorkspaceId: 'ws-1',
      }
      const state = parseState(raw)
      expect(state.workspaces).toHaveLength(2)
      expect(state.activeWorkspaceId).toBe('ws-1')
    })

    it('defaults activeWorkspaceId to first workspace if missing', () => {
      const raw = {
        workspaces: [{ id: 'ws-1', name: 'Work', folders: [] }],
      }
      const state = parseState(raw)
      expect(state.activeWorkspaceId).toBe('ws-1')
    })

    it('handles empty workspaces array', () => {
      const state = parseState({ workspaces: [] })
      expect(state.workspaces).toEqual([])
      expect(state.activeWorkspaceId).toBeNull()
    })
  })

  describe('legacy migration', () => {
    it('migrates from legacy { folders: [] } format', () => {
      const raw = { folders: ['/old/project1', '/old/project2'] }
      const state = parseState(raw)
      expect(state.workspaces).toHaveLength(1)
      expect(state.workspaces[0].name).toBe('Personal')
      expect(state.workspaces[0].folders).toEqual(['/old/project1', '/old/project2'])
      expect(state.activeWorkspaceId).toBe(state.workspaces[0].id)
    })

    it('generates a unique ID for migrated workspace', () => {
      const state = parseState({ folders: [] })
      expect(state.workspaces[0].id).toMatch(/^default-\d+$/)
    })
  })

  describe('edge cases', () => {
    it('returns empty state for null', () => {
      expect(parseState(null)).toEqual({ workspaces: [], activeWorkspaceId: null })
    })

    it('returns empty state for undefined', () => {
      expect(parseState(undefined)).toEqual({ workspaces: [], activeWorkspaceId: null })
    })

    it('returns empty state for empty object', () => {
      expect(parseState({})).toEqual({ workspaces: [], activeWorkspaceId: null })
    })

    it('returns empty state for invalid types', () => {
      expect(parseState('string')).toEqual({ workspaces: [], activeWorkspaceId: null })
      expect(parseState(42)).toEqual({ workspaces: [], activeWorkspaceId: null })
    })
  })
})

describe('getWorkspace', () => {
  const state: State = {
    workspaces: [
      { id: 'ws-1', name: 'Work', folders: ['/project'] },
      { id: 'ws-2', name: 'Personal', folders: [] },
    ],
    activeWorkspaceId: 'ws-1',
  }

  it('finds workspace by ID', () => {
    const ws = getWorkspace(state, 'ws-1')
    expect(ws?.name).toBe('Work')
  })

  it('returns null for unknown ID', () => {
    expect(getWorkspace(state, 'ws-999')).toBeNull()
  })

  it('returns null for null ID', () => {
    expect(getWorkspace(state, null)).toBeNull()
  })

  it('returns null for empty string ID', () => {
    expect(getWorkspace(state, '')).toBeNull()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 5. ROOM LOG & MESSAGE MERGING
// ═══════════════════════════════════════════════════════════════════════════

describe('isDuplicateMessage', () => {
  const existing: RoomUserMessage[] = [
    { id: 'msg-1', ts: 1000, text: 'hello' },
    { id: 'msg-2', ts: 2000, text: 'world' },
  ]

  it('detects exact duplicate by ts + text', () => {
    expect(isDuplicateMessage(existing, { id: 'msg-3', ts: 1000, text: 'hello' })).toBe(true)
  })

  it('allows same text with different ts', () => {
    expect(isDuplicateMessage(existing, { id: 'msg-3', ts: 3000, text: 'hello' })).toBe(false)
  })

  it('allows same ts with different text', () => {
    expect(isDuplicateMessage(existing, { id: 'msg-3', ts: 1000, text: 'different' })).toBe(false)
  })

  it('handles empty log', () => {
    expect(isDuplicateMessage([], { id: 'msg-1', ts: 1000, text: 'hello' })).toBe(false)
  })
})

describe('mergeMessages', () => {
  it('merges user messages from room log', () => {
    const roomLog: RoomUserMessage[] = [
      { id: 'u1', ts: 1000, text: 'Hi' },
      { id: 'u2', ts: 3000, text: 'Thanks' },
    ]
    const result = mergeMessages(roomLog, [])
    expect(result).toHaveLength(2)
    expect(result[0].agentName).toBe('user')
    expect(result[0].text).toBe('Hi')
  })

  it('merges agent messages from history', () => {
    const agents = [{
      agentName: 'assistant',
      fileName: 'assistant.octo',
      history: [
        { role: 'user', text: 'Hi', roomTs: 1000 },
        { role: 'assistant', text: 'Hello!', roomTs: 2000 },
      ],
    }]
    const result = mergeMessages([], agents)
    // Should skip user messages from agent history
    expect(result).toHaveLength(1)
    expect(result[0].agentName).toBe('assistant')
    expect(result[0].text).toBe('Hello!')
  })

  it('sorts all messages chronologically', () => {
    const roomLog: RoomUserMessage[] = [
      { id: 'u1', ts: 1000, text: 'Hi' },
      { id: 'u2', ts: 5000, text: 'Bye' },
    ]
    const agents = [{
      agentName: 'bot',
      fileName: 'bot.octo',
      history: [
        { role: 'assistant', text: 'Hello!', roomTs: 2000 },
        { role: 'assistant', text: 'Goodbye!', roomTs: 4000 },
      ],
    }]
    const result = mergeMessages(roomLog, agents)
    expect(result.map((m) => m.ts)).toEqual([1000, 2000, 4000, 5000])
  })

  it('handles multiple agents', () => {
    const agents = [
      {
        agentName: 'developer',
        fileName: 'developer.octo',
        history: [{ role: 'assistant', text: 'Done!', roomTs: 2000 }],
      },
      {
        agentName: 'reviewer',
        fileName: 'reviewer.octo',
        history: [{ role: 'assistant', text: 'LGTM!', roomTs: 3000 }],
      },
    ]
    const result = mergeMessages([], agents)
    expect(result).toHaveLength(2)
    expect(result[0].agentName).toBe('developer')
    expect(result[1].agentName).toBe('reviewer')
  })

  it('skips agent messages without roomTs', () => {
    const agents = [{
      agentName: 'bot',
      fileName: 'bot.octo',
      history: [
        { role: 'assistant', text: 'old message' }, // no roomTs
        { role: 'assistant', text: 'new message', roomTs: 1000 },
      ],
    }]
    const result = mergeMessages([], agents)
    expect(result).toHaveLength(1)
    expect(result[0].text).toBe('new message')
  })

  it('preserves attachments on user messages', () => {
    const roomLog: RoomUserMessage[] = [
      { id: 'u1', ts: 1000, text: 'See image', attachments: [{ type: 'image', path: 'a.png' }] },
    ]
    const result = mergeMessages(roomLog, [])
    expect(result[0].attachments).toHaveLength(1)
  })

  it('handles empty inputs', () => {
    expect(mergeMessages([], [])).toEqual([])
  })
})

describe('paginateMessages', () => {
  const messages = Array.from({ length: 20 }, (_, i) => ({
    id: `msg-${i}`,
    agentName: 'user',
    text: `message ${i}`,
    ts: (i + 1) * 1000,
  }))

  describe('initial load (no beforeTs)', () => {
    it('returns last N messages', () => {
      const result = paginateMessages(messages, 5)
      expect(result.messages).toHaveLength(5)
      expect(result.messages[0].ts).toBe(16000)
      expect(result.messages[4].ts).toBe(20000)
      expect(result.hasMore).toBe(true)
    })

    it('returns all messages when limit exceeds total', () => {
      const result = paginateMessages(messages, 50)
      expect(result.messages).toHaveLength(20)
      expect(result.hasMore).toBe(false)
    })

    it('handles empty message list', () => {
      const result = paginateMessages([], 10)
      expect(result.messages).toEqual([])
      expect(result.hasMore).toBe(false)
    })

    it('handles limit of 1', () => {
      const result = paginateMessages(messages, 1)
      expect(result.messages).toHaveLength(1)
      expect(result.messages[0].ts).toBe(20000)
      expect(result.hasMore).toBe(true)
    })
  })

  describe('with beforeTs (pagination)', () => {
    it('returns messages before the cutoff', () => {
      const result = paginateMessages(messages, 5, 10000)
      expect(result.messages).toHaveLength(5)
      // Should be ts 5000-9000 (the last 5 messages with ts < 10000)
      expect(result.messages.every((m) => m.ts < 10000)).toBe(true)
      expect(result.hasMore).toBe(true)
    })

    it('returns all remaining when fewer than limit', () => {
      const result = paginateMessages(messages, 50, 5000)
      // ts < 5000 → ts 1000, 2000, 3000, 4000
      expect(result.messages).toHaveLength(4)
      expect(result.hasMore).toBe(false)
    })

    it('returns empty when beforeTs is before all messages', () => {
      const result = paginateMessages(messages, 5, 500)
      expect(result.messages).toEqual([])
      expect(result.hasMore).toBe(false)
    })
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 6. FILE UPLOAD VALIDATION
// ═══════════════════════════════════════════════════════════════════════════

describe('validateFileUpload', () => {
  describe('valid files', () => {
    it('accepts PNG images', () => {
      const result = validateFileUpload('photo.png', 1000)
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.type).toBe('image')
    })

    it('accepts JPG images', () => {
      expect(validateFileUpload('photo.jpg', 1000)).toEqual({ ok: true, type: 'image' })
    })

    it('accepts JPEG images', () => {
      expect(validateFileUpload('photo.jpeg', 1000)).toEqual({ ok: true, type: 'image' })
    })

    it('accepts GIF images', () => {
      expect(validateFileUpload('animation.gif', 1000)).toEqual({ ok: true, type: 'image' })
    })

    it('accepts WebP images', () => {
      expect(validateFileUpload('image.webp', 1000)).toEqual({ ok: true, type: 'image' })
    })

    it('accepts TXT files', () => {
      expect(validateFileUpload('notes.txt', 1000)).toEqual({ ok: true, type: 'text' })
    })

    it('accepts LOG files', () => {
      expect(validateFileUpload('app.log', 1000)).toEqual({ ok: true, type: 'text' })
    })

    it('accepts JSON files', () => {
      expect(validateFileUpload('data.json', 1000)).toEqual({ ok: true, type: 'text' })
    })

    it('accepts CSV files', () => {
      expect(validateFileUpload('data.csv', 1000)).toEqual({ ok: true, type: 'text' })
    })

    it('is case-insensitive for extensions', () => {
      expect(validateFileUpload('PHOTO.PNG', 1000)).toEqual({ ok: true, type: 'image' })
      expect(validateFileUpload('data.JSON', 1000)).toEqual({ ok: true, type: 'text' })
    })

    it('accepts file at exactly 10MB', () => {
      expect(validateFileUpload('big.png', MAX_FILE_SIZE)).toEqual({ ok: true, type: 'image' })
    })
  })

  describe('rejected files', () => {
    it('rejects file exceeding 10MB', () => {
      const result = validateFileUpload('huge.png', MAX_FILE_SIZE + 1)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBe('File exceeds 10MB limit')
    })

    it('rejects executable files', () => {
      const result = validateFileUpload('virus.exe', 1000)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toContain('.exe')
    })

    it('rejects script files', () => {
      expect(validateFileUpload('script.js', 1000).ok).toBe(false)
      expect(validateFileUpload('script.sh', 1000).ok).toBe(false)
      expect(validateFileUpload('script.py', 1000).ok).toBe(false)
    })

    it('rejects HTML files (XSS risk)', () => {
      expect(validateFileUpload('page.html', 1000).ok).toBe(false)
    })

    it('rejects SVG files (XSS risk)', () => {
      expect(validateFileUpload('icon.svg', 1000).ok).toBe(false)
    })

    it('rejects files without extension', () => {
      expect(validateFileUpload('noext', 1000).ok).toBe(false)
    })

    it('rejects TypeScript files', () => {
      expect(validateFileUpload('code.ts', 1000).ok).toBe(false)
    })

    it('rejects PDF files', () => {
      expect(validateFileUpload('doc.pdf', 1000).ok).toBe(false)
    })
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 7. SETTINGS MERGE
// ═══════════════════════════════════════════════════════════════════════════

describe('mergeSettings', () => {
  it('returns defaults for null input', () => {
    expect(mergeSettings(null)).toEqual(DEFAULT_SETTINGS)
  })

  it('returns defaults for undefined input', () => {
    expect(mergeSettings(undefined)).toEqual(DEFAULT_SETTINGS)
  })

  it('returns defaults for non-object input', () => {
    expect(mergeSettings('invalid')).toEqual(DEFAULT_SETTINGS)
    expect(mergeSettings(42)).toEqual(DEFAULT_SETTINGS)
  })

  it('merges partial general settings', () => {
    const result = mergeSettings({ general: { language: 'ko' } })
    expect(result.general.language).toBe('ko')
    expect(result.general.restoreLastWorkspace).toBe(true) // default
    expect(result.general.launchAtLogin).toBe(false) // default
  })

  it('merges partial agent permissions', () => {
    const result = mergeSettings({
      agents: { defaultPermissions: { bash: true } },
    })
    expect(result.agents.defaultPermissions.bash).toBe(true)
    expect(result.agents.defaultPermissions.fileWrite).toBe(false) // default
    expect(result.agents.defaultPermissions.network).toBe(false) // default
  })

  it('merges partial appearance settings', () => {
    const result = mergeSettings({ appearance: { chatFontSize: 16 } })
    expect(result.appearance.chatFontSize).toBe(16)
  })

  it('handles missing nested objects gracefully', () => {
    const result = mergeSettings({ agents: {} })
    expect(result.agents.defaultPermissions).toEqual(DEFAULT_SETTINGS.agents.defaultPermissions)
  })

  it('preserves all fields when fully specified', () => {
    const custom = {
      general: { restoreLastWorkspace: false, launchAtLogin: true, language: 'ko' },
      agents: { defaultPermissions: { fileWrite: true, bash: true, network: true } },
      appearance: { chatFontSize: 18 },
    }
    const result = mergeSettings(custom)
    expect(result).toEqual(custom)
  })

  it('ignores unknown extra fields', () => {
    const result = mergeSettings({ general: { language: 'ko' }, unknownField: 'test' })
    expect(result.general.language).toBe('ko')
    expect((result as any).unknownField).toBeUndefined()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 8. OCTO FILE PARSING
// ═══════════════════════════════════════════════════════════════════════════

describe('parseOctoFile', () => {
  it('parses complete .octo content', () => {
    const content = {
      name: 'developer',
      role: 'Full-stack developer',
      icon: '🖥',
      hidden: false,
      permissions: { fileWrite: true, bash: true, network: false },
    }
    const result = parseOctoFile('/project/developer.octo', content, 'developer.octo')
    expect(result).toEqual({
      path: '/project/developer.octo',
      name: 'developer',
      role: 'Full-stack developer',
      icon: '🖥',
      hidden: false,
      permissions: { fileWrite: true, bash: true, network: false },
    })
  })

  it('uses filename as name fallback', () => {
    const result = parseOctoFile('/project/bot.octo', {}, 'bot.octo')
    expect(result.name).toBe('bot')
  })

  it('uses default values for missing fields', () => {
    const result = parseOctoFile('/project/agent.octo', {}, 'agent.octo')
    expect(result.role).toBe('')
    expect(result.icon).toBe('bot')
    expect(result.hidden).toBe(false)
    expect(result.permissions).toBeNull()
  })
})

describe('countVisibleAgents', () => {
  it('counts only non-hidden agents', () => {
    const agents: ParsedOcto[] = [
      { path: '/a.octo', name: 'a', role: '', icon: 'bot', hidden: false, permissions: null },
      { path: '/b.octo', name: 'b', role: '', icon: 'bot', hidden: true, permissions: null },
      { path: '/c.octo', name: 'c', role: '', icon: 'bot', hidden: false, permissions: null },
    ]
    expect(countVisibleAgents(agents)).toBe(2)
  })

  it('returns 0 for empty array', () => {
    expect(countVisibleAgents([])).toBe(0)
  })

  it('returns 0 when all agents are hidden', () => {
    const agents: ParsedOcto[] = [
      { path: '/a.octo', name: 'a', role: '', icon: 'bot', hidden: true, permissions: null },
    ]
    expect(countVisibleAgents(agents)).toBe(0)
  })

  it('MAX_VISIBLE_AGENTS is 10', () => {
    expect(MAX_VISIBLE_AGENTS).toBe(10)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 9. CROSS-FEATURE SIDE EFFECT TESTS
// ═══════════════════════════════════════════════════════════════════════════

describe('Cross-feature: side effect prevention', () => {
  it('sanitizeWikiName does not affect agent name validation', () => {
    // Wiki allows spaces, agent names also allow spaces — both should work
    expect(sanitizeWikiName('my notes')).toBe('my notes.md')
    expect(validateAgentName('my agent').ok).toBe(true)
  })

  it('permission builder does not modify input object', () => {
    const perms: OctoPermissions = { fileWrite: true, bash: false, allowPaths: ['/src'] }
    const original = JSON.stringify(perms)
    buildPermissionArgs(perms)
    expect(JSON.stringify(perms)).toBe(original)
  })

  it('parseState does not mutate input', () => {
    const raw = { workspaces: [{ id: 'ws-1', name: 'A', folders: [] }], activeWorkspaceId: 'ws-1' }
    const original = JSON.stringify(raw)
    parseState(raw)
    expect(JSON.stringify(raw)).toBe(original)
  })

  it('mergeSettings does not mutate input', () => {
    const raw = { general: { language: 'ko' } }
    const original = JSON.stringify(raw)
    mergeSettings(raw)
    expect(JSON.stringify(raw)).toBe(original)
  })

  it('paginateMessages does not mutate input array', () => {
    const msgs = [
      { id: '1', agentName: 'user', text: 'a', ts: 1000 },
      { id: '2', agentName: 'user', text: 'b', ts: 2000 },
    ]
    const original = JSON.stringify(msgs)
    paginateMessages(msgs, 1)
    expect(JSON.stringify(msgs)).toBe(original)
  })

  it('mergeMessages does not mutate input arrays', () => {
    const roomLog: RoomUserMessage[] = [{ id: 'u1', ts: 1000, text: 'Hi' }]
    const agents = [{
      agentName: 'bot',
      fileName: 'bot.octo',
      history: [{ role: 'assistant', text: 'Hey', roomTs: 2000 }],
    }]
    const originalRoom = JSON.stringify(roomLog)
    const originalAgents = JSON.stringify(agents)
    mergeMessages(roomLog, agents)
    expect(JSON.stringify(roomLog)).toBe(originalRoom)
    expect(JSON.stringify(agents)).toBe(originalAgents)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 10. CONSTANTS VALIDATION
// ═══════════════════════════════════════════════════════════════════════════

describe('Constants integrity', () => {
  it('ALLOWED_IMAGE_EXTS includes common image formats', () => {
    expect(ALLOWED_IMAGE_EXTS).toContain('.png')
    expect(ALLOWED_IMAGE_EXTS).toContain('.jpg')
    expect(ALLOWED_IMAGE_EXTS).toContain('.jpeg')
    expect(ALLOWED_IMAGE_EXTS).toContain('.gif')
    expect(ALLOWED_IMAGE_EXTS).toContain('.webp')
  })

  it('ALLOWED_IMAGE_EXTS does NOT include dangerous formats', () => {
    expect(ALLOWED_IMAGE_EXTS).not.toContain('.svg') // XSS risk
    expect(ALLOWED_IMAGE_EXTS).not.toContain('.html')
    expect(ALLOWED_IMAGE_EXTS).not.toContain('.js')
  })

  it('ALLOWED_TEXT_EXTS includes common text formats', () => {
    expect(ALLOWED_TEXT_EXTS).toContain('.txt')
    expect(ALLOWED_TEXT_EXTS).toContain('.log')
    expect(ALLOWED_TEXT_EXTS).toContain('.json')
    expect(ALLOWED_TEXT_EXTS).toContain('.csv')
  })

  it('MAX_FILE_SIZE is 10MB', () => {
    expect(MAX_FILE_SIZE).toBe(10 * 1024 * 1024)
  })

  it('DEFAULT_SETTINGS has secure defaults (all permissions disabled)', () => {
    expect(DEFAULT_SETTINGS.agents.defaultPermissions.fileWrite).toBe(false)
    expect(DEFAULT_SETTINGS.agents.defaultPermissions.bash).toBe(false)
    expect(DEFAULT_SETTINGS.agents.defaultPermissions.network).toBe(false)
  })

  it('MAX_VISIBLE_AGENTS limits agent count', () => {
    expect(MAX_VISIBLE_AGENTS).toBe(10)
    expect(MAX_VISIBLE_AGENTS).toBeGreaterThan(0)
    expect(MAX_VISIBLE_AGENTS).toBeLessThanOrEqual(20)
  })
})
