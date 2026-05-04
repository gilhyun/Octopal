import { describe, it, expect } from 'vitest'
import { groupTasksByStatus, getTasksForStatus, VALID_TRANSITIONS } from './useTaskBoard'
import type { Task, TaskStatus } from './types'
import { ALL_STATUSES, KANBAN_COLUMNS } from './types'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTask(overrides: Partial<Task> & { status: TaskStatus }): Task {
  const { status, ...rest } = overrides
  return {
    id: `task-${Math.random().toString(36).slice(2)}`,
    title: 'Test task',
    status,
    priority: 'medium',
    autoAssigned: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    history: [{ timestamp: Date.now(), type: 'created' }],
    ...rest,
  }
}

// ---------------------------------------------------------------------------
// groupTasksByStatus
// ---------------------------------------------------------------------------

describe('groupTasksByStatus', () => {
  it('returns empty object when given no tasks', () => {
    const result = groupTasksByStatus([])
    expect(result).toEqual({})
  })

  it('groups tasks correctly by status', () => {
    const tasks = [
      makeTask({ status: 'pending' }),
      makeTask({ status: 'active' }),
      makeTask({ status: 'pending' }),
      makeTask({ status: 'done' }),
    ]

    const grouped = groupTasksByStatus(tasks)

    expect(grouped.pending).toHaveLength(2)
    expect(grouped.active).toHaveLength(1)
    expect(grouped.done).toHaveLength(1)
  })

  it('preserves insertion order within each group', () => {
    const t1 = makeTask({ status: 'active', title: 'First' })
    const t2 = makeTask({ status: 'active', title: 'Second' })
    const t3 = makeTask({ status: 'active', title: 'Third' })

    const grouped = groupTasksByStatus([t1, t2, t3])

    expect(grouped.active![0].title).toBe('First')
    expect(grouped.active![1].title).toBe('Second')
    expect(grouped.active![2].title).toBe('Third')
  })

  it('does NOT create keys for statuses with zero tasks', () => {
    const tasks = [makeTask({ status: 'pending' })]
    const grouped = groupTasksByStatus(tasks)

    // Only 'pending' should be a key
    expect(Object.keys(grouped)).toEqual(['pending'])
    expect(grouped.active).toBeUndefined()
    expect(grouped.review).toBeUndefined()
    expect(grouped.testing).toBeUndefined()
    expect(grouped.done).toBeUndefined()
    expect(grouped.blocked).toBeUndefined()
  })

  it('handles all 6 statuses simultaneously', () => {
    const tasks = ALL_STATUSES.map((status) => makeTask({ status }))
    const grouped = groupTasksByStatus(tasks)

    for (const status of ALL_STATUSES) {
      expect(grouped[status]).toHaveLength(1)
    }
  })

  it('handles large number of tasks without error', () => {
    const tasks = Array.from({ length: 1000 }, (_, i) =>
      makeTask({ status: ALL_STATUSES[i % ALL_STATUSES.length] }),
    )
    const grouped = groupTasksByStatus(tasks)
    const total = Object.values(grouped).reduce((sum, arr) => sum + arr!.length, 0)
    expect(total).toBe(1000)
  })

  it('returns same task references (no cloning)', () => {
    const original = makeTask({ status: 'testing' })
    const grouped = groupTasksByStatus([original])
    expect(grouped.testing![0]).toBe(original)
  })
})

// ---------------------------------------------------------------------------
// getTasksForStatus — the ?? [] fallback path
// ---------------------------------------------------------------------------

