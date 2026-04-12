import { useState, useRef } from 'react'
import type { Task, TaskStatus } from './types'
import { KANBAN_COLUMNS } from './types'
import { TaskCard } from './TaskCard'
import { EmptyState } from './EmptyState'

interface KanbanViewProps {
  tasks: Task[]
  getTasksByStatus: (status: TaskStatus) => Task[]
  onMoveTask: (id: string, status: TaskStatus) => void
  onSelectTask: (task: Task) => void
}

export function KanbanView({ tasks, getTasksByStatus, onMoveTask, onSelectTask }: KanbanViewProps) {
  const [dragTaskId, setDragTaskId] = useState<string | null>(null)
  const [dragOverColumn, setDragOverColumn] = useState<TaskStatus | null>(null)

  const handleDragStart = (e: React.DragEvent, taskId: string) => {
    setDragTaskId(taskId)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', taskId)
  }

  const handleDragOver = (e: React.DragEvent, status: TaskStatus) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDragOverColumn(status)
  }

  const handleDragLeave = () => {
    setDragOverColumn(null)
  }

  const handleDrop = (e: React.DragEvent, status: TaskStatus) => {
    e.preventDefault()
    // Only trust internal drag state — ignore dataTransfer to prevent external spoofing
    const taskId = dragTaskId
    if (taskId) {
      onMoveTask(taskId, status)
    }
    setDragTaskId(null)
    setDragOverColumn(null)
  }

  const handleDragEnd = () => {
    setDragTaskId(null)
    setDragOverColumn(null)
  }

  // Keyboard-based column navigation
  const handleKeyboardMove = (e: React.KeyboardEvent, task: Task) => {
    if (!e.altKey) return
    const currentIdx = KANBAN_COLUMNS.findIndex((c) => c.status === task.status)
    if (e.key === 'ArrowRight' && currentIdx < KANBAN_COLUMNS.length - 1) {
      e.preventDefault()
      onMoveTask(task.id, KANBAN_COLUMNS[currentIdx + 1].status)
    } else if (e.key === 'ArrowLeft' && currentIdx > 0) {
      e.preventDefault()
      onMoveTask(task.id, KANBAN_COLUMNS[currentIdx - 1].status)
    }
  }

  return (
    <div className="kanban" role="region" aria-label="Kanban board">
      {KANBAN_COLUMNS.map((col) => {
        const columnTasks = getTasksByStatus(col.status)
        const isOver = dragOverColumn === col.status

        return (
          <div
            key={col.status}
            className={`kanban__column ${isOver ? 'kanban__column--drag-over' : ''}`}
            onDragOver={(e) => handleDragOver(e, col.status)}
            onDragLeave={handleDragLeave}
            onDrop={(e) => handleDrop(e, col.status)}
            role="list"
            aria-label={`${col.label} column, ${columnTasks.length} tasks`}
          >
            <div className="kanban__column-header">
              <span
                className="kanban__column-dot"
                style={{ background: col.color }}
                aria-hidden="true"
              />
              <span className="kanban__column-label">{col.label}</span>
              <span className="kanban__column-count">{columnTasks.length}</span>
            </div>

            <div className="kanban__column-body">
              {columnTasks.length === 0 ? (
                <EmptyState columnLabel={col.label} />
              ) : (
                columnTasks.map((task) => (
                  <div
                    key={task.id}
                    draggable
                    onDragStart={(e) => handleDragStart(e, task.id)}
                    onDragEnd={handleDragEnd}
                    onKeyDown={(e) => handleKeyboardMove(e, task)}
                    role="listitem"
                  >
                    <TaskCard
                      task={task}
                      onSelect={() => onSelectTask(task)}
                      onStatusChange={(status) => onMoveTask(task.id, status)}
                      isDragging={dragTaskId === task.id}
                    />
                  </div>
                ))
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
