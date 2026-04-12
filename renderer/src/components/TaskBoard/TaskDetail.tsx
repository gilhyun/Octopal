import { useState, useEffect } from 'react'
import { X, Plus, Trash2 } from 'lucide-react'
import type { Task, TaskStatus, TaskPriority, AgentType } from './types'
import { STATUS_CONFIG, PRIORITY_CONFIG, AGENT_CONFIG, AGENT_OPTIONS, ALL_STATUSES, ALL_PRIORITIES } from './types'
import { StatusBadge } from './StatusBadge'
import { PriorityTag } from './PriorityTag'
import { AgentTag } from './AgentTag'

interface TaskDetailProps {
  task: Task
  onClose: () => void
  onUpdate: (updates: Partial<Task>) => void
  onDelete: () => void
}

export function TaskDetail({ task, onClose, onUpdate, onDelete }: TaskDetailProps) {
  const [newSubtask, setNewSubtask] = useState('')
  const [localDesc, setLocalDesc] = useState(task.description || '')

  // Escape to close
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  // Sync local description when task changes externally
  useEffect(() => {
    setLocalDesc(task.description || '')
  }, [task.id, task.description])

  const addSubtask = () => {
    if (!newSubtask.trim()) return
    const subtask = {
      id: `sub-${crypto.randomUUID()}`,
      title: newSubtask.trim(),
      done: false,
    }
    onUpdate({
      subtasks: [...(task.subtasks || []), subtask],
    })
    setNewSubtask('')
  }

  const toggleSubtask = (id: string) => {
    onUpdate({
      subtasks: (task.subtasks || []).map((s) =>
        s.id === id ? { ...s, done: !s.done } : s,
      ),
    })
  }

  const removeSubtask = (id: string) => {
    onUpdate({
      subtasks: (task.subtasks || []).filter((s) => s.id !== id),
    })
  }

  const formatTime = (ts: number) => {
    const d = new Date(ts)
    return d.toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    })
  }

  return (
    <div className="task-detail-backdrop" onClick={onClose}>
      <aside
        className="task-detail"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`Task detail: ${task.title}`}
      >
        <div className="task-detail__header">
          <h3 className="task-detail__title">{task.title}</h3>
          <button className="task-detail__close" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <div className="task-detail__body">
          {/* Status & Priority */}
          <div className="task-detail__meta-row">
            <div className="task-detail__field">
              <span className="task-detail__label">Status</span>
              <select
                className="task-form__select task-form__select--sm"
                value={task.status}
                onChange={(e) => {
                  const val = e.target.value
                  if ((ALL_STATUSES as readonly string[]).includes(val)) {
                    onUpdate({ status: val as TaskStatus })
                  }
                }}
                aria-label="Change status"
              >
                {Object.entries(STATUS_CONFIG).map(([key, cfg]) => (
                  <option key={key} value={key}>{cfg.icon} {cfg.label}</option>
                ))}
              </select>
            </div>
            <div className="task-detail__field">
              <span className="task-detail__label">Priority</span>
              <select
                className="task-form__select task-form__select--sm"
                value={task.priority}
                onChange={(e) => {
                  const val = e.target.value
                  if ((ALL_PRIORITIES as readonly string[]).includes(val)) {
                    onUpdate({ priority: val as TaskPriority })
                  }
                }}
                aria-label="Change priority"
              >
                {Object.entries(PRIORITY_CONFIG).map(([key, cfg]) => (
                  <option key={key} value={key}>{cfg.icon} {cfg.label}</option>
                ))}
              </select>
            </div>
            <div className="task-detail__field">
              <span className="task-detail__label">Assignee</span>
              <select
                className="task-form__select task-form__select--sm"
                value={task.assignee || ''}
                onChange={(e) => onUpdate({
                  assignee: (e.target.value as AgentType) || undefined,
                  autoAssigned: !e.target.value,
                })}
                aria-label="Change assignee"
              >
                <option value="">Unassigned</option>
                {AGENT_OPTIONS.map((a) => (
                  <option key={a} value={a}>{AGENT_CONFIG[a].emoji} @{a}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Description */}
          <div className="task-detail__section">
            <span className="task-detail__label">Description</span>
            <textarea
              className="task-form__textarea"
              value={localDesc}
              onChange={(e) => setLocalDesc(e.target.value)}
              onBlur={() => {
                if (localDesc !== (task.description || '')) {
                  onUpdate({ description: localDesc || undefined })
                }
              }}
              placeholder="Add a description..."
              rows={3}
            />
          </div>

          {/* Subtasks */}
          <div className="task-detail__section">
            <span className="task-detail__label">
              Subtasks
              {(task.subtasks?.length ?? 0) > 0 && (
                <span className="task-detail__subtask-count">
                  {task.subtasks?.filter((s) => s.done).length}/{task.subtasks?.length}
                </span>
              )}
            </span>
            <div className="task-detail__subtasks">
              {task.subtasks?.map((sub) => (
                <div key={sub.id} className={`task-detail__subtask ${sub.done ? 'task-detail__subtask--done' : ''}`}>
                  <input
                    type="checkbox"
                    checked={sub.done}
                    onChange={() => toggleSubtask(sub.id)}
                    aria-label={`${sub.done ? 'Uncheck' : 'Check'}: ${sub.title}`}
                  />
                  <span className="task-detail__subtask-title">{sub.title}</span>
                  <button
                    className="task-detail__subtask-remove"
                    onClick={() => removeSubtask(sub.id)}
                    aria-label={`Remove subtask: ${sub.title}`}
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
              <div className="task-detail__subtask-add">
                <input
                  type="text"
                  className="task-form__input task-form__input--sm"
                  value={newSubtask}
                  onChange={(e) => setNewSubtask(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      addSubtask()
                    }
                  }}
                  placeholder="Add subtask..."
                />
                <button
                  className="task-detail__subtask-add-btn"
                  onClick={addSubtask}
                  disabled={!newSubtask.trim()}
                  aria-label="Add subtask"
                >
                  <Plus size={14} />
                </button>
              </div>
            </div>
          </div>

          {/* History */}
          {task.history.length > 0 && (
            <div className="task-detail__section">
              <span className="task-detail__label">History</span>
              <div className="task-detail__history">
                {task.history.slice().reverse().map((event) => (
                  <div key={`${event.timestamp}-${event.type}`} className="task-detail__event">
                    <span className="task-detail__event-time">{formatTime(event.timestamp)}</span>
                    <span className="task-detail__event-text">
                      {event.type === 'created' && 'Task created'}
                      {event.type === 'status_changed' && `Status: ${event.from} → ${event.to}`}
                      {event.type === 'assigned' && `Assigned to @${event.to}`}
                      {event.type === 'comment' && event.message}
                    </span>
                    {event.agent && (
                      <span className="task-detail__event-agent">@{event.agent}</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Timestamps */}
          <div className="task-detail__timestamps">
            <span>Created {formatTime(task.createdAt)}</span>
            <span>Updated {formatTime(task.updatedAt)}</span>
            {task.completedAt && <span>Completed {formatTime(task.completedAt)}</span>}
          </div>
        </div>

        <div className="task-detail__footer">
          <button className="btn-danger-subtle" onClick={() => {
            if (window.confirm('Are you sure you want to delete this task? This cannot be undone.')) {
              onDelete()
            }
          }}>
            <Trash2 size={14} />
            Delete Task
          </button>
        </div>
      </aside>
    </div>
  )
}
