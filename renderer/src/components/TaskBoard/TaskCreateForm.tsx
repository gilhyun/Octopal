import { useState, useRef, useEffect } from 'react'
import { X } from 'lucide-react'
import type { Task, TaskPriority, AgentType } from './types'
import { PRIORITY_CONFIG, AGENT_CONFIG, AGENT_OPTIONS } from './types'

interface TaskCreateFormProps {
  onSubmit: (task: Omit<Task, 'id' | 'createdAt' | 'updatedAt' | 'history'>) => void
  onClose: () => void
}

export function TaskCreateForm({ onSubmit, onClose }: TaskCreateFormProps) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [priority, setPriority] = useState<TaskPriority>('medium')
  const [assignee, setAssignee] = useState<AgentType | ''>('')
  const titleRef = useRef<HTMLInputElement>(null)

  // Auto-focus title on mount
  useEffect(() => {
    titleRef.current?.focus()
  }, [])

  // Cmd+Enter to submit
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      handleSubmit()
    }
    if (e.key === 'Escape') {
      onClose()
    }
  }

  const handleSubmit = () => {
    if (!title.trim()) return
    onSubmit({
      title: title.trim(),
      description: description.trim() || undefined,
      status: 'pending',
      priority,
      assignee: assignee || undefined,
      autoAssigned: !assignee,
      subtasks: [],
    })
    onClose()
  }

  return (
    <div className="task-form-backdrop" onClick={onClose} role="dialog" aria-modal="true" aria-label="Create new task">
      <div
        className="task-form"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div className="task-form__header">
          <h3 className="task-form__title">New Task</h3>
          <button className="task-form__close" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <div className="task-form__body">
          <div className="task-form__field">
            <label className="task-form__label" htmlFor="task-title">
              Title <span className="task-form__required">*</span>
            </label>
            <input
              ref={titleRef}
              id="task-title"
              className="task-form__input"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="What needs to be done?"
              autoComplete="off"
            />
          </div>

          <div className="task-form__field">
            <label className="task-form__label" htmlFor="task-desc">Description</label>
            <textarea
              id="task-desc"
              className="task-form__textarea"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Add details, context, or acceptance criteria..."
              rows={3}
            />
          </div>

          <div className="task-form__row">
            <div className="task-form__field">
              <label className="task-form__label">Priority</label>
              <div className="task-form__priority-group" role="radiogroup" aria-label="Task priority">
                {(Object.keys(PRIORITY_CONFIG) as TaskPriority[]).map((p) => (
                  <button
                    key={p}
                    type="button"
                    className={`task-form__priority-btn ${priority === p ? 'task-form__priority-btn--active' : ''}`}
                    onClick={() => setPriority(p)}
                    role="radio"
                    aria-checked={priority === p}
                    style={{ '--priority-color': PRIORITY_CONFIG[p].color } as React.CSSProperties}
                  >
                    <span aria-hidden="true">{PRIORITY_CONFIG[p].icon}</span>
                    {PRIORITY_CONFIG[p].label}
                  </button>
                ))}
              </div>
            </div>

            <div className="task-form__field">
              <label className="task-form__label" htmlFor="task-assignee">Assignee</label>
              <select
                id="task-assignee"
                className="task-form__select"
                value={assignee}
                onChange={(e) => setAssignee(e.target.value as AgentType | '')}
              >
                <option value="">Auto-assign ✨</option>
                {AGENT_OPTIONS.map((a) => (
                  <option key={a} value={a}>
                    {AGENT_CONFIG[a].emoji} @{a}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>

        <div className="task-form__actions">
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button
            className="btn-primary"
            onClick={handleSubmit}
            disabled={!title.trim()}
          >
            Create Task
            <kbd className="task-form__shortcut">⌘↵</kbd>
          </button>
        </div>
      </div>
    </div>
  )
}
