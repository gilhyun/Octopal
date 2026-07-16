import { useState, useCallback, useEffect, useMemo } from 'react'
import type { Task, TaskStatus, TaskPriority, AgentType, TaskEvent } from './types'
import { ALL_STATUSES } from './types'

const STORAGE_KEY = 'octopal-tasks'

const VALID_PRIORITIES: readonly string[] = ['high', 'medium', 'low']
const VALID_AGENTS: readonly string[] = ['developer', 'designer', 'reviewer', 'tester', 'security', 'assistant', 'planner']
const VALID_EVENT_TYPES: readonly string[] = ['created', 'status_changed', 'assigned', 'comment']

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string'
}

function isValidSubtask(value: unknown): boolean {
  if (!isRecord(value)) return false
  return typeof value.id === 'string'
    && typeof value.title === 'string'
    && typeof value.done === 'boolean'
}

function isValidTaskEvent(value: unknown): boolean {
  if (!isRecord(value)) return false
  return typeof value.timestamp === 'number'
    && Number.isFinite(value.timestamp)
    && typeof value.type === 'string'
    && VALID_EVENT_TYPES.includes(value.type)
    && (value.agent === undefined || (typeof value.agent === 'string' && VALID_AGENTS.includes(value.agent)))
    && isOptionalString(value.from)
    && isOptionalString(value.to)
    && isOptionalString(value.message)
}

/** Full runtime guard for the untrusted localStorage boundary. */
export function isValidTask(t: unknown): t is Task {
  if (!isRecord(t)) return false
  const obj = t
  return (
    typeof obj.id === 'string' &&
    typeof obj.title === 'string' &&
    typeof obj.status === 'string' && (ALL_STATUSES as readonly string[]).includes(obj.status) &&
    typeof obj.priority === 'string' && VALID_PRIORITIES.includes(obj.priority) &&
    typeof obj.autoAssigned === 'boolean' &&
    typeof obj.createdAt === 'number' && Number.isFinite(obj.createdAt) &&
    typeof obj.updatedAt === 'number' && Number.isFinite(obj.updatedAt) &&
    (obj.completedAt === undefined || (typeof obj.completedAt === 'number' && Number.isFinite(obj.completedAt))) &&
    isOptionalString(obj.description) &&
    (obj.assignee === undefined || (typeof obj.assignee === 'string' && VALID_AGENTS.includes(obj.assignee))) &&
    (obj.subtasks === undefined || (Array.isArray(obj.subtasks) && obj.subtasks.every(isValidSubtask))) &&
    Array.isArray(obj.history) && obj.history.every(isValidTaskEvent)
  )
}

export function loadTasks(): Task[] {
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
