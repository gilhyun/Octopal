import type { AgentType } from './types'
import { AGENT_CONFIG } from './types'

interface AgentTagProps {
  agent: AgentType
  showAutoAssigned?: boolean
  className?: string
}

export function AgentTag({ agent, showAutoAssigned = false, className = '' }: AgentTagProps) {
  const config = AGENT_CONFIG[agent]

  return (
    <span
      className={`task-agent-tag ${className}`}
      style={{ '--agent-color': config.color } as React.CSSProperties}
      aria-label={`Assigned to: ${config.label}${showAutoAssigned ? ' (auto-assigned)' : ''}`}
    >
      <span className="task-agent-tag__emoji" aria-hidden="true">{config.emoji}</span>
      <span className="task-agent-tag__name">@{agent}</span>
      {showAutoAssigned && (
        <span className="task-agent-tag__auto" title="Auto-assigned" aria-label="auto-assigned">✨</span>
      )}
    </span>
  )
}
