import { useTranslation } from 'react-i18next'
import { FileEdit, FilePlus2, Terminal, Globe, Zap } from 'lucide-react'
import type { ActivityLogEntry, Message, TokenUsage } from '../types'
import { AgentAvatar } from './AgentAvatar'

interface ActivityPanelProps {
  activityLog: ActivityLogEntry[]
  octos: OctoFile[]
  folderMessages?: Message[]
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

export function ActivityPanel({ activityLog, octos, folderMessages = [] }: ActivityPanelProps) {
  const { t } = useTranslation()
  const entries = [...activityLog].reverse()
  const usage = computeSessionUsage(folderMessages)

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

  return (
    <div className="activity-panel">
      <div className="activity-panel-header drag">
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
          entries.map((entry) => (
            <div key={entry.id} className="activity-panel-entry" title={entry.target}>
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
                  <span className="activity-panel-target">{entry.target}</span>
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
