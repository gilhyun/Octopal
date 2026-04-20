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
 * Anthropic-specific card with the Phase 5a four-state flow.
 *
 * Auto-detects the user's credentials on mount via two parallel probes:
 *   - `hasApiKey('anthropic')`: reads settings flag (no keyring touch)
 *   - `detectClaude()`: PATH lookup + `claude --version` (no token cost)
 *
 * Four states:
 *   neither       → install-guide + empty API key input
 *   api_key_only  → Phase 4 UI
 *   cli_only      → "Activate CLI subscription" banner
 *   detected_both → radio toggle, currentMode pre-selected
 *
 * The card is Anthropic-only because (a) Phase 5a only restores the
 * cli_subscription authMethod on Anthropic (scope §3) and (b) Goose
 * v1.31.0 has no comparable provider for the other card's providers.
 * Generic providers keep using `ProviderCard.tsx`.
 */

interface AnthropicProviderCardProps {
  displayName: string
  /** Whether an API key is stored (settings flag, not keyring). */
  hasKey: boolean
  /** Currently selected auth mode (reads from settings). */
  authMode: AuthMode
  /** Running in env-fallback mode. */
  envFallback: boolean
  /** Env var name for fallback mode (OCTOPAL_KEY_ANTHROPIC). */
  envVarName: string
  /** Called after a save/delete/flip so parent can refresh state. */
  onChanged: () => void
}

type Busy = 'save' | 'remove' | 'test' | 'flip' | null

