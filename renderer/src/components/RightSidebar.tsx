import { useState } from 'react'
import { colorForName } from '../utils'
import { Zap, MoreHorizontal, FileEdit, FilePlus2, Terminal, Globe, ChevronDown, ChevronRight } from 'lucide-react'
import type { ActivityLogEntry } from '../types'
import { AgentAvatar } from './AgentAvatar'

interface RightSidebarProps {
  runes: RuneFile[]
  activeFolder: string | null
  activityLog: ActivityLogEntry[]
  setInput: (fn: (prev: string) => string) => void
  setEditingAgent: (agent: RuneFile) => void
  setShowCreateAgent: (v: boolean) => void
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 5_000) return 'just now'
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return `${Math.floor(diff / 86_400_000)}d ago`
}

function basename(p: string): string {
  return p.split('/').filter(Boolean).pop() || p
}

function toolIcon(tool: string) {
  if (tool === 'Write') return <FilePlus2 size={12} />
  if (tool === 'Edit') return <FileEdit size={12} />
  if (tool === 'Bash') return <Terminal size={12} />
  if (tool === 'WebFetch') return <Globe size={12} />
  return null
}

function entryLabel(entry: ActivityLogEntry) {
  if (entry.tool === 'Write') return `created ${basename(entry.target)}`
  if (entry.tool === 'Edit') return `edited ${basename(entry.target)}`
  if (entry.tool === 'Bash') return `ran ${entry.target}`
  if (entry.tool === 'WebFetch') return `fetched ${entry.target}`
  return entry.tool
}

export function RightSidebar({
  runes,
  activeFolder,
  activityLog,
  setInput,
  setEditingAgent,
  setShowCreateAgent,
}: RightSidebarProps) {
  const [activityOpen, setActivityOpen] = useState(false)
  // Newest first
  const recentActivity = [...activityLog].reverse().slice(0, 30)

  return (
    <aside className="right-sidebar">
      <div className="sidebar-header drag">
        <span className="section-title">Agents</span>
      </div>
      <div className="agent-list">
        {runes.length === 0 && (
          <div className="empty-agents">
            {activeFolder ? 'No .rune files in this folder' : 'Open a folder first'}
          </div>
        )}
        {runes.map((r) => {
          const hasPerms =
            r.permissions &&
            (r.permissions.fileWrite === true ||
              r.permissions.bash === true ||
              r.permissions.network === true)
          return (
            <div
              key={r.path}
              className="agent-item"
              role="button"
              tabIndex={0}
              onClick={() =>
                setInput((i) => i + (i && !i.endsWith(' ') ? ' ' : '') + `@${r.name} `)
              }
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  setInput((i) => i + (i && !i.endsWith(' ') ? ' ' : '') + `@${r.name} `)
                }
              }}
              onContextMenu={(e) => {
                e.preventDefault()
                setEditingAgent(r)
              }}
              title="Click to mention, right-click to edit"
            >
              <AgentAvatar name={r.name} icon={r.icon} showOnlineDot />
              <div className="agent-info">
                <div className="agent-name">
                  {r.name}
                  {hasPerms && <span className="agent-badge" title="Can use tools"><Zap size={12} /></span>}
                </div>
                <div className="agent-role">{r.role || 'agent'}</div>
              </div>
              <button
                className="agent-edit-btn"
                onClick={(e) => {
                  e.stopPropagation()
                  setEditingAgent(r)
                }}
                title="Edit agent"
              >
                <MoreHorizontal size={16} />
              </button>
            </div>
          )
        })}
        {activeFolder && (
          <button className="add-btn" onClick={() => setShowCreateAgent(true)}>
            + New agent
          </button>
        )}
      </div>

      {activeFolder && (
        <div className={`activity-section ${activityOpen ? 'open' : 'collapsed'}`}>
          <button
            className="activity-toggle"
            onClick={() => setActivityOpen((v) => !v)}
          >
            {activityOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            <span>Recent activity</span>
            {recentActivity.length > 0 && (
              <span className="activity-count">{recentActivity.length}</span>
            )}
          </button>
          {activityOpen && (
            <div className="activity-list">
              {recentActivity.length === 0 ? (
                <div className="empty-agents">No activity yet</div>
              ) : (
                recentActivity.map((entry) => (
                  <div
                    key={entry.id}
                    className="activity-entry"
                    title={entry.target}
                  >
                    <AgentAvatar name={entry.agentName} icon={runes.find(r => r.name === entry.agentName)?.icon} size="xs" />
                    <div className="activity-body">
                      <div className="activity-line">
                        <span className="activity-agent">{entry.agentName}</span>{' '}
                        <span className="activity-tool">{toolIcon(entry.tool)}</span>{' '}
                        <span className="activity-text">{entryLabel(entry)}</span>
                      </div>
                      <div className="activity-time">{relativeTime(entry.ts)}</div>
                    </div>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      )}
    </aside>
  )
}
