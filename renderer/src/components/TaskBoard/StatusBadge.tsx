import type { TaskStatus } from './types'
import { STATUS_CONFIG } from './types'

interface StatusBadgeProps {
  status: TaskStatus
  className?: string
}

export function StatusBadge({ status, className = '' }: StatusBadgeProps) {
  const config = STATUS_CONFIG[status]

  return (
    <span
      className={`task-status-badge task-status-badge--${status} ${className}`}
      role="status"
      aria-label={`Status: ${config.label}`}
    >
      <span className="task-status-badge__icon" aria-hidden="true">{config.icon}</span>
      <span className="task-status-badge__label">{config.label}</span>
    </span>
  )
}
