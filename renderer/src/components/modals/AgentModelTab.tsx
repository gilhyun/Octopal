import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

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
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const m =
          (await window.api.getProvidersManifest?.()) ?? null
        if (!cancelled) setManifest(m)
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

  // For Anthropic, prepend the alias sentinels so users can pick
  // "opus"/"sonnet"/"haiku" alongside concrete IDs (mirrors the
  // Settings → Providers default-model dropdown).
  const modelOptions = useMemo<string[]>(() => {
    if (!manifest || !provider) return []
    const entry = manifest[provider]
    if (!entry) return []
    const baseList = Array.isArray(entry.models) ? entry.models : []
    if (provider === 'anthropic') {
      return ['opus', 'sonnet', 'haiku', ...baseList]
    }
    return baseList
  }, [manifest, provider])

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
                // Inherit the workspace default — clear both the
                // provider AND the model since the model probably
                // doesn't make sense for the new (default) provider.
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
            // Disable the model checkbox when provider is inheriting —
            // can't pin a model without first pinning a provider.
            disabled={providerInherits}
            onChange={(e) => {
              if (e.target.checked) {
                onModelChange(undefined)
              } else {
                // Pre-select the first option so the dropdown isn't
                // visually empty after re-enabling.
                onModelChange(modelOptions[0] ?? '')
              }
            }}
          />
          <span>{t('modals.agentModel.useWorkspaceDefault')}</span>
        </label>
      </div>
      <select
        className="modal-input"
        value={model ?? ''}
        disabled={modelInherits || providerInherits}
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
            model: model ?? t('modals.agentModel.workspaceDefault'),
          })}
        </div>
      )}
    </>
  )
}