export function AnthropicProviderCard({
  displayName,
  hasKey,
  authMode,
  envFallback,
  envVarName,
  onChanged,
}: AnthropicProviderCardProps) {
  const { t } = useTranslation()

  const [detection, setDetection] = useState<ClaudeDetection | null>(null)
  const [detecting, setDetecting] = useState(true)

  const [keyInput, setKeyInput] = useState('')
  const [reveal, setReveal] = useState(false)
  const [busy, setBusy] = useState<Busy>(null)
  const [error, setError] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<TestConnectionResult | null>(null)
  // Separate result for CLI mode — `detectClaude` reshapes into a
  // "Claude CLI responds" banner, distinct from the HTTP /models probe.
  const [cliTestOk, setCliTestOk] = useState<boolean | null>(null)
  const [cliTestMessage, setCliTestMessage] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setDetecting(true)
      try {
        const d = (await window.api.detectClaude?.()) ?? null
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
  }, [])

  useEffect(() => {
    setKeyInput('')
    setError(null)
    setTestResult(null)
    setCliTestOk(null)
    setCliTestMessage(null)
  }, [hasKey, authMode])

  // ── State derivation ─────────────────────────────────────────────
  const claudeFound = detection?.found === true
  const claudeAmbiguous = detection !== null && !detection.found && detection.path !== null

  // Effective mode: what the UI currently *shows*. When neither side is
  // configured this falls back to api_key so the keyless state reads
  // naturally ("empty API key input + 'Install CLI' alternative").
  // When both are available and settings say 'none', we default to
  // api_key too, since that's the existing Phase 4 muscle memory.
  const effectiveMode: AuthMode = useMemo(() => {
    if (authMode === 'cli_subscription') return 'cli_subscription'
    if (authMode === 'api_key') return 'api_key'
    return 'api_key'
  }, [authMode])

  const state: 'neither' | 'api_only' | 'cli_only' | 'both' = useMemo(() => {
    if (hasKey && claudeFound) return 'both'
    if (hasKey) return 'api_only'
    if (claudeFound) return 'cli_only'
    return 'neither'
  }, [hasKey, claudeFound])

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
      // saveApiKeyCmd already flips configuredProviders['anthropic'] to ApiKey.
      await window.api.saveApiKey?.('anthropic', value)
      setKeyInput('')
      onChanged()
    } catch (e: any) {
      setError(e?.message ?? String(e))
    } finally {
      setBusy(null)
    }
  }, [keyInput, onChanged, t])

  const remove = useCallback(async () => {
    if (!confirm(t('settings.providers.confirmRemove', { name: displayName }))) return
    setBusy('remove')
    setError(null)
    try {
      await window.api.deleteApiKey?.('anthropic')
      onChanged()
    } catch (e: any) {
      setError(e?.message ?? String(e))
    } finally {
      setBusy(null)
    }
  }, [displayName, onChanged, t])

  const activateCli = useCallback(async () => {
    setBusy('flip')
    setError(null)
    try {
      await window.api.setAuthMode?.('anthropic', 'cli_subscription')
      onChanged()
    } catch (e: any) {
      setError(e?.message ?? String(e))
    } finally {
      setBusy(null)
    }
  }, [onChanged])

  const switchToApiKey = useCallback(async () => {
    setBusy('flip')
    setError(null)
    try {
      // hasKey is the invariant here — we never switch to api_key when
      // no key is stored. If the stored-key flag is out of sync we'd
      // land in a broken state where sends fail; guard at call site.
      await window.api.setAuthMode?.('anthropic', 'api_key')
      onChanged()
    } catch (e: any) {
      setError(e?.message ?? String(e))
    } finally {
      setBusy(null)
    }
  }, [onChanged])

  const testConnection = useCallback(async () => {
    setBusy('test')
    setError(null)
    setTestResult(null)
    setCliTestOk(null)
    setCliTestMessage(null)

    try {
      if (effectiveMode === 'cli_subscription') {
        // Zero-token probe — same call as card mount, just shaped into
        // a Test Connection banner. Scope §5.3: do NOT dispatch a real
        // query here.
        const d = (await window.api.detectClaude?.()) ?? null
        setDetection(d)
        if (d?.found) {
          setCliTestOk(true)
          setCliTestMessage(t('settings.providers.cliTestOk'))
        } else if (d?.path) {
          setCliTestOk(false)
          setCliTestMessage(
            t('settings.providers.cliTestAmbiguous', {
              path: d.path,
              error: d.error ?? '',
            }),
          )
        } else {
          setCliTestOk(false)
          setCliTestMessage(t('settings.providers.cliTestMissing'))
        }
      } else {
        const result = await window.api.testProviderConnection?.('anthropic')
        if (result) setTestResult(result)
      }
    } catch (e: any) {
      setError(e?.message ?? String(e))
    } finally {
      setBusy(null)
    }
  }, [effectiveMode, t])

  // ── Render ───────────────────────────────────────────────────────

  const statusLabel = authMode === 'none'
    ? t('settings.providers.notSet')
    : authMode === 'cli_subscription'
      ? t('settings.providers.activeCli')
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
              {t('settings.providers.cliDetecting')}
            </div>
          )}

          {/* Mode picker — only in `both` state (scope §5.1). */}
          {!detecting && state === 'both' && (
            <div className="provider-card-mode-picker" role="radiogroup">
              <label className="provider-card-mode-option">
                <input
                  type="radio"
                  name="anthropic-authmode"
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
                  name="anthropic-authmode"
                  checked={effectiveMode === 'cli_subscription'}
                  onChange={activateCli}
                  disabled={busy !== null}
                />
                <Terminal size={14} />
                <span>{t('settings.providers.modeCliSubscription')}</span>
              </label>
            </div>
          )}

          {/* API key input — shown in api_only, both (when api_key mode
              selected), and neither (so user can paste to set up). */}
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

          {/* CLI subscription panel — shown in cli_only, both (when cli
              mode selected). */}
          {!detecting &&
            (state === 'cli_only' ||
              (state === 'both' && effectiveMode === 'cli_subscription')) && (
              <div className="provider-card-cli-panel">
                <div className="provider-card-cli-header">
                  <Terminal size={14} />
                  <span>{t('settings.providers.cliSubscriptionTitle')}</span>
                </div>
                <p className="provider-card-cli-desc">
                  {claudeAmbiguous
                    ? t('settings.providers.cliAmbiguous', {
                        path: detection?.path ?? '',
                      })
                    : detection?.version
                      ? t('settings.providers.cliReadyWithVersion', {
                          version: detection.version,
                        })
                      : t('settings.providers.cliReady')}
                </p>
                <div className="provider-card-actions">
                  {/* In cli_only state, show Activate iff we're not
                      already in cli_subscription mode. In `both` state
                      the radio already switched us in. */}
                  {state === 'cli_only' && authMode !== 'cli_subscription' && (
                    <button
                      className="provider-card-btn primary"
                      onClick={activateCli}
                      disabled={busy !== null || !claudeFound}
                    >
                      {busy === 'flip' && <Loader2 size={14} className="spin" />}
                      {t('settings.providers.activateCli')}
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
                {t('settings.providers.neitherHint')}{' '}
                <a
                  href="https://docs.claude.com/en/docs/claude-code/quickstart"
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  {t('settings.providers.cliInstallLink')}
                </a>
                .
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
