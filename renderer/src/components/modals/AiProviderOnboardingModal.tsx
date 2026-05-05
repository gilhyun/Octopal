import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, KeyRound, Loader2, Terminal } from 'lucide-react'
import { cliDisplayName, cliVersionLabel } from '../../cli-display'
import { modelOptionsForProviderAuth, preferredModelForProvider } from '../../provider-models'

interface AiProviderOnboardingModalProps {
  onComplete: () => void
}

export function AiProviderOnboardingModal({ onComplete }: AiProviderOnboardingModalProps) {
  const { t } = useTranslation()
  const [manifest, setManifest] = useState<ProvidersManifest | null>(null)
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [selectedProvider, setSelectedProvider] = useState('anthropic')
  const [selectedModel, setSelectedModel] = useState('')
  const [customModel, setCustomModel] = useState('')
  const [authMethod, setAuthMethod] = useState<'api_key' | 'cli_subscription' | 'host_only'>('api_key')
  const [secret, setSecret] = useState('')
  const [cliDetection, setCliDetection] = useState<ClaudeDetection | null>(null)
  const [checkingCli, setCheckingCli] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const [m, s] = await Promise.all([
        window.api.getProvidersManifest?.() ?? Promise.resolve(null),
        window.api.loadSettings(),
      ])
      if (cancelled) return
      setManifest(m)
      setSettings(s)
      const initialProvider = s.providers?.defaultProvider ?? 'anthropic'
      setSelectedProvider(m?.[initialProvider] ? initialProvider : Object.keys(m ?? {})[0] ?? 'anthropic')
    })().catch((e) => {
      if (!cancelled) setError(e?.message ?? String(e))
    })
    return () => {
      cancelled = true
    }
  }, [])

  const providerEntry = manifest?.[selectedProvider]
  const cliMethod = providerEntry?.authMethods.find((m) => m.id === 'cli_subscription' && m.detectBinary)
  const cliCommand = cliMethod?.detectBinary ?? ''
  const cliName = cliDisplayName(cliCommand)
  const cliVersion = cliVersionLabel(cliCommand, cliDetection?.version)
  const primaryMethod = providerEntry?.authMethods[0]
  const isHostOnly = primaryMethod?.id === 'host_only'
  const modelOptions = useMemo(
    () => modelOptionsForProviderAuth(selectedProvider, authMethod, manifest),
    [authMethod, manifest, selectedProvider],
  )
  const effectiveModel = modelOptions.length > 0 ? selectedModel : customModel.trim()
  const cliPanelState = checkingCli
    ? 'checking'
    : cliDetection?.found
      ? 'ready'
      : 'missing'

  useEffect(() => {
    if (!manifest || !providerEntry) return
    const nextAuthMethod = isHostOnly ? 'host_only' : 'api_key'
    const options = modelOptionsForProviderAuth(selectedProvider, nextAuthMethod, manifest)
    setSelectedModel(preferredModelForProvider(selectedProvider, options))
    setCustomModel('')
    setSecret(isHostOnly ? 'http://localhost:11434' : '')
    setAuthMethod(nextAuthMethod)
    setCliDetection(null)
    setError(null)
  }, [manifest, providerEntry, selectedProvider, isHostOnly])

  useEffect(() => {
    if (!manifest || !modelOptions.length) return
    if (modelOptions.includes(selectedModel)) return
    setSelectedModel(preferredModelForProvider(selectedProvider, modelOptions))
  }, [manifest, modelOptions, selectedModel, selectedProvider])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      if (!cliMethod?.detectBinary) return
      setCheckingCli(true)
      try {
        const detection = await window.api.detectBinary?.(cliMethod.detectBinary)
        if (!cancelled) setCliDetection(detection ?? null)
      } catch {
        if (!cancelled) setCliDetection(null)
      } finally {
        if (!cancelled) setCheckingCli(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [cliMethod?.detectBinary])

  const recheckCli = async () => {
    if (!cliMethod?.detectBinary) return
    setCheckingCli(true)
    setError(null)
    try {
      setCliDetection(await window.api.detectBinary?.(cliMethod.detectBinary) ?? null)
    } catch (e: any) {
      setError(e?.message ?? String(e))
    } finally {
      setCheckingCli(false)
    }
  }

  const complete = async () => {
    if (!settings || !manifest || !providerEntry) return
    setBusy(true)
    setError(null)
    try {
      if (authMethod === 'cli_subscription') {
        if (!cliMethod?.detectBinary || cliDetection?.found !== true) {
          throw new Error(t('modals.aiOnboarding.cliMissingError'))
        }
        if (selectedProvider === 'openai') {
          await window.api.preflightCliSubscription?.(selectedProvider)
        }
        await window.api.setAuthMode?.(selectedProvider, 'cli_subscription')
      } else {
        const value = secret.trim()
        if (!value) throw new Error(t('settings.providers.errors.emptyKey'))
        await window.api.saveApiKey?.(selectedProvider, value)
      }

      const configuredMode: AuthMode = authMethod === 'cli_subscription'
        ? 'cli_subscription'
        : 'api_key'
      const providers = {
        useLegacyClaudeCli: false,
        defaultProvider: selectedProvider,
        defaultModel: effectiveModel,
        plannerModel: settings.providers?.plannerModel ?? 'claude-haiku-4-5-20251001',
        configuredProviders: {
          ...(settings.providers?.configuredProviders ?? {}),
          [selectedProvider]: configuredMode,
        },
      }
      await window.api.saveSettings({
        ...settings,
        providers,
      })
      onComplete()
    } catch (e: any) {
      setError(e?.message ?? String(e))
    } finally {
      setBusy(false)
    }
  }

  if (!manifest || !settings) {
    return (
      <div className="modal-backdrop modal-backdrop--blocking">
        <div className="modal">
          <div className="modal-title">{t('modals.aiOnboarding.title')}</div>
          {error ? (
            <div className="provider-card-error">{error}</div>
          ) : (
            <div style={{ opacity: 0.7 }}>
              <Loader2 size={14} className="spin" style={{ marginRight: 6, verticalAlign: 'middle' }} />
              {t('common.loading')}
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="modal-backdrop modal-backdrop--blocking">
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">{t('modals.aiOnboarding.title')}</div>
        <div className="modal-hint" style={{ marginTop: -4 }}>
          {t('modals.aiOnboarding.desc')}
        </div>

        <label className="modal-label">{t('modals.aiOnboarding.provider')}</label>
        <select
          className="modal-input"
          value={selectedProvider}
          onChange={(e) => setSelectedProvider(e.target.value)}
          disabled={busy}
        >
          {Object.entries(manifest).map(([id, entry]) => (
            <option key={id} value={id}>{entry.displayName}</option>
          ))}
        </select>

        <label className="modal-label">{t('modals.aiOnboarding.model')}</label>
        {modelOptions.length > 0 ? (
          <select
            className="modal-input"
            value={selectedModel}
            onChange={(e) => setSelectedModel(e.target.value)}
            disabled={busy}
          >
            {modelOptions.map((model) => (
              <option key={model} value={model}>{model}</option>
            ))}
          </select>
        ) : (
          <input
            className="modal-input"
            value={customModel}
            onChange={(e) => setCustomModel(e.target.value)}
            placeholder={t('modals.aiOnboarding.localModelPlaceholder')}
            disabled={busy}
          />
        )}

        <label className="modal-label">{t('modals.aiOnboarding.authMethod')}</label>
        <div className="provider-card-mode-picker" role="radiogroup">
          {!isHostOnly && (
            <label className="provider-card-mode-option">
              <input
                type="radio"
                checked={authMethod === 'api_key'}
                onChange={() => setAuthMethod('api_key')}
                disabled={busy}
              />
              <KeyRound size={14} />
              <span>{t('settings.providers.modeApiKey')}</span>
            </label>
          )}
          {isHostOnly && (
            <label className="provider-card-mode-option">
              <input
                type="radio"
                checked={authMethod === 'host_only'}
                onChange={() => setAuthMethod('host_only')}
                disabled={busy}
              />
              <KeyRound size={14} />
              <span>{t('settings.providers.hostUrl')}</span>
            </label>
          )}
          {cliMethod?.detectBinary && (
            <label
              className={`provider-card-mode-option ${
                authMethod === 'cli_subscription' && cliDetection?.found ? 'is-ready' : ''
              }`}
            >
              <input
                type="radio"
                checked={authMethod === 'cli_subscription'}
                onChange={() => setAuthMethod('cli_subscription')}
                disabled={busy}
              />
              <Terminal size={14} />
              <span>{cliMethod.label}</span>
            </label>
          )}
        </div>

        {authMethod === 'cli_subscription' ? (
          <div className={`provider-card-cli-panel ${cliPanelState}`} style={{ marginTop: 12 }}>
            <div className="provider-card-cli-header">
              <Terminal size={16} />
              <strong>{cliName}</strong>
            </div>
            <p className="provider-card-cli-desc">
              {checkingCli
                ? t('settings.providers.cliDetecting', { cliName })
                : cliDetection?.found
                  ? t('settings.providers.cliReadyWithVersion', {
                      cliName,
                      version: cliVersion,
                    })
                  : t('settings.providers.cliTestMissing', {
                      cliName,
                      cliCommand,
                    })}
            </p>
            <div className="provider-card-actions">
              {cliMethod?.installUrl && cliDetection?.found !== true && (
                <a className="provider-card-btn" href={cliMethod.installUrl} target="_blank" rel="noreferrer">
                  {t('settings.providers.cliInstallLink', { cliName })}
                </a>
              )}
              <button className="provider-card-btn" onClick={recheckCli} disabled={busy || checkingCli}>
                {checkingCli ? <Loader2 size={14} className="spin" /> : null}
                {t('mcpValidation.recheck')}
              </button>
            </div>
          </div>
        ) : (
          <>
            <label className="modal-label">
              {authMethod === 'host_only'
                ? t('settings.providers.hostUrl')
                : t('settings.providers.apiKey')}
            </label>
            <input
              className="modal-input"
              type={authMethod === 'host_only' ? 'text' : 'password'}
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder={authMethod === 'host_only'
                ? t('modals.aiOnboarding.hostPlaceholder')
                : t('settings.providers.keyPlaceholder')}
              autoComplete="off"
              spellCheck={false}
              disabled={busy}
            />
          </>
        )}

        {error && <div className="provider-card-error" style={{ marginTop: 12 }}>{error}</div>}

        <div className="modal-actions">
          <button
            className="btn-primary"
            onClick={complete}
            disabled={
              busy
              || !effectiveModel
              || (authMethod === 'cli_subscription' && cliDetection?.found !== true)
              || (authMethod !== 'cli_subscription' && secret.trim().length === 0)
            }
          >
            {busy ? <Loader2 size={14} className="spin" /> : <Check size={14} />}
            {t('modals.aiOnboarding.continue')}
          </button>
        </div>
      </div>
    </div>
  )
}
