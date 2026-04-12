import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FileEdit, FilePlus2, Terminal, Globe, Zap, Undo2, AlertTriangle, X } from 'lucide-react'
import { diffLines } from 'diff'
import type { ActivityLogEntry, Message, TokenUsage } from '../types'
import { AgentAvatar } from './AgentAvatar'

interface ActivityPanelProps {
  activityLog: ActivityLogEntry[]
  octos: OctoFile[]
  folderMessages?: Message[]
  /// Workspace folder path — required for backup APIs. Optional so callers
  /// that don't have a folder selected (rare) still render the panel.
  folderPath?: string
}

function basename(p: string): string {
  return p.split('/').filter(Boolean).pop() || p
}

function toolIcon(tool: string) {
  if (tool === 'Write') return <FilePlus2 size={14} />
  if (tool === 'Edit') return <FileEdit size={14} />
  if (tool === 'Bash') return <Terminal size={14} />
  if (tool === 'WebFetch') return <Globe size={14} />
  return null
}

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return `${n}`
}

function formatCost(usd: number): string {
  if (usd < 0.001) return `$${usd.toFixed(4)}`
  if (usd < 0.01) return `$${usd.toFixed(3)}`
  return `$${usd.toFixed(2)}`
}

interface AgentUsageSummary {
  agentName: string
  totalInput: number
  totalOutput: number
  totalCost: number
  messageCount: number
}

function computeSessionUsage(messages: Message[]): {
  totalInput: number
  totalOutput: number
  totalCost: number
  messageCount: number
  byAgent: AgentUsageSummary[]
} {
  let totalInput = 0
  let totalOutput = 0
  let totalCost = 0
  let messageCount = 0
  const agentMap = new Map<string, AgentUsageSummary>()

  for (const m of messages) {
    if (!m.usage) continue
    messageCount++
    totalInput += m.usage.inputTokens
    totalOutput += m.usage.outputTokens
    totalCost += m.usage.costUsd || 0

    const existing = agentMap.get(m.agentName)
    if (existing) {
      existing.totalInput += m.usage.inputTokens
      existing.totalOutput += m.usage.outputTokens
      existing.totalCost += m.usage.costUsd || 0
      existing.messageCount++
    } else {
      agentMap.set(m.agentName, {
        agentName: m.agentName,
        totalInput: m.usage.inputTokens,
        totalOutput: m.usage.outputTokens,
        totalCost: m.usage.costUsd || 0,
        messageCount: 1,
      })
    }
  }

  return {
    totalInput,
    totalOutput,
    totalCost,
    messageCount,
    byAgent: Array.from(agentMap.values()).sort((a, b) => b.totalCost - a.totalCost),
  }
}

interface DiffViewState {
  entry: ActivityLogEntry
  loading: boolean
  before: string
  after: string
  error?: string
}

