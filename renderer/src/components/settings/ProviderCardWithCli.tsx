import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Check,
  Eye,
  EyeOff,
  Info,
  KeyRound,
  Loader2,
  Terminal,
  Trash2,
  X,
  Zap,
} from 'lucide-react'

/**
 * Phase 5a-finalize §3.5: provider card that supports BOTH api_key and
 * cli_subscription auth modes, generalizing the 5a-only
 * AnthropicProviderCard for Anthropic + OpenAI (Codex CLI) + future
 * subscription-bearing providers.
 *
 * Selection: ProvidersTab dispatches to this card iff the provider's
 * manifest entry includes a `cli_subscription` authMethod with a
 * `detectBinary` field. Providers with only `api_key` keep using the
 * simpler `ProviderCard.tsx`.
 *
 * Auto-detects credentials on mount via two parallel probes:
 *   - `hasApiKey(providerId)`: settings flag, no keyring touch
 *   - `detectBinary(cliBinaryName)`: augmented PATH lookup +
 *     `<bin> --version` (zero tokens, never invokes a model)
 *
 * Four states:
 *   neither       → install-guide + empty API key input
 *   api_only      → simple Phase 4 UI
 *   cli_only      → "Activate <Provider> CLI subscription" panel
 *   both          → radio toggle, currentMode pre-selected
 *
 * All copy is provider-agnostic: i18n strings interpolate `{{cliName}}`
 * (claude / codex) and `{{providerName}}` (Anthropic / OpenAI), so
 * adding a third subscription-capable provider is providers.json +
 * resolver only — no card edits needed.
 */

interface ProviderCardWithCliProps {
  /** UI provider id (matches providers.json key + keyring key). */
  providerId: string
  /** Display name for the card header (e.g. "Anthropic"). */
  displayName: string
  /** Binary name to probe via detect_binary (e.g. "claude", "codex"). */
  cliBinaryName: string
  /** Label for the cli_subscription authMethod (from manifest). */
  cliMethodLabel: string
  /**
   * Optional install URL — when provided, the `neither` state and
   * "binary missing" hints render a link to this URL. None: link
   * suppressed entirely.
   */
  cliInstallUrl?: string
  /** Whether an API key is stored (settings flag, not keyring). */
  hasKey: boolean
  /** Currently selected auth mode (reads from settings). */
  authMode: AuthMode
  /** Running in env-fallback mode. */
  envFallback: boolean
  /** Env var name for fallback mode (OCTOPAL_KEY_<PROVIDER>). */
  envVarName: string
  /** Called after a save/delete/flip so parent can refresh state. */
  onChanged: () => void
}

type Busy = 'save' | 'remove' | 'test' | 'flip' | null

