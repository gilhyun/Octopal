import { describe, expect, it } from 'vitest'
import { cliDisplayName, cliVersionLabel } from './cli-display'

describe('cli display helpers', () => {
  it('uses product names for known subscription CLIs', () => {
    expect(cliDisplayName('claude')).toBe('Claude CLI')
    expect(cliDisplayName('codex')).toBe('Codex CLI')
  })

  it('removes duplicated binary names from version output', () => {
    expect(cliVersionLabel('codex', 'codex-cli 0.128.0')).toBe('0.128.0')
    expect(cliVersionLabel('codex', 'codex 0.128.0')).toBe('0.128.0')
    expect(cliVersionLabel('claude', 'Claude CLI 2.1.0')).toBe('2.1.0')
  })

  it('keeps already-clean version output untouched', () => {
    expect(cliVersionLabel('codex', '0.128.0')).toBe('0.128.0')
    expect(cliVersionLabel('claude', 'Claude Code 2.1.0')).toBe('Claude Code 2.1.0')
  })
})
