export interface Attachment {
  id: string
  type: 'image' | 'text'
  filename: string
  path: string           // .runechat/uploads/ 내 상대경로
  mimeType: string
  size: number
  previewUrl?: string    // 전송 전 미리보기용 object URL
}

export interface PendingHandoff {
  targets: string[]          // agent names the speaker mentioned
  approved?: boolean         // undefined = waiting, true = approved (chain kicked off), false = dismissed
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
}

export interface ActivityLogEntry {
  id: string
  agentName: string
  tool: string        // 'Write' | 'Edit' | 'Bash' | 'WebFetch'
  target: string      // file path, command, url...
  ts: number
}