describe('getTasksForStatus', () => {
  it('returns the task array when status has tasks', () => {
    const tasks = [makeTask({ status: 'review' }), makeTask({ status: 'review' })]
    const grouped = groupTasksByStatus(tasks)

    const result = getTasksForStatus(grouped, 'review')
    expect(result).toHaveLength(2)
    expect(result).toBe(grouped.review) // same reference — no unnecessary allocation
  })

  it('returns empty array (fallback) when status key is missing from empty map', () => {
    const grouped = groupTasksByStatus([])

    for (const status of ALL_STATUSES) {
      const result = getTasksForStatus(grouped, status)
      expect(result).toEqual([])
      expect(Array.isArray(result)).toBe(true)
    }
  })

  it('returns empty array for statuses not present in partial map', () => {
    const grouped = groupTasksByStatus([makeTask({ status: 'pending' })])

    // These statuses have no tasks → should fallback to []
    expect(getTasksForStatus(grouped, 'active')).toEqual([])
    expect(getTasksForStatus(grouped, 'testing')).toEqual([])
    expect(getTasksForStatus(grouped, 'blocked')).toEqual([])
    expect(getTasksForStatus(grouped, 'done')).toEqual([])
    expect(getTasksForStatus(grouped, 'review')).toEqual([])
  })

  it('every KANBAN_COLUMNS status returns an array (never undefined)', () => {
    // Critical: KanbanView iterates KANBAN_COLUMNS and calls getTasksByStatus(col.status).
    // It must NEVER get undefined.
    const grouped = groupTasksByStatus([])

    for (const col of KANBAN_COLUMNS) {
      const result = getTasksForStatus(grouped, col.status)
      expect(result).toBeDefined()
      expect(Array.isArray(result)).toBe(true)
    }
  })

  it('fallback [] is a new array each call (safe to mutate)', () => {
    const grouped = groupTasksByStatus([])
    const a = getTasksForStatus(grouped, 'active')
    const b = getTasksForStatus(grouped, 'active')
    // ?? [] creates a new literal each time — they should NOT be the same ref
    expect(a).not.toBe(b)
  })
})

// ---------------------------------------------------------------------------
// KANBAN_COLUMNS coverage — all 6 statuses present
// ---------------------------------------------------------------------------

describe('KANBAN_COLUMNS covers all TaskStatus values', () => {
  it('includes all 6 statuses', () => {
    const columnStatuses = KANBAN_COLUMNS.map((c) => c.status).sort()
    const allStatuses = [...ALL_STATUSES].sort()
    expect(columnStatuses).toEqual(allStatuses)
  })

  it('has no duplicate statuses', () => {
    const statuses = KANBAN_COLUMNS.map((c) => c.status)
    expect(new Set(statuses).size).toBe(statuses.length)
  })
})

// ---------------------------------------------------------------------------
// VALID_TRANSITIONS — transition map integrity
// ---------------------------------------------------------------------------

describe('VALID_TRANSITIONS', () => {
  it('has an entry for every TaskStatus', () => {
    for (const status of ALL_STATUSES) {
      expect(VALID_TRANSITIONS[status]).toBeDefined()
      expect(Array.isArray(VALID_TRANSITIONS[status])).toBe(true)
    }
  })

  it('all target statuses are valid TaskStatus values', () => {
    for (const [from, targets] of Object.entries(VALID_TRANSITIONS)) {
      for (const to of targets) {
        expect(ALL_STATUSES).toContain(to)
      }
    }
  })

  it('no status transitions to itself', () => {
    for (const [from, targets] of Object.entries(VALID_TRANSITIONS)) {
      expect(targets).not.toContain(from)
    }
  })

  it('happy path: pending → active → review → testing → done is valid', () => {
    expect(VALID_TRANSITIONS.pending).toContain('active')
    expect(VALID_TRANSITIONS.active).toContain('review')
    expect(VALID_TRANSITIONS.review).toContain('testing')
    expect(VALID_TRANSITIONS.testing).toContain('done')
  })

  it('blocked can be entered from active, review, testing', () => {
    expect(VALID_TRANSITIONS.active).toContain('blocked')
    expect(VALID_TRANSITIONS.review).toContain('blocked')
    expect(VALID_TRANSITIONS.testing).toContain('blocked')
  })

  it('blocked exits to pending or active (not directly to done)', () => {
    expect(VALID_TRANSITIONS.blocked).toContain('pending')
    expect(VALID_TRANSITIONS.blocked).toContain('active')
    expect(VALID_TRANSITIONS.blocked).not.toContain('done')
  })

  it('done can reopen to active', () => {
    expect(VALID_TRANSITIONS.done).toContain('active')
  })

  it('pending cannot jump to done (must go through pipeline)', () => {
    expect(VALID_TRANSITIONS.pending).not.toContain('done')
  })
})
