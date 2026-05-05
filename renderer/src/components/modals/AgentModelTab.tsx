import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { modelOptionsForProviderAuth, preferredModelForProvider } from '../../provider-models'

/**
 * Phase 6 §5.1 — Model tab body shared by EditAgentModal and
 * CreateAgentModal.
 *
 * Renders provider + model selectors with cascading semantics:
 * picking a provider repopulates the model dropdown from
 * `providers.json::models`. Each selector has a "Use workspace
 * default" checkbox that disables the corresponding dropdown and
 * clears the local override (saved as undefined → omitted from
 * config.json → resolved by Rust at turn time).
 *
 * Two-way binding via callbacks rather than a controlled-form
 * abstraction so the parent modals can drive their own save logic.
 *
 * State machine:
 *
 *   provider:
 *     "" + checked-default   → field omitted (legacy / inheriting)
 *     "<id>" + unchecked     → override active
 *     "<id>" + checked       → can't happen (checkbox clears the value)
 *
 *   model: same pattern.
 *
 * On provider change, model is reset to "" (cascading invalidation):
 * the previously-selected model probably belongs to the old provider's
 * list. UI prompts the user to pick a new model from the new
 * provider's catalog.
 */
interface AgentModelTabProps {
  /**
   * Current provider override. `undefined` ⇒ inherit workspace default;
   * non-empty string ⇒ explicit override.
   */
  provider: string | undefined
  /**
   * Current model override. Same convention as `provider`.
   */
  model: string | undefined
  /** Notifies parent of changes — empty string means "remove override". */
  onProviderChange: (next: string | undefined) => void
  onModelChange: (next: string | undefined) => void
}

export function AgentModelTab({
  provider,
  model,
  onProviderChange,
  onModelChange,
}: AgentModelTabProps) {
  const { t } = useTranslation()

  const [manifest, setManifest] = useState<ProvidersManifest | null>(null)
  const [workspaceDefaultProvider, setWorkspaceDefaultProvider] = useState('anthropic')
  const [authModes, setAuthModes] = useState<Record<string, AuthMode>>({})
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const [m, settings] = await Promise.all([
          window.api.getProvidersManifest?.() ?? Promise.resolve(null),
          window.api.loadSettings().catch(() => null),
        ])
        const modes = m
          ? Object.fromEntries(await Promise.all(
            Object.keys(m).map(async (pid) => {
              const mode = await (
                window.api.getAuthMode?.(pid)
                ?? Promise.resolve(settings?.providers?.configuredProviders?.[pid] ?? 'none')
              )
              return [pid, mode] as const
            }),
          ))
          : {}
        if (!cancelled) {
          setManifest(m)
          setWorkspaceDefaultProvider(settings?.providers?.defaultProvider ?? 'anthropic')
          setAuthModes(modes)
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const providerInherits = !provider
  const modelInherits = !model
  const effectiveProvider = provider ?? workspaceDefaultProvider

  const modelOptions = useMemo<string[]>(() => {
    return modelOptionsForProviderAuth(effectiveProvider, authModes[effectiveProvider], manifest)
  }, [authModes, effectiveProvider, manifest])

  useEffect(() => {
    if (modelInherits || !model || !modelOptions.length) return
    if (modelOptions.includes(model)) return
    onModelChange(preferredModelForProvider(effectiveProvider, modelOptions))
  }, [effectiveProvider, model, modelInherits, modelOptions, onModelChange])

  if (loading) {
    return (
      <div className="modal-hint" style={{ marginTop: 0 }}>
        {t('common.loading')}
      </div>
    )
  }

  if (!manifest) {
    return (
      <div className="modal-error">
        {t('settings.providers.manifestUnavailable')}
      </div>
    )
  }

  return (
    <>
      <label className="modal-label" style={{ marginTop: 0 }}>
        {t('modals.agentModel.title')}
      </label>
      <div className="modal-hint" style={{ marginTop: 0 }}>
        {t('modals.agentModel.hint')}
      </div>

      {/* Provider */}
      <div className="modal-field-row">
        <label className="modal-label">
          {t('modals.agentModel.provider')}
        </label>
        <label className="perm-toggle perm-toggle--inline">
          <input
            type="checkbox"
            checked={providerInherits}
            onChange={(e) => {
              if (e.target.checked) {
                // Inherit the workspace default — clear both the provider
                // AND the model because the current model may belong to the
                // previously selected provider's catalog.
                onProviderChange(undefined)
                onModelChange(undefined)
              } else {
                // Pick a sensible first provider. UI re-renders with
                // the dropdown enabled; user can change.
                const first = Object.keys(manifest)[0] ?? 'anthropic'
                onProviderChange(first)
              }
            }}
          />
          <span>{t('modals.agentModel.useWorkspaceDefault')}</span>
        </label>
      </div>
      <select
        className="modal-input"
        value={provider ?? ''}
        disabled={providerInherits}
        onChange={(e) => {
          const next = e.target.value
          onProviderChange(next || undefined)
          // Cascading invalidation: previously selected model belongs
          // to the *old* provider's list and is likely meaningless
          // here. Clear it so the user has to re-pick from the new
          // catalog (or check "Use workspace default" for the model).
          onModelChange(undefined)
        }}
      >
        {Object.entries(manifest).map(([pid, entry]) => (
          <option key={pid} value={pid}>
            {entry.displayName}
          </option>
        ))}
      </select>

      {/* Model */}
      <div className="modal-field-row" style={{ marginTop: 16 }}>
        <label className="modal-label">{t('modals.agentModel.model')}</label>
        <label className="perm-toggle perm-toggle--inline">
          <input
            type="checkbox"
            checked={modelInherits}
            onChange={(e) => {
              if (e.target.checked) {
                onModelChange(undefined)
              } else {
                // Pre-select a safe provider-local default so the dropdown
                // isn't visually empty after re-enabling.
                onModelChange(preferredModelForProvider(effectiveProvider, modelOptions))
              }
            }}
          />
          <span>
            {provider
              ? t('modals.agentModel.useProviderDefault')
              : t('modals.agentModel.useWorkspaceDefault')}
          </span>
        </label>
      </div>
      <select
        className="modal-input"
        value={model ?? ''}
        disabled={modelInherits}
        onChange={(e) =>
          onModelChange(e.target.value || undefined)
        }
      >
        {modelOptions.map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
      </select>

      {/* Effective binding hint */}
      {(provider || model) && (
        <div className="modal-hint" style={{ marginTop: 16 }}>
          {t('modals.agentModel.effectiveHint', {
            provider: provider ?? t('modals.agentModel.workspaceDefault'),
            model: model ?? (provider
              ? t('modals.agentModel.providerDefault')
              : t('modals.agentModel.workspaceDefault')),
          })}
        </div>
      )}
    </>
  )
}
