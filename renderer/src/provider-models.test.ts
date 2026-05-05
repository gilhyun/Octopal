import { describe, expect, it } from 'vitest'
import {
  modelOptionsForProviderAuth,
  normalizeModelForProviderAuth,
  preferredModelForProvider,
} from './provider-models'

const manifest: ProvidersManifest = {
  openai: {
    displayName: 'OpenAI',
    models: ['gpt-5.5', 'gpt-5.4', 'gpt-5'],
    authMethods: [],
  },
  anthropic: {
    displayName: 'Anthropic',
    models: ['claude-sonnet-4-6'],
    authMethods: [],
  },
}

describe('provider model helpers', () => {
  it('filters OpenAI ChatGPT subscription to the Goose-supported catalog', () => {
    const models = modelOptionsForProviderAuth('openai', 'cli_subscription', manifest)
    expect(models).toEqual([
      'gpt-5.4',
      'gpt-5.3-codex',
    ])
    expect(preferredModelForProvider('openai', models)).toBe('gpt-5.4')
  })

  it('keeps API-key OpenAI models from the manifest', () => {
    const models = modelOptionsForProviderAuth('openai', 'api_key', manifest)
    expect(models).toEqual(['gpt-5.5', 'gpt-5.4', 'gpt-5'])
    expect(preferredModelForProvider('openai', models)).toBe('gpt-5.5')
  })

  it('normalizes stale Codex CLI selections to the supported default', () => {
    expect(normalizeModelForProviderAuth(
      'openai',
      'cli_subscription',
      'gpt-5.5',
      manifest,
    )).toBe('gpt-5.4')
    expect(normalizeModelForProviderAuth(
      'openai',
      'api_key',
      'gpt-5.5',
      manifest,
    )).toBe('gpt-5.5')
  })

  it('adds Anthropic aliases above manifest models', () => {
    expect(modelOptionsForProviderAuth('anthropic', 'api_key', manifest)).toEqual([
      'opus',
      'sonnet',
      'haiku',
      'claude-sonnet-4-6',
    ])
  })
})