/// Pure version of `relativeFor` that the file count memo can call without
/// closing over component state.
function relativeForStatic(target: string, folderPath?: string): string {
  if (!folderPath) return target
  if (target.startsWith(folderPath)) {
    return target.slice(folderPath.length).replace(/^\//, '')
  }
  return target
}

export function ActivityPanel({ activityLog, octos, folderMessages = [], folderPath }: ActivityPanelProps) {
  const { t } = useTranslation()
  const entries = [...activityLog].reverse()
  const usage = computeSessionUsage(folderMessages)
  const [diffView, setDiffView] = useState<DiffViewState | null>(null)
  const [reverting, setReverting] = useState(false)

  /// Number of distinct files touched per backupId — used by the diff modal
  /// to label the "Revert run" button. A run can have many entries (multiple
  /// edits to the same file count as one).
  const filesPerRun = (() => {
    const map = new Map<string, Set<string>>()
    for (const entry of activityLog) {
      if (!entry.backupId) continue
      const set = map.get(entry.backupId) || new Set<string>()
      set.add(relativeForStatic(entry.target, folderPath))
      map.set(entry.backupId, set)
    }
    return map
  })()

  function relativeTime(ts: number): string {
    const diff = Date.now() - ts
    if (diff < 5_000) return t('activity.justNow')
    if (diff < 60_000) return t('activity.secondsAgo', { n: Math.floor(diff / 1000) })
    if (diff < 3_600_000) return t('activity.minutesAgo', { n: Math.floor(diff / 60_000) })
    if (diff < 86_400_000) return t('activity.hoursAgo', { n: Math.floor(diff / 3_600_000) })
    return t('activity.daysAgo', { n: Math.floor(diff / 86_400_000) })
  }

  function toolLabel(tool: string): string {
    if (tool === 'Write') return t('activity.toolCreated')
    if (tool === 'Edit') return t('activity.toolEdited')
    if (tool === 'Bash') return t('activity.toolRan')
    if (tool === 'WebFetch') return t('activity.toolFetched')
    return tool
  }

  /// Resolve the relative path that the backup uses for an activity entry's
  /// target. The backend stores paths relative to the workspace folder, but
  /// claude's tool input may give absolute paths.
  function relativeFor(target: string): string {
    if (!folderPath) return target
    if (target.startsWith(folderPath)) {
      return target.slice(folderPath.length).replace(/^\//, '')
    }
    return target
  }

  async function openDiff(entry: ActivityLogEntry) {
    if (!folderPath || !entry.backupId) return
    const rel = relativeFor(entry.target)
    setDiffView({ entry, loading: true, before: '', after: '' })
    try {
      const [before, after] = await Promise.all([
        window.api.readBackupFile({
          folderPath,
          backupId: entry.backupId,
          filePath: rel,
        }),
        window.api.readCurrentFile({
          folderPath,
          filePath: rel,
        }),
      ])
      setDiffView({ entry, loading: false, before, after })
    } catch (e: any) {
      setDiffView({
        entry,
        loading: false,
        before: '',
        after: '',
        error: String(e?.message || e),
      })
    }
  }

  async function handleRevert(entry: ActivityLogEntry) {
    if (!folderPath || !entry.backupId) return
    const rel = relativeFor(entry.target)
    setReverting(true)
    try {
      await window.api.revertBackup({
        folderPath,
        backupId: entry.backupId,
        filePath: rel,
      })
      // Refresh the diff if we're showing it for this entry
      if (diffView?.entry.id === entry.id) {
        await openDiff(entry)
      }
    } finally {
      setReverting(false)
    }
  }

  /// Revert every file the agent touched during the run that produced
  /// `entry`. Confirms first because this can affect many files.
  async function handleRevertRun(entry: ActivityLogEntry) {
    if (!folderPath || !entry.backupId) return
    const count = filesPerRun.get(entry.backupId)?.size ?? 0
    if (count > 1 && !window.confirm(t('activity.revertConfirm', { count }))) {
      return
    }
    setReverting(true)
    try {
      await window.api.revertBackup({
        folderPath,
        backupId: entry.backupId,
        // omit filePath → backend reverts every file in the backup meta
      })
      if (diffView?.entry.id === entry.id) {
        await openDiff(entry)
      }
    } finally {
      setReverting(false)
    }
  }

  // Close diff modal on Escape
  useEffect(() => {
    if (!diffView) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDiffView(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [diffView])

  return (
    <div className="activity-panel">
      <div className="activity-panel-header drag" data-tauri-drag-region>
        <span className="section-title">{t('activity.title')}</span>
        <span className="activity-panel-count">{entries.length}</span>
      </div>

      {/* Session usage summary */}
      {usage.messageCount > 0 && (
        <div className="usage-summary">
          <div className="usage-summary-header">
            <Zap size={14} />
            <span className="usage-summary-title">{t('activity.usageTitle')}</span>
          </div>
          <div className="usage-summary-stats">
            <div className="usage-summary-stat">
              <span className="usage-stat-value">{formatTokenCount(usage.totalInput + usage.totalOutput)}</span>
              <span className="usage-stat-label">{t('activity.totalTokens')}</span>
            </div>
            {usage.totalCost > 0 && (
              <div className="usage-summary-stat">
                <span className="usage-stat-value usage-stat-cost">{formatCost(usage.totalCost)}</span>
                <span className="usage-stat-label">{t('activity.totalCost')}</span>
              </div>
            )}
            <div className="usage-summary-stat">
              <span className="usage-stat-value">{usage.messageCount}</span>
              <span className="usage-stat-label">{t('activity.responses')}</span>
            </div>
          </div>
          {usage.byAgent.length > 1 && (
            <div className="usage-by-agent">
              {usage.byAgent.map((a) => (
                <div key={a.agentName} className="usage-agent-row">
                  <AgentAvatar
                    name={a.agentName}
                    icon={octos.find((r) => r.name === a.agentName)?.icon}
                    size="xs"
                  />
                  <span className="usage-agent-name">{a.agentName}</span>
                  <span className="usage-agent-tokens">{formatTokenCount(a.totalInput + a.totalOutput)}</span>
                  {a.totalCost > 0 && (
                    <span className="usage-agent-cost">{formatCost(a.totalCost)}</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="activity-panel-list">
        {entries.length === 0 && usage.messageCount === 0 ? (
          <div className="activity-panel-empty">{t('activity.empty')}</div>
        ) : entries.length === 0 ? null : (
          entries.map((entry) => {
            const isRevertable = !!entry.backupId && (entry.tool === 'Write' || entry.tool === 'Edit')
            const hasConflict = !!entry.conflictWith
            return (
              <div
                key={entry.id}
                className={`activity-panel-entry${hasConflict ? ' has-conflict' : ''}`}
                title={entry.target}
              >
                <AgentAvatar
                  name={entry.agentName}
                  icon={octos.find((r) => r.name === entry.agentName)?.icon}
                  size="sm"
                />
                <div className="activity-panel-body">
                  <div className="activity-panel-top">
                    <span className="activity-panel-agent">{entry.agentName}</span>
                    <span className="activity-panel-time">{relativeTime(entry.ts)}</span>
                  </div>
                  <div className="activity-panel-detail">
                    <span className={`activity-panel-tool-icon tool-${entry.tool.toLowerCase()}`}>{toolIcon(entry.tool)}</span>
                    <span className={`activity-panel-tool-label tool-${entry.tool.toLowerCase()}`}>{toolLabel(entry.tool)}</span>
                    <button
                      type="button"
                      className="activity-panel-target activity-panel-target-button"
                      onClick={() => isRevertable && openDiff(entry)}
                      disabled={!isRevertable}
                    >
                      {basename(entry.target) || entry.target}
                    </button>
                  </div>
                  {hasConflict && (
                    <div className="activity-panel-conflict">
                      <AlertTriangle size={12} />
                      <span>
                        {t('activity.conflictWith', {
                          agent: entry.conflictWith?.agentName || 'another agent',
                          defaultValue: 'Also being modified by {{agent}}',
                        })}
                      </span>
                    </div>
                  )}
                </div>
                {isRevertable && (
                  <button
                    type="button"
                    className="activity-panel-revert"
                    onClick={() => handleRevert(entry)}
                    disabled={reverting}
                    title={t('activity.revertTitle', { defaultValue: 'Revert this change' })}
                  >
                    <Undo2 size={14} />
                  </button>
                )}
              </div>
            )
          })
        )}
      </div>

      {diffView && (
        <DiffModal
          state={diffView}
          runFileCount={
            diffView.entry.backupId
              ? filesPerRun.get(diffView.entry.backupId)?.size ?? 0
              : 0
          }
          onClose={() => setDiffView(null)}
          onRevert={() => handleRevert(diffView.entry)}
          onRevertRun={() => handleRevertRun(diffView.entry)}
          reverting={reverting}
          t={t}
        />
      )}
    </div>
  )
}

interface DiffModalProps {
  state: DiffViewState
  runFileCount: number
  onClose: () => void
  onRevert: () => void
  onRevertRun: () => void
  reverting: boolean
  t: (key: string, opts?: any) => string
}

function DiffModal({ state, runFileCount, onClose, onRevert, onRevertRun, reverting, t }: DiffModalProps) {
  const { entry, loading, before, after, error } = state
  const parts = !loading && !error ? diffLines(before, after) : []
  return (
    <div className="diff-modal-backdrop" onClick={onClose}>
      <div className="diff-modal" onClick={(e) => e.stopPropagation()}>
        <div className="diff-modal-header">
          <div className="diff-modal-title">
            <span className="diff-modal-tool">{entry.tool}</span>
            <span className="diff-modal-target">{entry.target}</span>
          </div>
          <div className="diff-modal-actions">
            <button
              type="button"
              className="diff-modal-revert"
              onClick={onRevert}
              disabled={reverting}
              title={t('activity.revertTitle')}
            >
              <Undo2 size={14} />
              {t('activity.revert')}
            </button>
            {runFileCount > 1 && (
              <button
                type="button"
                className="diff-modal-revert"
                onClick={onRevertRun}
                disabled={reverting}
                title={t('activity.revertRunTitle')}
              >
                <Undo2 size={14} />
                {t('activity.revertRunLabel')} ({runFileCount})
              </button>
            )}
            <button type="button" className="diff-modal-close" onClick={onClose}>
              <X size={16} />
            </button>
          </div>
        </div>
        <div className="diff-modal-body">
          {loading && <div className="diff-modal-loading">…</div>}
          {error && <div className="diff-modal-error">{error}</div>}
          {!loading && !error && parts.length === 0 && (
            <div className="diff-modal-empty">
              {t('activity.noChange', { defaultValue: 'No changes to show.' })}
            </div>
          )}
          {!loading && !error && parts.length > 0 && (
            <pre className="diff-modal-pre">
              {parts.map((part, i) => {
                const cls = part.added
                  ? 'diff-line-added'
                  : part.removed
                    ? 'diff-line-removed'
                    : 'diff-line-context'
                const prefix = part.added ? '+' : part.removed ? '-' : ' '
                return (
                  <span key={i} className={cls}>
                    {part.value
                      .split('\n')
                      .filter((line, idx, arr) => !(idx === arr.length - 1 && line === ''))
                      .map((line, j) => (
                        <span key={j} className="diff-line">
                          <span className="diff-line-prefix">{prefix}</span>
                          {line}
                          {'\n'}
                        </span>
                      ))}
                  </span>
                )
              })}
            </pre>
          )}
        </div>
      </div>
    </div>
  )
}
