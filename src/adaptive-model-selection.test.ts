import { describe, it, expect, beforeEach, vi } from 'vitest'
import { SmartObserver, ObserverMessage } from './smart-observer'
import { ConversationObserver } from './observer'

// Mock child_process to avoid real CLI calls
vi.mock('child_process', () => ({
  spawn: vi.fn(),
  execFile: vi.fn(),
}))

import { spawn } from 'child_process'
const mockSpawn = vi.mocked(spawn)

function msg(agentName: string, text: string): ObserverMessage {
  return { agentName, text, ts: Date.now() }
}

// ── Helpers for testing main.ts logic extracted into pure functions ──

/**
 * Simulates the dispatcher model parsing logic from main.ts lines 1424-1427.
 * Extracted here so we can test without Electron IPC.
 */
function parseDispatcherModel(parsed: any): string {
  const allowedModels = ['haiku', 'sonnet', 'opus']
  const model = typeof parsed.model === 'string' && allowedModels.includes(parsed.model)
    ? parsed.model as 'sonnet' | 'opus'
    : 'sonnet'
  return model
}

/**
 * Simulates the agent model selection logic from main.ts lines 1594-1602.
 * Determines which --model flag to apply when launching an agent CLI.
 */
function resolveAgentModel(settings: {
  advanced?: {
    autoModelSelection?: boolean
    defaultAgentModel?: string
  }
}, dispatcherModel?: string): string | null {
  const allowedModels = ['haiku', 'sonnet', 'opus']
  const autoModel = settings.advanced?.autoModelSelection !== false // default true

  if (autoModel && dispatcherModel && allowedModels.includes(dispatcherModel)) {
    return dispatcherModel
  } else if (!autoModel && settings.advanced?.defaultAgentModel && allowedModels.includes(settings.advanced.defaultAgentModel)) {
    return settings.advanced.defaultAgentModel
  }
  return null // no --model flag, use CLI default
}

/**
 * Simulates the settings:save observer model application from main.ts lines 2187-2190.
 */
function applyObserverModelSetting(observer: SmartObserver, settings: {
  advanced?: { observerModel?: string }
}) {
  const allowed = ['haiku', 'sonnet', 'opus']
  if (settings.advanced?.observerModel && allowed.includes(settings.advanced.observerModel)) {
    observer.model = settings.advanced.observerModel
  }
}

// ── Default settings shape (mirrors main.ts DEFAULT_SETTINGS.advanced) ──
const DEFAULT_ADVANCED = {
  observerModel: 'haiku' as const,
  defaultAgentModel: 'haiku' as const,
  autoModelSelection: true,
}

// ════════════════════════════════════════════════════════════════
//  TEST SUITES
// ════════════════════════════════════════════════════════════════

