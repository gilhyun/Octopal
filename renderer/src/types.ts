export interface Attachment {
  id: string
  type: 'image' | 'text'
  filename: string
  path: string           // .octopal/uploads/ 내 상대경로
  mimeType: string
  size: number
  previewUrl?: string    // 전송 전 미리보기용 object URL
  isPastedText?: boolean // true if created from a long-paste action
}

export interface PendingHandoff {
  targets: string[]          // agent names the speaker mentioned
  approved?: boolean         // undefined = waiting, true = approved (chain kicked off), false = dismissed
}

export interface InterruptConfirm {
  runningAgents: string[]    // names of agents currently working
  confirmed?: boolean        // undefined = waiting, true = confirmed, false = cancelled
}

export interface PermissionRequest {
  permissions: Array<'fileWrite' | 'bash' | 'network'>  // which permissions the agent needs
  granted?: boolean          // undefined = waiting, true = granted, false = dismissed
  agentPath?: string         // path to the .octo file to update
}

export interface AgentRecommendation {
  name: string
  role: string
  prompt?: string
  icon?: string
  color?: string
}

export interface AgentProposal {
  agents: AgentRecommendation[]
  approved?: boolean          // undefined = waiting, true = created, false = dismissed
  created?: string[]          // names created by the approval action
  error?: string
}

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
  costUsd?: number
  durationMs?: number
  model?: string
}

export interface Message {
  id: string
  agentName: string | 'user'
  text: string
  ts: number
  pending?: boolean
  error?: boolean
  activity?: string
  attachments?: Attachment[]
  handoff?: PendingHandoff    // set when this agent's message proposes calling others
  permissionRequest?: PermissionRequest  // set when agent needs permissions to fulfill user's request
  agentProposal?: AgentProposal  // set when onboarding analysis recommends creating teammates
  usage?: TokenUsage          // token usage for this agent response
  dispatcherAgents?: string[] // agent names shown in routing indicator (slot-machine effect)
  interruptConfirm?: InterruptConfirm  // set when user tries to interrupt multi-agent work
}

export interface LockHolder {
  runId: string
  agentName: string
  acquiredAtMs: number
}

export interface ActivityLogEntry {
  id: string
  agentName: string
  tool: string        // 'Write' | 'Edit' | 'Bash' | 'WebFetch'
  target: string      // file path, command, url...
  ts: number
  /// Set when a Write/Edit was snapshotted — points at .octopal/backups/<id>/.
  backupId?: string
  /// Set when another running agent already held the file at the time of write.
  conflictWith?: LockHolder
}

export interface BackupFileEntry {
  path: string        // relative to workspace folder
  existed: boolean    // false = agent created the file, revert deletes
}

export interface BackupMeta {
  id: string
  runId: string
  agentName: string
  ts: number
  folderPath: string
  files: BackupFileEntry[]
}
