import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Info, KeyRound, Loader2 } from 'lucide-react'
import { ProviderCard } from './ProviderCard'

/**
 * Settings → Providers tab (Phase 4, scope §3.4).
 *
 * Three sections:
 *   1. Status banner — keyring / env_fallback / unavailable
 *   2. Defaults — default provider, default model, planner model
 *   3. Per-provider cards — configured state + save/test/remove
 *
 * This component owns:
 *   - Local mirror of ProvidersSettings (propagated to parent via onChange)
 *   - Providers manifest (fetched once on mount)
 *   - Keyring status (fetched once; stable per session)
 *   - configured_providers map synced from hasApiKey() on mount + after
 *     each save/remove to avoid stale UI state.
 */

interface ProvidersTabProps {
  /**
   * Full AppSettings.providers slice. The tab mutates its own keys and
   * calls `onChange` with the merged delta; the parent (SettingsPanel)
   * is responsible for marking the form dirty + persisting on save.
   */
  providers: NonNullable<AppSettings['providers']>
  onChange: (patch: Partial<NonNullable<AppSettings['providers']>>) => void
}

export function ProvidersTab({ providers, onChange }: ProvidersTabProps) {
  const { t } = useTranslation()
  const [manifest, setManifest] = useState<ProvidersManifest | null>(null)
  const [status, setStatus] = useState<KeyringStatus | null>(null)
  const [loading, setLoading] = useState(true)

  // Local configured_providers mirror — source of truth is the settings
  // flag returned by hasApiKey(). We don't trust `providers.configuredProviders`
  // directly because it could be stale after an out-of-band keyring change.
  const [configured, setConfigured] = useState<Record<string, boolean>>({})

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const [m, s] = await Promise.all([
          window.api.getProvidersManifest?.() ?? Promise.resolve(null),
          window.api.keyringStatus?.() ?? Promise.resolve(null),
        ])
        if (cancelled) return
        setManifest(m)
        setStatus(s)
        if (m) {
          // Probe each provider in parallel — hasApiKey just reads a
          // settings flag (cheap, no Keychain prompt per scope §3.2).
          const entries = await Promise.all(
            Object.keys(m).map(async (pid) => {
              const has = (await window.api.hasApiKey?.(pid)) ?? false
              return [pid, has] as const
            }),
          )
          if (cancelled) return
          setConfigured(Object.fromEntries(entries))
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const refreshConfigured = useCallback(
    async (provider: string) => {
      const has = (await window.api.hasApiKey?.(provider)) ?? false
      setConfigured((prev) => ({ ...prev, [provider]: has }))
      // Also mirror into the parent's providers.configuredProviders so
      // the AppSettings save cycle carries the truthful flag. (The Rust
      // save_api_key_cmd already flipped the persisted flag; this keeps
      // the form's local state in sync.)
      onChange({
        configuredProviders: {
          ...(providers.configuredProviders ?? {}),
          [provider]: has,
        },
      })
    },
    [providers.configuredProviders, onChange],
  )

  // Merge available-model list per ADR §6.8a: Octopal curated
  // (providers.json) ∪ Goose catalog (deferred — Phase 5) ∪ custom.
  // Phase 3+4 keeps it simple — static list from manifest + aliases.
  const availableModelsFor = useCallback(
    (providerId: string): string[] => {
      if (!manifest) return []
      const entry = manifest[providerId]
      if (!entry) return []
      const baseList = Array.isArray(entry.models) ? entry.models : []
      // For anthropic, expose alias sentinels at the top — resolved on
      // Rust side via commands::model_alias (§2.3).
      if (providerId === 'anthropic') {
        return ['opus', 'sonnet', 'haiku', ...baseList]
      }
      return baseList
    },
    [manifest],
  )

  const defaultModelOptions = useMemo(
    () => availableModelsFor(providers.defaultProvider ?? 'anthropic'),
    [availableModelsFor, providers.defaultProvider],
  )

  if (loading) {
    return (
      <div className="settings-section">
        <h3 className="settings-section-title">{t('settings.providers.title')}</h3>
        <div style={{ opacity: 0.6 }}>
          <Loader2 size={14} className="spin" style={{ marginRight: 6, verticalAlign: 'middle' }} />
          {t('common.loading')}
        </div>
      </div>
    )
  }

  if (!manifest) {
    return (
      <div className="settings-section">
        <h3 className="settings-section-title">{t('settings.providers.title')}</h3>
        <p className="settings-section-desc">
          {t('settings.providers.manifestUnavailable')}
        </p>
      </div>
    )
  }

  return (
    <div className="settings-section">
      <h3 className="settings-section-title">
        <KeyRound size={16} style={{ marginRight: 6, verticalAlign: 'text-bottom' }} />
        {t('settings.providers.title')}
      </h3>
      <p className="settings-section-desc">{t('settings.providers.desc')}</p>

      {/* Status banner */}
      {status && (
        <div
          className={`providers-status-banner ${status.backend === 'env_fallback' ? 'warn' : status.available ? 'info' : 'error'}`}
        >
          {status.backend === 'env_fallback' ? (
            <AlertTriangle size={14} />
          ) : status.available ? (
            <Info size={14} />
          ) : (
            <AlertTriangle size={14} />
          )}
          <span>
            {status.backend === 'env_fallback'
              ? t('settings.providers.statusEnvFallback', { envVar: status.fallback_env_var })
              : status.available
                ? t('settings.providers.statusKeyring')
                : t('settings.providers.statusUnavailable')}
          </span>
        </div>
      )}

      {/* Defaults */}
      <h4 className="settings-section-title" style={{ marginTop: 20, fontSize: 14 }}>
        {t('settings.providers.defaultsTitle')}
      </h4>
      <div className="settings-field">
        <span className="settings-toggle-info">
          <span className="settings-label">{t('settings.providers.defaultProvider')}</span>
          <span className="settings-desc">{t('settings.providers.defaultProviderDesc')}</span>
        </span>
        <select
          className="settings-select"
          value={providers.defaultProvider ?? 'anthropic'}
          onChange={(e) => onChange({ defaultProvider: e.target.value })}
        >
          {Object.entries(manifest).map(([pid, entry]) => (
            <option key={pid} value={pid}>
              {entry.displayName}
            </option>
          ))}
        </select>
      </div>

      <div className="settings-field">
        <span className="settings-toggle-info">
          <span className="settings-label">{t('settings.providers.defaultModel')}</span>
          <span className="settings-desc">{t('settings.providers.defaultModelDesc')}</span>
        </span>
        <select
          className="settings-select"
          value={providers.defaultModel ?? 'claude-sonnet-4-6'}
          onChange={(e) => onChange({ defaultModel: e.target.value })}
        >
          {defaultModelOptions.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </div>

      <div className="settings-field">
        <span className="settings-toggle-info">
          <span className="settings-label">{t('settings.providers.plannerModel')}</span>
          <span className="settings-desc">{t('settings.providers.plannerModelDesc')}</span>
        </span>
        <select
          className="settings-select"
          value={providers.plannerModel ?? 'claude-haiku-4-5-20251001'}
          onChange={(e) => onChange({ plannerModel: e.target.value })}
        >
          {availableModelsFor('anthropic').map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </div>

      {/* Per-provider cards */}
      <h4 className="settings-section-title" style={{ marginTop: 20, fontSize: 14 }}>
        {t('settings.providers.keysTitle')}
      </h4>
      <div className="provider-card-grid">
        {Object.entries(manifest).map(([pid, entry]) => {
          const primaryAuth = entry.authMethods[0]
          if (!primaryAuth) return null
          const envVarName = `OCTOPAL_KEY_${pid.toUpperCase()}`
          const isHostOnly = primaryAuth.id === 'host_only'
          return (
            <ProviderCard
              key={pid}
              providerId={pid}
              displayName={entry.displayName}
              hasKey={configured[pid] ?? false}
              envFallback={status?.backend === 'env_fallback'}
              envVarName={envVarName}
              keyLabel={
                isHostOnly
                  ? t('settings.providers.hostUrl')
                  : t('settings.providers.apiKey')
              }
              authMethodId={primaryAuth.id}
              onSaved={() => refreshConfigured(pid)}
              onRemoved={() => refreshConfigured(pid)}
            />
          )
        })}
      </div>
    </div>
  )
}