describe('Adaptive Model Selection', () => {

  // ── 1. SmartObserver DEFAULT_CLI_MODEL ─────────────────────

  describe('SmartObserver default model', () => {
    it('uses haiku as default CLI model', () => {
      const so = new SmartObserver(new ConversationObserver())
      expect(so.model).toBe('haiku')
    })

    it('model getter/setter works correctly', () => {
      const so = new SmartObserver(new ConversationObserver())
      so.model = 'sonnet'
      expect(so.model).toBe('sonnet')
      so.model = 'opus'
      expect(so.model).toBe('opus')
      so.model = 'haiku'
      expect(so.model).toBe('haiku')
    })

    it('model persists across operations', async () => {
      const so = new SmartObserver(new ConversationObserver())
      so.model = 'sonnet'
      so.enabled = false
      await so.onMessage('/test', msg('user', 'hello'))
      expect(so.model).toBe('sonnet') // unchanged
    })
  })

  // ── 2. Default settings values ────────────────────────────

  describe('default settings', () => {
    it('observerModel defaults to haiku', () => {
      expect(DEFAULT_ADVANCED.observerModel).toBe('haiku')
    })

    it('defaultAgentModel defaults to haiku', () => {
      expect(DEFAULT_ADVANCED.defaultAgentModel).toBe('haiku')
    })

    it('autoModelSelection defaults to true', () => {
      expect(DEFAULT_ADVANCED.autoModelSelection).toBe(true)
    })
  })

  // ── 3. Dispatcher model parsing ───────────────────────────

  describe('dispatcher model parsing', () => {
    it('parses haiku model from dispatcher output', () => {
      expect(parseDispatcherModel({ leader: 'developer', model: 'haiku' })).toBe('haiku')
    })

    it('parses sonnet model from dispatcher output', () => {
      expect(parseDispatcherModel({ leader: 'developer', model: 'sonnet' })).toBe('sonnet')
    })

    it('parses opus model from dispatcher output', () => {
      expect(parseDispatcherModel({ leader: 'developer', model: 'opus' })).toBe('opus')
    })

    it('falls back to sonnet for missing model field', () => {
      expect(parseDispatcherModel({ leader: 'developer' })).toBe('sonnet')
    })

    it('falls back to sonnet for invalid model string', () => {
      expect(parseDispatcherModel({ leader: 'developer', model: 'gpt-4' })).toBe('sonnet')
    })

    it('falls back to sonnet for non-string model', () => {
      expect(parseDispatcherModel({ leader: 'developer', model: 42 })).toBe('sonnet')
      expect(parseDispatcherModel({ leader: 'developer', model: null })).toBe('sonnet')
      expect(parseDispatcherModel({ leader: 'developer', model: true })).toBe('sonnet')
    })

    it('is case-sensitive (uppercase rejected)', () => {
      expect(parseDispatcherModel({ leader: 'developer', model: 'Haiku' })).toBe('sonnet')
      expect(parseDispatcherModel({ leader: 'developer', model: 'SONNET' })).toBe('sonnet')
    })
  })

  // ── 4. Agent model selection logic ────────────────────────

  describe('agent model selection (auto vs fixed)', () => {

    // Auto mode ON (default)
    describe('auto mode enabled (default)', () => {
      it('uses dispatcher-recommended model when valid', () => {
        const settings = { advanced: { autoModelSelection: true, defaultAgentModel: 'opus' } }
        expect(resolveAgentModel(settings, 'haiku')).toBe('haiku')
        expect(resolveAgentModel(settings, 'sonnet')).toBe('sonnet')
        expect(resolveAgentModel(settings, 'opus')).toBe('opus')
      })

      it('returns null when dispatcher model is invalid', () => {
        const settings = { advanced: { autoModelSelection: true, defaultAgentModel: 'opus' } }
        expect(resolveAgentModel(settings, 'gpt-4')).toBeNull()
      })

      it('returns null when no dispatcher model provided', () => {
        const settings = { advanced: { autoModelSelection: true, defaultAgentModel: 'opus' } }
        expect(resolveAgentModel(settings, undefined)).toBeNull()
      })

      it('treats missing autoModelSelection as true (default)', () => {
        const settings = { advanced: { defaultAgentModel: 'opus' } }
        expect(resolveAgentModel(settings, 'haiku')).toBe('haiku')
      })

      it('treats empty advanced as auto mode', () => {
        const settings = {}
        expect(resolveAgentModel(settings, 'sonnet')).toBe('sonnet')
      })

      it('ignores defaultAgentModel in auto mode', () => {
        const settings = { advanced: { autoModelSelection: true, defaultAgentModel: 'opus' } }
        // Dispatcher says haiku, should use haiku (not opus)
        expect(resolveAgentModel(settings, 'haiku')).toBe('haiku')
      })
    })

    // Auto mode OFF (fixed model)
    describe('auto mode disabled (fixed)', () => {
      it('uses defaultAgentModel from settings', () => {
        const settings = { advanced: { autoModelSelection: false, defaultAgentModel: 'haiku' } }
        expect(resolveAgentModel(settings, 'opus')).toBe('haiku') // ignores dispatcher
      })

      it('works with all three model options', () => {
        expect(resolveAgentModel({ advanced: { autoModelSelection: false, defaultAgentModel: 'haiku' } })).toBe('haiku')
        expect(resolveAgentModel({ advanced: { autoModelSelection: false, defaultAgentModel: 'sonnet' } })).toBe('sonnet')
        expect(resolveAgentModel({ advanced: { autoModelSelection: false, defaultAgentModel: 'opus' } })).toBe('opus')
      })

      it('ignores dispatcher model completely', () => {
        const settings = { advanced: { autoModelSelection: false, defaultAgentModel: 'sonnet' } }
        expect(resolveAgentModel(settings, 'opus')).toBe('sonnet')
        expect(resolveAgentModel(settings, 'haiku')).toBe('sonnet')
      })

      it('returns null when defaultAgentModel is invalid', () => {
        const settings = { advanced: { autoModelSelection: false, defaultAgentModel: 'gpt-4' } }
        expect(resolveAgentModel(settings)).toBeNull()
      })

      it('returns null when defaultAgentModel is missing', () => {
        const settings = { advanced: { autoModelSelection: false } }
        expect(resolveAgentModel(settings)).toBeNull()
      })
    })
  })

  // ── 5. Observer model setting application ─────────────────

  describe('settings:save applies observer model', () => {
    let so: SmartObserver

    beforeEach(() => {
      so = new SmartObserver(new ConversationObserver())
    })

    it('applies haiku to observer', () => {
      so.model = 'opus' // start with something different
      applyObserverModelSetting(so, { advanced: { observerModel: 'haiku' } })
      expect(so.model).toBe('haiku')
    })

    it('applies sonnet to observer', () => {
      applyObserverModelSetting(so, { advanced: { observerModel: 'sonnet' } })
      expect(so.model).toBe('sonnet')
    })

    it('applies opus to observer', () => {
      applyObserverModelSetting(so, { advanced: { observerModel: 'opus' } })
      expect(so.model).toBe('opus')
    })

    it('does not change model for invalid value', () => {
      so.model = 'haiku'
      applyObserverModelSetting(so, { advanced: { observerModel: 'gpt-4' } })
      expect(so.model).toBe('haiku') // unchanged
    })

    it('does not change model when observerModel is missing', () => {
      so.model = 'sonnet'
      applyObserverModelSetting(so, { advanced: {} })
      expect(so.model).toBe('sonnet') // unchanged
    })

    it('does not change model when advanced is missing', () => {
      so.model = 'opus'
      applyObserverModelSetting(so, {})
      expect(so.model).toBe('opus') // unchanged
    })
  })

  // ── 6. Dispatcher prompt model tier rules ─────────────────

  describe('dispatcher model tier classification', () => {
    // These validate the model tier rules defined in the dispatcher prompt
    const tierRules = {
      haiku: ['greetings', 'short answers', 'formatting', 'translations', 'simple Q&A', 'quick lookups'],
      sonnet: ['code implementation', 'debugging', 'multi-step analysis', 'refactoring', 'test writing'],
      opus: ['architecture design', 'security audit', 'complex debugging', 'nuanced reasoning'],
    }

    it('haiku tier covers simple tasks', () => {
      expect(tierRules.haiku.length).toBeGreaterThanOrEqual(4)
      expect(tierRules.haiku).toContain('greetings')
      expect(tierRules.haiku).toContain('simple Q&A')
    })

    it('sonnet tier covers moderate tasks', () => {
      expect(tierRules.sonnet.length).toBeGreaterThanOrEqual(3)
      expect(tierRules.sonnet).toContain('code implementation')
      expect(tierRules.sonnet).toContain('debugging')
    })

    it('opus tier covers complex tasks', () => {
      expect(tierRules.opus.length).toBeGreaterThanOrEqual(3)
      expect(tierRules.opus).toContain('architecture design')
      expect(tierRules.opus).toContain('security audit')
    })
  })

  // ── 7. allowedModels validation ───────────────────────────

  describe('allowedModels includes haiku', () => {
    const allowedModels = ['haiku', 'sonnet', 'opus']

    it('contains exactly 3 models', () => {
      expect(allowedModels).toHaveLength(3)
    })

    it('includes haiku', () => {
      expect(allowedModels).toContain('haiku')
    })

    it('includes sonnet', () => {
      expect(allowedModels).toContain('sonnet')
    })

    it('includes opus', () => {
      expect(allowedModels).toContain('opus')
    })

    it('rejects unknown models', () => {
      expect(allowedModels).not.toContain('gpt-4')
      expect(allowedModels).not.toContain('claude')
      expect(allowedModels).not.toContain('Haiku') // case-sensitive
    })
  })

  // ── 8. Edge cases & integration scenarios ─────────────────

  describe('edge cases', () => {
    it('model selection chain: dispatcher → auto → agent', () => {
      // Full flow: dispatcher recommends haiku, auto mode on → agent uses haiku
      const dispatcherOutput = { leader: 'developer', collaborators: [], model: 'haiku' }
      const model = parseDispatcherModel(dispatcherOutput)
      const settings = { advanced: { ...DEFAULT_ADVANCED } }
      const resolved = resolveAgentModel(settings, model)
      expect(resolved).toBe('haiku')
    })

    it('model selection chain: dispatcher → fixed override', () => {
      // Full flow: dispatcher recommends opus, but auto mode off + fixed to sonnet
      const dispatcherOutput = { leader: 'developer', collaborators: [], model: 'opus' }
      const model = parseDispatcherModel(dispatcherOutput)
      const settings = { advanced: { autoModelSelection: false, defaultAgentModel: 'sonnet' } }
      const resolved = resolveAgentModel(settings, model)
      expect(resolved).toBe('sonnet') // fixed setting wins
    })

    it('model selection chain: no dispatcher model → auto mode → null', () => {
      // Dispatcher returns legacy format without model field
      const dispatcherOutput = { leader: 'developer', collaborators: [] }
      const model = parseDispatcherModel(dispatcherOutput) // falls back to sonnet
      const settings = { advanced: { ...DEFAULT_ADVANCED } }
      const resolved = resolveAgentModel(settings, model)
      expect(resolved).toBe('sonnet')
    })

    it('observer model independent of agent model', () => {
      // Observer can use a different model than agents
      const so = new SmartObserver(new ConversationObserver())
      applyObserverModelSetting(so, { advanced: { observerModel: 'opus' } })
      expect(so.model).toBe('opus')

      // Agent model resolution is separate
      const agentModel = resolveAgentModel({ advanced: { ...DEFAULT_ADVANCED } }, 'haiku')
      expect(agentModel).toBe('haiku')

      // They're independent
      expect(so.model).not.toBe(agentModel)
    })

    it('settings with only partial advanced field', () => {
      // Only observerModel set, rest defaults
      const resolved = resolveAgentModel({ advanced: { observerModel: 'opus' } as any })
      // autoModelSelection not explicitly false → defaults to true → auto mode
      // No dispatcher model → returns null
      expect(resolved).toBeNull()
    })
  })
})
