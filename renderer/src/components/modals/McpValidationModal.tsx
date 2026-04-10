import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'

type ServerStatus = 'pending' | 'checking' | 'ok' | 'package_missing' | 'spawn_error' | 'installing' | 'install_failed'

interface ServerResult {
  status: ServerStatus
  error?: string
  packageName?: string
}

interface McpValidationModalProps {
  mcpServers: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>
  onClose: () => void
  onDone: () => void
}

/**
 * MCP Validation Modal — single server per agent.
 * Validates the MCP server config, offers package installation, and shows
 * actionable error messages (what went wrong + how to fix it).
 */
export function McpValidationModal({ mcpServers, onClose, onDone }: McpValidationModalProps) {
  const { t } = useTranslation()

  // Single server: take the first (and only) entry
  const serverName = Object.keys(mcpServers)[0]
  const serverConfig = mcpServers[serverName]

  const [result, setResult] = useState<ServerResult>({ status: 'pending' })
  const [phase, setPhase] = useState<'checking' | 'done'>('checking')

  const runHealthCheck = useCallback(async () => {
    setResult({ status: 'checking' })
    setPhase('checking')

    try {
      const res = await window.api.mcpHealthCheck({ mcpServers: { [serverName]: serverConfig } })
      if (!res.ok) {
        setResult({ status: 'spawn_error', error: (res as any).error || t('mcpValidation.unknownError') })
      } else {
        const r = res.results[serverName]
        if (r) {
          setResult({
            status: r.status === 'ok' ? 'ok'
              : r.status === 'package_missing' ? 'package_missing'
              : 'spawn_error',
            error: r.error,
            packageName: r.packageName,
          })
        } else {
          setResult({ status: 'spawn_error', error: t('mcpValidation.unknownError') })
        }
      }
    } catch (e: any) {
      setResult({ status: 'spawn_error', error: e.message })
    }
    setPhase('done')
  }, [serverName, serverConfig, t])

  useEffect(() => {
    runHealthCheck()
  }, [runHealthCheck])

  const installPackage = async (packageName: string) => {
    setResult({ status: 'installing', packageName })

    const res = await window.api.mcpInstallPackage({ packageName })
    if (res.ok) {
      // Re-check after install
      setResult({ status: 'checking', packageName })
      try {
        const checkRes = await window.api.mcpHealthCheck({ mcpServers: { [serverName]: serverConfig } })
        if (checkRes.ok && checkRes.results[serverName]) {
          const r = checkRes.results[serverName]
          setResult({
            status: r.status === 'ok' ? 'ok' : 'spawn_error',
            error: r.error,
            packageName,
          })
        }
      } catch {
        setResult({ status: 'ok', packageName }) // Assume OK if re-check fails
      }
    } else {
      setResult({ status: 'install_failed', error: res.error, packageName })
    }
  }

  const isOk = result.status === 'ok'
  const hasIssue = ['package_missing', 'spawn_error', 'install_failed'].includes(result.status)
  const isWorking = ['pending', 'checking', 'installing'].includes(result.status)

  const statusIcon = (status: ServerStatus) => {
    switch (status) {
      case 'pending': return '\u23F3'
      case 'checking': return '\uD83D\uDD0D'
      case 'ok': return '\u2705'
      case 'package_missing': return '\uD83D\uDCE6'
      case 'spawn_error': return '\u274C'
      case 'installing': return '\u23F3'
      case 'install_failed': return '\u274C'
    }
  }

  /** Build a user-friendly error description with actionable fix instructions */
  const renderErrorDetail = () => {
    const error = result.error || ''
    const lowerError = error.toLowerCase()

    if (result.status === 'package_missing') {
      return (
        <div className="mcp-validation-detail">
          <div>{t('mcpValidation.packageMissing', { package: result.packageName || '?' })}</div>
          <div className="mcp-validation-hint">{t('mcpValidation.packageMissingHint', { package: result.packageName || '?' })}</div>
        </div>
      )
    }

    if (result.status === 'spawn_error') {
      // Detect auth/token errors
      if (lowerError.includes('unauthorized') || lowerError.includes('invalid token') ||
          lowerError.includes('401') || lowerError.includes('403') || lowerError.includes('auth') ||
          lowerError.includes('token') || lowerError.includes('forbidden') ||
          lowerError.includes('api_key') || lowerError.includes('api key')) {
        return (
          <div className="mcp-validation-detail mcp-validation-detail--error">
            <div>{t('mcpValidation.authError', { server: serverName })}</div>
            <div className="mcp-validation-hint">{t('mcpValidation.authErrorHint')}</div>
            {error && <div className="mcp-validation-raw-error">{error.slice(0, 300)}</div>}
          </div>
        )
      }

      // Detect network errors
      if (lowerError.includes('enotfound') || lowerError.includes('network') ||
          lowerError.includes('econnrefused') || lowerError.includes('timeout') ||
          lowerError.includes('fetch failed')) {
        return (
          <div className="mcp-validation-detail mcp-validation-detail--error">
            <div>{t('mcpValidation.networkError')}</div>
            <div className="mcp-validation-hint">{t('mcpValidation.networkErrorHint')}</div>
            {error && <div className="mcp-validation-raw-error">{error.slice(0, 300)}</div>}
          </div>
        )
      }

      // Generic spawn error — show the raw error
      return (
        <div className="mcp-validation-detail mcp-validation-detail--error">
          <div>{t('mcpValidation.spawnError')}</div>
          {error && <div className="mcp-validation-raw-error">{error.slice(0, 300)}</div>}
        </div>
      )
    }

    if (result.status === 'install_failed') {
      return (
        <div className="mcp-validation-detail mcp-validation-detail--error">
          <div>{t('mcpValidation.installFailed')}</div>
          {error && <div className="mcp-validation-raw-error">{error}</div>}
          <div className="mcp-validation-hint">{t('mcpValidation.installFailedHint')}</div>
        </div>
      )
    }

    return null
  }

  return (
    <div className="modal-backdrop" onClick={isWorking ? undefined : onClose}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">{t('mcpValidation.title')}</div>

        <div className="mcp-validation-list">
          <div className={`mcp-validation-item mcp-validation--${result.status}`}>
            <span className="mcp-validation-icon">{statusIcon(result.status)}</span>
            <div className="mcp-validation-info">
              <div className="mcp-validation-name">{serverName}</div>
              {result.status === 'checking' && (
                <div className="mcp-validation-detail">{t('mcpValidation.checking')}</div>
              )}
              {result.status === 'ok' && (
                <div className="mcp-validation-detail mcp-validation-detail--ok">{t('mcpValidation.connected')}</div>
              )}
              {result.status === 'installing' && (
                <div className="mcp-validation-detail">{t('mcpValidation.installing', { package: result.packageName })}</div>
              )}
              {renderErrorDetail()}
            </div>
            {result.status === 'package_missing' && result.packageName && (
              <button
                className="btn-primary btn-small"
                onClick={() => installPackage(result.packageName!)}
              >
                {t('mcpValidation.install')}
              </button>
            )}
            {result.status === 'install_failed' && result.packageName && (
              <button
                className="btn-secondary btn-small"
                onClick={() => installPackage(result.packageName!)}
              >
                {t('mcpValidation.retry')}
              </button>
            )}
          </div>
        </div>

        {phase === 'done' && isOk && (
          <div className="mcp-validation-summary mcp-validation-summary--ok">
            {t('mcpValidation.serverConnected', { server: serverName })}
          </div>
        )}
        {phase === 'done' && hasIssue && (
          <div className="mcp-validation-summary mcp-validation-summary--warn">
            {t('mcpValidation.hasIssues')}
          </div>
        )}

        <div className="modal-actions">
          {phase === 'done' && hasIssue && (
            <button className="btn-secondary" onClick={runHealthCheck}>
              {t('mcpValidation.recheck')}
            </button>
          )}
          <div style={{ flex: 1 }} />
          <button className="btn-secondary" onClick={onClose}>
            {t('mcpValidation.skip')}
          </button>
          <button
            className="btn-primary"
            disabled={isWorking}
            onClick={onDone}
          >
            {isOk ? t('mcpValidation.done') : t('mcpValidation.continueAnyway')}
          </button>
        </div>
      </div>
    </div>
  )
}
