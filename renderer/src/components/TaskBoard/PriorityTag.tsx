import type { TaskPriority } from './types'
import { PRIORITY_CONFIG } from './types'

interface PriorityTagProps {
  priority: TaskPriority
  className?: string
}

export function PriorityTag({ priority, className = '' }: PriorityTagProps) {
  const config = PRIORITY_CONFIG[priority]

  return (
    <span
      className={`task-priority-tag task-priority-tag--${priority} ${className}`}
      aria-label={`Priority: ${config.label}`}
    >
      <span className="task-priority-tag__icon" aria-hidden="true">{config.icon}</span>
      <span className="task-priority-tag__label">{config.label}</span>
    </span>
  )
}
