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

function normalizeHealthResult(
  result: { status: 'ok' | 'package_missing' | 'spawn_error' | 'timeout'; error?: string; packageName?: string } | undefined,
  unknownError: string,
): ServerResult {
  if (!result) return { status: 'spawn_error', error: unknownError }
  return {
    status: result.status === 'ok'
      ? 'ok'
      : result.status === 'package_missing'
        ? 'package_missing'
        : 'spawn_error',
    error: result.error,
    packageName: result.packageName,
  }
}

/** Validate every MCP server configured for the agent. */
export function McpValidationModal({ mcpServers, onClose, onDone }: McpValidationModalProps) {
  const { t } = useTranslation()
  const serverNames = Object.keys(mcpServers)
  const initialResults = () => Object.fromEntries(
    serverNames.map((name) => [name, { status: 'pending' as const }]),
  )
  const [results, setResults] = useState<Record<string, ServerResult>>(initialResults)
  const [phase, setPhase] = useState<'checking' | 'done'>('checking')

  const updateResult = (serverName: string, result: ServerResult) => {
    setResults((prev) => ({ ...prev, [serverName]: result }))
  }

  const runHealthCheck = useCallback(async () => {
    setResults(Object.fromEntries(
      serverNames.map((name) => [name, { status: 'checking' as const }]),
    ))
    setPhase('checking')

    try {
      const response = await window.api.mcpHealthCheck({ mcpServers })
      if (!response.ok) {
        const error = response.error || t('mcpValidation.unknownError')
        setResults(Object.fromEntries(
          serverNames.map((name) => [name, { status: 'spawn_error' as const, error }]),
        ))
      } else {
        setResults(Object.fromEntries(
          serverNames.map((name) => [
            name,
            normalizeHealthResult(response.results[name], t('mcpValidation.unknownError')),
          ]),
        ))
      }
    } catch (e: unknown) {
      const error = e instanceof Error ? e.message : String(e)
      setResults(Object.fromEntries(
        serverNames.map((name) => [name, { status: 'spawn_error' as const, error }]),
      ))
    } finally {
      setPhase('done')
    }
  }, [mcpServers, t])

  useEffect(() => {
    void runHealthCheck()
  }, [runHealthCheck])

  const installPackage = async (serverName: string, packageName: string) => {
    updateResult(serverName, { status: 'installing', packageName })

    try {
      const install = await window.api.mcpInstallPackage({ packageName })
      if (!install.ok) {
        updateResult(serverName, {
          status: 'install_failed',
          error: install.error,
          packageName,
        })
        return
      }

      updateResult(serverName, { status: 'checking', packageName })
      try {
        const check = await window.api.mcpHealthCheck({
          mcpServers: { [serverName]: mcpServers[serverName] },
        })
        if (!check.ok) {
          updateResult(serverName, {
            status: 'spawn_error',
            error: check.error || t('mcpValidation.unknownError'),
            packageName,
          })
          return
        }
        updateResult(
          serverName,
          normalizeHealthResult(check.results[serverName], t('mcpValidation.unknownError')),
        )
      } catch (e: unknown) {
        // A failed verification is never success. Keep the server visibly in
        // an error state so users do not trust an unverified installation.
        updateResult(serverName, {
          status: 'spawn_error',
          error: e instanceof Error ? e.message : String(e),
          packageName,
        })
      }
    } catch (e: unknown) {
      updateResult(serverName, {
        status: 'install_failed',
        error: e instanceof Error ? e.message : String(e),
        packageName,
      })
    }
  }

  const resultValues = serverNames.map((name) => results[name] ?? { status: 'pending' as const })
  const isOk = serverNames.length > 0 && resultValues.every((result) => result.status === 'ok')
  const hasIssue = resultValues.some((result) =>
    ['package_missing', 'spawn_error', 'install_failed'].includes(result.status),
  )
  const isWorking = resultValues.some((result) =>
    ['pending', 'checking', 'installing'].includes(result.status),
  )

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

  /** Build a user-friendly error description with actionable fix instructions. */
  const renderErrorDetail = (serverName: string, result: ServerResult) => {
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
          {serverNames.map((serverName) => {
            const result = results[serverName] ?? { status: 'pending' as const }
            return (
              <div key={serverName} className={`mcp-validation-item mcp-validation--${result.status}`}>
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
                  {renderErrorDetail(serverName, result)}
                </div>
                {result.status === 'package_missing' && result.packageName && (
                  <button
                    className="btn-primary btn-small"
                    onClick={() => void installPackage(serverName, result.packageName!)}
                  >
                    {t('mcpValidation.install')}
                  </button>
                )}
                {result.status === 'install_failed' && result.packageName && (
                  <button
                    className="btn-secondary btn-small"
                    onClick={() => void installPackage(serverName, result.packageName!)}
                  >
                    {t('mcpValidation.retry')}
                  </button>
                )}
              </div>
            )
          })}
        </div>

        {phase === 'done' && isOk && (
          <div className="mcp-validation-summary mcp-validation-summary--ok">
            {t('mcpValidation.serverConnected', { server: serverNames.join(', ') })}
          </div>
        )}
        {phase === 'done' && hasIssue && (
          <div className="mcp-validation-summary mcp-validation-summary--warn">
            {t('mcpValidation.hasIssues')}
          </div>
        )}

        <div className="modal-actions">
          {phase === 'done' && hasIssue && (
            <button className="btn-secondary" onClick={() => void runHealthCheck()}>
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
