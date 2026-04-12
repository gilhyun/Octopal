import { useState, useEffect, useCallback } from 'react'
import { Plus, LayoutGrid } from 'lucide-react'
import { KanbanView } from './KanbanView'
import { TaskCreateForm } from './TaskCreateForm'
import { TaskDetail } from './TaskDetail'
import { EmptyState } from './EmptyState'
import { useTaskBoard } from './useTaskBoard'
import type { Task } from './types'

export function TaskBoard() {
  const { tasks, createTask, updateTask, deleteTask, moveTask, getTasksByStatus } = useTaskBoard()
  const [showCreateForm, setShowCreateForm] = useState(false)
  const [selectedTask, setSelectedTask] = useState<Task | null>(null)

  // Keep selectedTask in sync with tasks array
  const selectedId = selectedTask?.id ?? null
  useEffect(() => {
    if (selectedId) {
      const updated = tasks.find((t) => t.id === selectedId)
      if (updated) setSelectedTask(updated)
      else setSelectedTask(null) // deleted
    }
  }, [tasks, selectedId])

  // Global hotkey: N to open create form
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't trigger if typing in an input/textarea
      const tag = (e.target as HTMLElement).tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return

      if (e.key === 'n' || e.key === 'N') {
        if (!showCreateForm && !selectedTask) {
          e.preventDefault()
          setShowCreateForm(true)
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [showCreateForm, selectedTask])

  const handleDelete = useCallback(() => {
    if (selectedTask) {
      deleteTask(selectedTask.id)
      setSelectedTask(null)
    }
  }, [selectedTask, deleteTask])

  return (
    <div className="task-board">
      <div className="task-board__toolbar">
        <div className="task-board__toolbar-left">
          <LayoutGrid size={18} />
          <h2 className="task-board__heading">Task Board</h2>
          <span className="task-board__task-count">{tasks.length} tasks</span>
        </div>
        <div className="task-board__toolbar-right">
          <button
            className="btn-primary task-board__add-btn"
            onClick={() => setShowCreateForm(true)}
          >
            <Plus size={14} />
            New Task
            <kbd className="task-board__kbd">N</kbd>
          </button>
        </div>
      </div>

      {tasks.length === 0 ? (
        <EmptyState isBoard />
      ) : (
        <KanbanView
          tasks={tasks}
          getTasksByStatus={getTasksByStatus}
          onMoveTask={moveTask}
          onSelectTask={setSelectedTask}
        />
      )}

      {showCreateForm && (
        <TaskCreateForm
          onSubmit={createTask}
          onClose={() => setShowCreateForm(false)}
        />
      )}

      {selectedTask && (
        <TaskDetail
          task={selectedTask}
          onClose={() => setSelectedTask(null)}
          onUpdate={(updates) => updateTask(selectedTask.id, updates)}
          onDelete={handleDelete}
        />
      )}
    </div>
  )
}
