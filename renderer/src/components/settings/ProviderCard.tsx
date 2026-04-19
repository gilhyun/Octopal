import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Eye, EyeOff, Loader2, Trash2, X, Zap } from 'lucide-react'

/**
 * One card per provider in the Providers tab.
 *
 * The card renders three states, driven by `has` (a boolean from
 * `window.api.hasApiKey` — the settings flag, not a keyring read):
 *   - empty: no key stored; shows input + Save
 *   - filled: key stored; shows "••••" placeholder, Test Connection, Remove
 *   - saving/testing/removing: transient spinners
 *
 * The actual key value is never read from Rust — once saved, it lives in
 * OS keyring only. Re-opening the card after save shows the mask but the
 * input is empty; editing + saving replaces the stored value.
 *
 * ADR §D5 / scope §3.2: keys never traverse IPC in the read direction.
 */

interface ProviderCardProps {
  providerId: string
  displayName: string
  /** Whether this provider has a key configured (reads settings flag). */
  hasKey: boolean
  /** Called after save succeeds so parent can refresh flags + invalidation. */
  onSaved: () => void
  /** Called after delete succeeds. */
  onRemoved: () => void
  /** Running in env-fallback mode — save/remove show a banner instead. */
  envFallback: boolean
  /** Env var name the user should set in fallback mode (e.g. OCTOPAL_KEY_ANTHROPIC). */
  envVarName: string
  /** Placeholder / label for the key input. Ollama uses "Host URL". */
  keyLabel: string
  /** Auth method id (api_key / host_only). Phase 3+4 handles api_key + host_only only. */
  authMethodId: string
}

export function ProviderCard({
  providerId,
  displayName,
  hasKey,
  onSaved,
  onRemoved,
  envFallback,
  envVarName,
  keyLabel,
  authMethodId,
}: ProviderCardProps) {
  const { t } = useTranslation()
  const [keyInput, setKeyInput] = useState('')
  const [reveal, setReveal] = useState(false)
  const [busy, setBusy] = useState<'save' | 'remove' | 'test' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<TestConnectionResult | null>(null)

  useEffect(() => {
    // Clear in-memory input whenever the stored-state changes — prevents a
    // stale input from hanging around after a successful save.
    setKeyInput('')
    setError(null)
  }, [hasKey, providerId])

  const save = useCallback(async () => {
    const value = keyInput.trim()
    if (!value) {
      setError(t('settings.providers.errors.emptyKey'))
      return
    }
    setBusy('save')
    setError(null)
    try {
      await window.api.saveApiKey?.(providerId, value)
      setKeyInput('')
      onSaved()
    } catch (e: any) {
      setError(e?.message ?? String(e))
    } finally {
      setBusy(null)
    }
  }, [keyInput, providerId, onSaved, t])

  const remove = useCallback(async () => {
    if (!confirm(t('settings.providers.confirmRemove', { name: displayName }))) return
    setBusy('remove')
    setError(null)
    try {
      await window.api.deleteApiKey?.(providerId)
      onRemoved()
    } catch (e: any) {
      setError(e?.message ?? String(e))
    } finally {
      setBusy(null)
    }
  }, [providerId, displayName, onRemoved, t])

  const testConnection = useCallback(async () => {
    setBusy('test')
    setError(null)
    setTestResult(null)
    try {
      const result = await window.api.testProviderConnection?.(providerId)
      if (result) setTestResult(result)
    } catch (e: any) {
      setError(e?.message ?? String(e))
    } finally {
      setBusy(null)
    }
  }, [providerId])

  // host_only providers (Ollama) don't need a secret; we reuse the same
  // keyring slot to store the host URL. Same UI; different semantics.
  const isHostOnly = authMethodId === 'host_only'

  return (
    <div className="provider-card">
      <header className="provider-card-header">
        <span className="provider-card-name">{displayName}</span>
        <span
          className={`provider-card-status ${hasKey ? 'active' : 'inactive'}`}
          aria-label={hasKey ? t('settings.providers.active') : t('settings.providers.notSet')}
        >
          <span className="provider-card-status-dot" />
          {hasKey ? t('settings.providers.active') : t('settings.providers.notSet')}
        </span>
      </header>

      {envFallback ? (
        <div className="provider-card-fallback">
          {t('settings.providers.fallbackHint', { envVar: envVarName })}
        </div>
      ) : (
        <div className="provider-card-body">
          <label className="provider-card-label">{keyLabel}</label>
          <div className="provider-card-input-row">
            <input
              type={reveal ? 'text' : 'password'}
              className="provider-card-input"
              placeholder={hasKey ? '••••••••••••••••' : t('settings.providers.keyPlaceholder')}
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
              aria-label={reveal ? t('settings.providers.hide') : t('settings.providers.reveal')}
              title={reveal ? t('settings.providers.hide') : t('settings.providers.reveal')}
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
              {busy === 'save' ? <Loader2 size={14} className="spin" /> : null}
              {isHostOnly
                ? t('settings.providers.saveHost')
                : hasKey
                  ? t('settings.providers.replaceKey')
                  : t('settings.providers.saveKey')}
            </button>
            {hasKey && (
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

          {error && <div className="provider-card-error">{error}</div>}
        </div>
      )}
    </div>
  )
}
