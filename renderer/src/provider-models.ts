export const CHATGPT_CODEX_MODELS = [
  'gpt-5.4',
  'gpt-5.3-codex',
]

export function modelOptionsForProviderAuth(
  providerId: string,
  authMode: AuthMode | 'host_only' | null | undefined,
  manifest: ProvidersManifest | null,
): string[] {
  if (providerId === 'openai' && authMode === 'cli_subscription') {
    return CHATGPT_CODEX_MODELS
  }

  if (!manifest) return []
  const entry = manifest[providerId]
  if (!entry || !Array.isArray(entry.models)) return []
  if (providerId === 'anthropic') return ['opus', 'sonnet', 'haiku', ...entry.models]
  return entry.models
}

export function preferredModelForProvider(providerId: string, options: string[]): string {
  if (providerId === 'anthropic') {
    return options.find((m) => m === 'sonnet')
      ?? options.find((m) => m === 'claude-sonnet-4-6')
      ?? options[0]
      ?? ''
  }
  if (providerId === 'openai') {
    return options.find((m) => m === 'gpt-5.5')
      ?? options.find((m) => m === 'gpt-5.4')
      ?? options.find((m) => m === 'gpt-5')
      ?? options[0]
      ?? ''
  }
  if (providerId === 'google') {
    return options.find((m) => m === 'gemini-2.5-pro') ?? options[0] ?? ''
  }
  return options[0] ?? ''
}

export function normalizeModelForProviderAuth(
  providerId: string,
  authMode: AuthMode | 'host_only' | null | undefined,
  model: string | null | undefined,
  manifest: ProvidersManifest | null,
): string {
  const options = modelOptionsForProviderAuth(providerId, authMode, manifest)
  if (options.length === 0) return model ?? ''
  if (model && options.includes(model)) return model
  return preferredModelForProvider(providerId, options)
}
