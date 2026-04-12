import { useState, useCallback, useEffect, useMemo } from 'react'
import type { Task, TaskStatus, TaskPriority, AgentType, TaskEvent } from './types'
import { ALL_STATUSES } from './types'

const STORAGE_KEY = 'octopal-tasks'

const VALID_PRIORITIES: readonly string[] = ['high', 'medium', 'low']

/** Allowed status transitions — keys are current status, values are reachable statuses */
export const VALID_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  pending: ['active', 'blocked'],
  active: ['review', 'testing', 'blocked', 'done'],
  review: ['active', 'testing', 'blocked', 'done'],
  testing: ['active', 'review', 'blocked', 'done'],
  blocked: ['pending', 'active'],
  done: ['active'],  // reopen
}

function generateId(): string {
  return `task-${crypto.randomUUID()}`
}

/** Minimal runtime type guard — rejects poisoned / malformed task objects */
function isValidTask(t: unknown): t is Task {
  if (typeof t !== 'object' || t === null || Array.isArray(t)) return false
  const obj = t as Record<string, unknown>
  return (
    typeof obj.id === 'string' &&
    typeof obj.title === 'string' &&
    typeof obj.status === 'string' && (ALL_STATUSES as readonly string[]).includes(obj.status) &&
    typeof obj.priority === 'string' && VALID_PRIORITIES.includes(obj.priority) &&
    typeof obj.createdAt === 'number' &&
    typeof obj.updatedAt === 'number' &&
    Array.isArray(obj.history)
  )
}

function loadTasks(): Task[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return [] // reject non-array payloads
    return parsed.filter(isValidTask)
  } catch {
    return []
  }
}

function saveTasks(tasks: Task[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks))
}

/** Group tasks by status — exported for testability */
export function groupTasksByStatus(tasks: Task[]): Partial<Record<TaskStatus, Task[]>> {
  const map: Partial<Record<TaskStatus, Task[]>> = Object.create(null)
  for (const t of tasks) {
    if (!(ALL_STATUSES as readonly string[]).includes(t.status)) continue // reject invalid statuses
    ;(map[t.status] ??= []).push(t)
  }
  return map
}

/** Get tasks for a given status with empty-array fallback */
export function getTasksForStatus(
  grouped: Partial<Record<TaskStatus, Task[]>>,
  status: TaskStatus,
): Task[] {
  return grouped[status] ?? []
}

export function useTaskBoard() {
  const [tasks, setTasks] = useState<Task[]>(loadTasks)

  // Persist on change
  useEffect(() => {
    saveTasks(tasks)
  }, [tasks])

  const createTask = useCallback((input: Omit<Task, 'id' | 'createdAt' | 'updatedAt' | 'history'>) => {
    const now = Date.now()
    const event: TaskEvent = {
      timestamp: now,
      type: 'created',
    }
    const task: Task = {
      ...input,
      id: generateId(),
      createdAt: now,
      updatedAt: now,
      history: [event],
    }
    setTasks((prev) => [task, ...prev])
    return task
  }, [])

  const updateTask = useCallback((id: string, updates: Partial<Task>) => {
    setTasks((prev) =>
      prev.map((t) => {
        if (t.id !== id) return t
        const now = Date.now()
        const events: TaskEvent[] = []

        // Validate status transition — reject invalid moves
        if (updates.status && updates.status !== t.status) {
          if (!VALID_TRANSITIONS[t.status]?.includes(updates.status)) {
            console.warn(`Invalid transition: ${t.status} → ${updates.status}`)
            return t // reject the entire update
          }
          events.push({
            timestamp: now,
            type: 'status_changed',
            from: t.status,
            to: updates.status,
          })
        }
        if (updates.assignee && updates.assignee !== t.assignee) {
          events.push({
            timestamp: now,
            type: 'assigned',
            to: updates.assignee,
          })
        }

        return {
          ...t,
          ...updates,
          updatedAt: now,
          completedAt: updates.status === 'done' ? now : updates.status ? undefined : t.completedAt,
          history: [...t.history, ...events],
        }
      }),
    )
  }, [])

  const deleteTask = useCallback((id: string) => {
    setTasks((prev) => prev.filter((t) => t.id !== id))
  }, [])

  const moveTask = useCallback((id: string, newStatus: TaskStatus) => {
    updateTask(id, { status: newStatus })
  }, [updateTask])

  // Pre-group tasks by status to avoid repeated filtering per column
  const tasksByStatus = useMemo(() => groupTasksByStatus(tasks), [tasks])

  const getTasksByStatus = useCallback(
    (status: TaskStatus) => tasksByStatus[status] ?? [],
    [tasksByStatus],
  )

  return {
    tasks,
    createTask,
    updateTask,
    deleteTask,
    moveTask,
    getTasksByStatus,
  }
}
