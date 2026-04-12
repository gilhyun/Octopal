// Task Board — Data Model & Type Definitions

export type TaskStatus = 'pending' | 'active' | 'review' | 'testing' | 'done' | 'blocked'
export type TaskPriority = 'high' | 'medium' | 'low'
export type AgentType = 'developer' | 'designer' | 'reviewer' | 'tester' | 'security' | 'assistant' | 'planner'

export interface SubTask {
  id: string
  title: string
  done: boolean
}

export interface TaskEvent {
  timestamp: number
  type: 'created' | 'status_changed' | 'assigned' | 'comment'
  agent?: AgentType
  from?: string
  to?: string
  message?: string
}

export interface Task {
  id: string
  title: string
  description?: string
  status: TaskStatus
  priority: TaskPriority
  assignee?: AgentType
  autoAssigned: boolean
  subtasks?: SubTask[]
  createdAt: number
  updatedAt: number
  completedAt?: number
  history: TaskEvent[]
}

// Column definition for Kanban
export interface KanbanColumn {
  status: TaskStatus
  label: string
  color: string
}

export const KANBAN_COLUMNS: KanbanColumn[] = [
  { status: 'pending', label: 'Pending', color: '#6B7280' },
  { status: 'active', label: 'Active', color: '#3B82F6' },
  { status: 'review', label: 'Review', color: '#8B5CF6' },
  { status: 'testing', label: 'Testing', color: '#F59E0B' },
  { status: 'blocked', label: 'Blocked', color: '#EF4444' },
  { status: 'done', label: 'Done', color: '#10B981' },
]

export const ALL_STATUSES: TaskStatus[] = ['pending', 'active', 'review', 'testing', 'done', 'blocked']
export const ALL_PRIORITIES: TaskPriority[] = ['high', 'medium', 'low']

export const STATUS_CONFIG: Record<TaskStatus, { label: string; color: string; icon: string }> = {
  pending: { label: 'Pending', color: '#6B7280', icon: '⏳' },
  active: { label: 'Active', color: '#3B82F6', icon: '🔵' },
  review: { label: 'Review', color: '#8B5CF6', icon: '🟣' },
  testing: { label: 'Testing', color: '#F59E0B', icon: '🟡' },
  done: { label: 'Done', color: '#10B981', icon: '✅' },
  blocked: { label: 'Blocked', color: '#EF4444', icon: '🔴' },
}

export const PRIORITY_CONFIG: Record<TaskPriority, { label: string; color: string; icon: string }> = {
  high: { label: 'High', color: '#EF4444', icon: '🔴' },
  medium: { label: 'Medium', color: '#F59E0B', icon: '🟡' },
  low: { label: 'Low', color: '#10B981', icon: '🟢' },
}

export const AGENT_OPTIONS: AgentType[] = ['developer', 'designer', 'reviewer', 'tester', 'security', 'assistant', 'planner']

export const AGENT_CONFIG: Record<AgentType, { label: string; emoji: string; color: string }> = {
  developer: { label: 'Developer', emoji: '👨‍💻', color: '#3B82F6' },
  designer: { label: 'Designer', emoji: '🎨', color: '#EC4899' },
  reviewer: { label: 'Reviewer', emoji: '🔍', color: '#8B5CF6' },
  tester: { label: 'Tester', emoji: '🧪', color: '#10B981' },
  security: { label: 'Security', emoji: '🛡️', color: '#EF4444' },
  assistant: { label: 'Assistant', emoji: '🤖', color: '#6B7280' },
  planner: { label: 'Planner', emoji: '📋', color: '#F59E0B' },
}
