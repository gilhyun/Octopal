import type { Attachment, PermissionRequest } from './types'

interface AgentRef {
  name: string
  path?: string
}

export function buildBufferedPrompt(
  messages: Array<{ text: string; ts: number; attachments?: Attachment[] }>,
): string {
  return messages.length === 1
    ? messages[0].text
    : messages.map((m, i) => `(${i + 1}) ${m.text}`).join('\n')
}

export function parseMentions(text: string): string[] {
  const re = /@([\w\p{L}\p{N}_-]+)/gu
  const found: string[] = []
  let m
  while ((m = re.exec(text)) !== null) found.push(m[1])
  return found
}

export function parsePermissionRequest(
  text: string,
  agentName: string,
  agents: AgentRef[],
): PermissionRequest | undefined {
  const re = /<!--NEEDS_PERMISSIONS:\s*([\w\s,]+)-->/
  const match = re.exec(text)
  if (!match) return undefined
  const validKeys = ['fileWrite', 'bash', 'network'] as const
  const permissions = match[1]
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is 'fileWrite' | 'bash' | 'network' =>
      validKeys.includes(s as any),
    )
  if (permissions.length === 0) return undefined
  const agent = agents.find(
    (o) => o.name.toLowerCase() === agentName.toLowerCase(),
  )
  return { permissions, agentPath: agent?.path }
}

export function parseHandoffTags(text: string): Array<{ target: string; reason: string }> {
  const re = /<HANDOFF\s+target\s*=\s*"([^"]+)"(?:\s+reason\s*=\s*"([^"]*)")?\s*\/?>/gi
  const out: Array<{ target: string; reason: string }> = []
  let m
  while ((m = re.exec(text)) !== null) {
    out.push({ target: m[1].trim(), reason: (m[2] || '').trim() })
  }
  return out
}

function stripPermissionTag(text: string): string {
  return text.replace(/<!--NEEDS_PERMISSIONS:\s*[\w\s,]+-->/g, '').trim()
}

function stripHandoffTags(text: string): string {
  return text.replace(/<HANDOFF\s+target\s*=\s*"[^"]+"(?:\s+reason\s*=\s*"[^"]*")?\s*\/?>/gi, '').trim()
}

export function sanitizeDisplayText(text: string): string {
  return stripHandoffTags(stripPermissionTag(text))
}
