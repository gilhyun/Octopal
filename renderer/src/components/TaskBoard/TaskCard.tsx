import type { Task, TaskStatus } from './types'
import { PriorityTag } from './PriorityTag'
import { AgentTag } from './AgentTag'
import { Grip } from 'lucide-react'

interface TaskCardProps {
  task: Task
  onSelect: () => void
  onStatusChange: (status: TaskStatus) => void
  isDragging?: boolean
  className?: string
}

export function TaskCard({ task, onSelect, onStatusChange, isDragging = false, className = '' }: TaskCardProps) {
  const subtasksDone = task.subtasks?.filter((s) => s.done).length ?? 0
  const subtasksTotal = task.subtasks?.length ?? 0

  return (
    <div
      className={`task-card ${isDragging ? 'task-card--dragging' : ''} ${task.status === 'active' ? 'task-card--active' : ''} ${className}`}
      onClick={onSelect}
      role="button"
      tabIndex={0}
      aria-label={`Task: ${task.title}, Priority: ${task.priority}, Status: ${task.status}`}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect()
        }
      }}
    >
      <div className="task-card__header">
        <PriorityTag priority={task.priority} />
        <span className="task-card__drag-handle" aria-hidden="true">
          <Grip size={12} />
        </span>
      </div>

      <h4 className="task-card__title">{task.title}</h4>

      {task.description && (
        <p className="task-card__desc">{task.description}</p>
      )}

      <div className="task-card__footer">
        <div className="task-card__meta">
          {subtasksTotal > 0 && (
            <span className="task-card__subtasks" aria-label={`${subtasksDone} of ${subtasksTotal} subtasks done`}>
              <span className="task-card__subtasks-bar">
                <span
                  className="task-card__subtasks-fill"
                  style={{ width: `${(subtasksDone / subtasksTotal) * 100}%` }}
                />
              </span>
              <span className="task-card__subtasks-count">{subtasksDone}/{subtasksTotal}</span>
            </span>
          )}
        </div>
        {task.assignee && (
          <AgentTag agent={task.assignee} showAutoAssigned={task.autoAssigned} />
        )}
      </div>
    </div>
  )
}
