import { afterEach, describe, expect, it } from 'vitest'
import { isValidTask, loadTasks } from './useTaskBoard'

const validTask = {
  id: 'task-1',
  title: 'Audit nested data',
  status: 'pending',
  priority: 'medium',
  autoAssigned: false,
  subtasks: [{ id: 'sub-1', title: 'Validate', done: false }],
  createdAt: 1,
  updatedAt: 1,
  history: [{ timestamp: 1, type: 'created' }],
}

afterEach(() => localStorage.clear())

describe('loadTasks runtime validation', () => {
  it('loads a fully valid task through the real localStorage loader', () => {
    localStorage.setItem('octopal-tasks', JSON.stringify([validTask]))
    expect(loadTasks()).toEqual([validTask])
  })

  it('filters malformed nested history and subtask entries', () => {
    localStorage.setItem('octopal-tasks', JSON.stringify([
      validTask,
      { ...validTask, id: 'bad-history-null', history: [null] },
      { ...validTask, id: 'bad-history-type', history: [{ timestamp: 1, type: 'execute_script' }] },
      { ...validTask, id: 'bad-subtask', subtasks: [{ id: 'sub', title: 'oops', done: 'yes' }] },
    ]))

    expect(loadTasks().map((task) => task.id)).toEqual(['task-1'])
  })

  it('rejects invalid optional fields and non-finite timestamps', () => {
    expect(isValidTask({ ...validTask, assignee: 'root' })).toBe(false)
    expect(isValidTask({ ...validTask, description: { html: '<script>' } })).toBe(false)
    expect(isValidTask({ ...validTask, updatedAt: Number.POSITIVE_INFINITY })).toBe(false)
  })
})