export function ProviderCardWithCli({
  providerId,
  displayName,
  cliBinaryName,
  cliMethodLabel,
  cliInstallUrl,
  hasKey,
  authMode,
  envFallback,
  envVarName,
  onChanged,
}: ProviderCardWithCliProps) {
  const { t } = useTranslation()

  const [detection, setDetection] = useState<ClaudeDetection | null>(null)
  const [detecting, setDetecting] = useState(true)

  const [keyInput, setKeyInput] = useState('')
  const [reveal, setReveal] = useState(false)
  const [busy, setBusy] = useState<Busy>(null)
  const [error, setError] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<TestConnectionResult | null>(null)
  // Separate result for CLI mode — the binary `--version` probe gets a
  // dedicated banner distinct from the HTTP `/v1/models` probe.
  const [cliTestOk, setCliTestOk] = useState<boolean | null>(null)
  const [cliTestMessage, setCliTestMessage] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setDetecting(true)
      try {
        // Prefer the generic detect_binary (5a-finalize §3.2). Fall
        // back to detectClaude alias for Anthropic if detectBinary
        // isn't exposed (dev-build mismatches between Tauri command
        // registration and renderer expectations).
        let d: ClaudeDetection | null = null
        if (window.api.detectBinary) {
          d = await window.api.detectBinary(cliBinaryName)
        } else if (cliBinaryName === 'claude' && window.api.detectClaude) {
          d = await window.api.detectClaude()
        }
        if (!cancelled) setDetection(d)
      } catch {
        if (!cancelled) setDetection(null)
      } finally {
        if (!cancelled) setDetecting(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [cliBinaryName])

  useEffect(() => {
    setKeyInput('')
    setError(null)
    setTestResult(null)
    setCliTestOk(null)
    setCliTestMessage(null)
  }, [hasKey, authMode])

  // ── State derivation ─────────────────────────────────────────────
  const cliFound = detection?.found === true
  const cliAmbiguous = detection !== null && !detection.found && detection.path !== null

  // Effective mode: what the UI currently *shows*. When neither side is
  // configured this falls back to api_key so the keyless state reads
  // naturally ("empty API key input + 'Install CLI' alternative").
  // When both are available and settings say 'none', we default to
  // api_key too, preserving the Phase 4 muscle memory.
  const effectiveMode: AuthMode = useMemo(() => {
    if (authMode === 'cli_subscription') return 'cli_subscription'
    if (authMode === 'api_key') return 'api_key'
    return 'api_key'
  }, [authMode])

  const state: 'neither' | 'api_only' | 'cli_only' | 'both' = useMemo(() => {
    if (hasKey && cliFound) return 'both'
    if (hasKey) return 'api_only'
    if (cliFound) return 'cli_only'
    return 'neither'
  }, [hasKey, cliFound])

  // ── Actions ──────────────────────────────────────────────────────

  const save = useCallback(async () => {
    const value = keyInput.trim()
    if (!value) {
      setError(t('settings.providers.errors.emptyKey'))
      return
    }
    setBusy('save')
    setError(null)
    try {
      // saveApiKeyCmd flips configuredProviders[providerId] to ApiKey atomically.
      await window.api.saveApiKey?.(providerId, value)
      setKeyInput('')
      onChanged()
    } catch (e: any) {
      setError(e?.message ?? String(e))
    } finally {
      setBusy(null)
    }
  }, [keyInput, onChanged, providerId, t])

  const remove = useCallback(async () => {
    if (!confirm(t('settings.providers.confirmRemove', { name: displayName }))) return
    setBusy('remove')
    setError(null)
    try {
      await window.api.deleteApiKey?.(providerId)
      onChanged()
    } catch (e: any) {
      setError(e?.message ?? String(e))
    } finally {
      setBusy(null)
    }
  }, [displayName, onChanged, providerId, t])

  const activateCli = useCallback(async () => {
    setBusy('flip')
    setError(null)
    try {
      await window.api.setAuthMode?.(providerId, 'cli_subscription')
      onChanged()
    } catch (e: any) {
      setError(e?.message ?? String(e))
    } finally {
      setBusy(null)
    }
  }, [onChanged, providerId])

  const switchToApiKey = useCallback(async () => {
    setBusy('flip')
    setError(null)
    try {
      // hasKey is the invariant here — never switch to api_key when
      // no key is stored. Guard at the call site (the radio for api_key
      // is only selectable when hasKey is true; the simple ProviderCard
      // path covers the no-key case).
      await window.api.setAuthMode?.(providerId, 'api_key')
      onChanged()
    } catch (e: any) {
      setError(e?.message ?? String(e))
    } finally {
      setBusy(null)
    }
  }, [onChanged, providerId])

  const testConnection = useCallback(async () => {
    setBusy('test')
    setError(null)
    setTestResult(null)
    setCliTestOk(null)
    setCliTestMessage(null)

    try {
      if (effectiveMode === 'cli_subscription') {
        // Zero-token probe — same call shape as card mount, just
        // reshaped into a Test Connection banner. Scope §5.3
        // invariant: do NOT dispatch a real query here.
        let d: ClaudeDetection | null = null
        if (window.api.detectBinary) {
          d = await window.api.detectBinary(cliBinaryName)
        } else if (cliBinaryName === 'claude' && window.api.detectClaude) {
          d = await window.api.detectClaude()
        }
        setDetection(d)
        if (d?.found) {
          setCliTestOk(true)
          setCliTestMessage(t('settings.providers.cliTestOk', { cliName: cliBinaryName }))
        } else if (d?.path) {
          setCliTestOk(false)
          setCliTestMessage(
            t('settings.providers.cliTestAmbiguous', {
              cliName: cliBinaryName,
              path: d.path,
              error: d.error ?? '',
            }),
          )
        } else {
          setCliTestOk(false)
          setCliTestMessage(t('settings.providers.cliTestMissing', { cliName: cliBinaryName }))
        }
      } else {
        const result = await window.api.testProviderConnection?.(providerId)
        if (result) setTestResult(result)
      }
    } catch (e: any) {
      setError(e?.message ?? String(e))
    } finally {
      setBusy(null)
    }
  }, [cliBinaryName, effectiveMode, providerId, t])

  // ── Render ───────────────────────────────────────────────────────

  const statusLabel =
    authMode === 'none'
      ? t('settings.providers.notSet')
      : authMode === 'cli_subscription'
        ? t('settings.providers.activeCli', { cliName: cliBinaryName })
        : t('settings.providers.active')
  const statusActive = authMode !== 'none'

  return (
    <div className="provider-card">
      <header className="provider-card-header">
        <span className="provider-card-name">{displayName}</span>
        <span
          className={`provider-card-status ${statusActive ? 'active' : 'inactive'}`}
          aria-label={statusLabel}
        >
          <span className="provider-card-status-dot" />
          {statusLabel}
        </span>
      </header>

      {envFallback ? (
        <div className="provider-card-fallback">
          {t('settings.providers.fallbackHint', { envVar: envVarName })}
        </div>
      ) : (
        <div className="provider-card-body">
          {/* State-specific intro */}
          {detecting && (
            <div className="provider-card-hint">
              <Loader2 size={14} className="spin" />
              {t('settings.providers.cliDetecting', { cliName: cliBinaryName })}
            </div>
          )}

          {/* Mode picker — only in `both` state. */}
          {!detecting && state === 'both' && (
            <div className="provider-card-mode-picker" role="radiogroup">
              <label className="provider-card-mode-option">
                <input
                  type="radio"
                  name={`${providerId}-authmode`}
                  checked={effectiveMode === 'api_key'}
                  onChange={switchToApiKey}
                  disabled={busy !== null}
                />
                <KeyRound size={14} />
                <span>{t('settings.providers.modeApiKey')}</span>
              </label>
              <label className="provider-card-mode-option">
                <input
                  type="radio"
                  name={`${providerId}-authmode`}
                  checked={effectiveMode === 'cli_subscription'}
                  onChange={activateCli}
                  disabled={busy !== null}
                />
                <Terminal size={14} />
                <span>{cliMethodLabel}</span>
              </label>
            </div>
          )}

          {/* API key input — shown in api_only, neither, or both
              when api_key mode is selected. */}
          {!detecting &&
            (state === 'api_only' ||
              state === 'neither' ||
              (state === 'both' && effectiveMode === 'api_key')) && (
              <>
                <label className="provider-card-label">
                  {t('settings.providers.apiKey')}
                </label>
                <div className="provider-card-input-row">
                  <input
                    type={reveal ? 'text' : 'password'}
                    className="provider-card-input"
                    placeholder={
                      hasKey ? '••••••••••••••••' : t('settings.providers.keyPlaceholder')
                    }
                    value={keyInput}
                    onChange={(e) => {
                      setKeyInput(e.target.value)
                      setError(null)
                    }}
                    autoComplete="off"
                    spellCheck={false}
                    disabled={busy !== null}
                  />
                  <button
                    type="button"
                    className="provider-card-icon-btn"
                    onClick={() => setReveal((v) => !v)}
                    aria-label={
                      reveal
                        ? t('settings.providers.hide')
                        : t('settings.providers.reveal')
                    }
                    title={
                      reveal
                        ? t('settings.providers.hide')
                        : t('settings.providers.reveal')
                    }
                  >
                    {reveal ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </div>

                <div className="provider-card-actions">
                  <button
                    className="provider-card-btn primary"
                    onClick={save}
                    disabled={busy !== null || keyInput.trim().length === 0}
                  >
                    {busy === 'save' && <Loader2 size={14} className="spin" />}
                    {hasKey
                      ? t('settings.providers.replaceKey')
                      : t('settings.providers.saveKey')}
                  </button>
                  {hasKey && effectiveMode === 'api_key' && (
                    <>
                      <button
                        className="provider-card-btn"
                        onClick={testConnection}
                        disabled={busy !== null}
                      >
                        {busy === 'test' ? (
                          <Loader2 size={14} className="spin" />
                        ) : (
                          <Zap size={14} />
                        )}
                        {t('settings.providers.testConnection')}
                      </button>
                      <button
                        className="provider-card-btn danger"
                        onClick={remove}
                        disabled={busy !== null}
                      >
                        {busy === 'remove' ? (
                          <Loader2 size={14} className="spin" />
                        ) : (
                          <Trash2 size={14} />
                        )}
                        {t('settings.providers.remove')}
                      </button>
                    </>
                  )}
                </div>
              </>
            )}

          {/* CLI subscription panel — shown in cli_only, or both when
              cli_subscription mode is selected. */}
          {!detecting &&
            (state === 'cli_only' ||
              (state === 'both' && effectiveMode === 'cli_subscription')) && (
              <div className="provider-card-cli-panel">
                <div className="provider-card-cli-header">
                  <Terminal size={14} />
                  <span>{cliMethodLabel}</span>
                </div>
                <p className="provider-card-cli-desc">
                  {cliAmbiguous
                    ? t('settings.providers.cliAmbiguous', {
                        cliName: cliBinaryName,
                        path: detection?.path ?? '',
                      })
                    : detection?.version
                      ? t('settings.providers.cliReadyWithVersion', {
                          cliName: cliBinaryName,
                          version: detection.version,
                        })
                      : t('settings.providers.cliReady', { cliName: cliBinaryName })}
                </p>
                <div className="provider-card-actions">
                  {/* In cli_only state, show Activate iff we're not
                      already in cli_subscription mode. In `both` state
                      the radio already switched us in. */}
                  {state === 'cli_only' && authMode !== 'cli_subscription' && (
                    <button
                      className="provider-card-btn primary"
                      onClick={activateCli}
                      disabled={busy !== null || !cliFound}
                    >
                      {busy === 'flip' && <Loader2 size={14} className="spin" />}
                      {t('settings.providers.activateCli', { cliName: cliBinaryName })}
                    </button>
                  )}
                  {authMode === 'cli_subscription' && (
                    <button
                      className="provider-card-btn"
                      onClick={testConnection}
                      disabled={busy !== null}
                    >
                      {busy === 'test' ? (
                        <Loader2 size={14} className="spin" />
                      ) : (
                        <Zap size={14} />
                      )}
                      {t('settings.providers.testConnection')}
                    </button>
                  )}
                </div>
              </div>
            )}

          {/* Neither state — install-guide alongside API key input. */}
          {!detecting && state === 'neither' && (
            <div className="provider-card-hint">
              <Info size={14} />
              <span>
                {t('settings.providers.neitherHint', { providerName: displayName })}{' '}
                {cliInstallUrl && (
                  <a
                    href={cliInstallUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    {t('settings.providers.cliInstallLink', { cliName: cliBinaryName })}
                  </a>
                )}
                {cliInstallUrl ? '.' : ''}
              </span>
            </div>
          )}

          {/* Test results */}
          {testResult && (
            <div
              className={`provider-card-test ${testResult.ok ? 'ok' : 'fail'}`}
              role="status"
            >
              {testResult.ok ? <Check size={14} /> : <X size={14} />}
              {testResult.ok
                ? t('settings.providers.testOk', { ms: testResult.latency_ms })
                : t('settings.providers.testFail', {
                    error: testResult.error ?? `HTTP ${testResult.status ?? '?'}`,
                  })}
            </div>
          )}
          {cliTestOk !== null && (
            <div
              className={`provider-card-test ${cliTestOk ? 'ok' : 'fail'}`}
              role="status"
            >
              {cliTestOk ? <Check size={14} /> : <X size={14} />}
              {cliTestMessage}
            </div>
          )}

          {error && <div className="provider-card-error">{error}</div>}
        </div>
      )}
    </div>
  )
}
