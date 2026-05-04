import type { AgentRecommendation, Attachment, PermissionRequest } from './types'

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

export function parseAgentRecommendations(text: string): AgentRecommendation[] {
  const match = /<!--AGENT_RECOMMENDATIONS:\s*([\s\S]*?)-->/.exec(text)
  if (!match) return []

  let parsed: unknown
  try {
    parsed = JSON.parse(match[1].trim())
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []

  const seen = new Set<string>()
  const out: AgentRecommendation[] = []
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue
    const rec = item as Record<string, unknown>
    const name = typeof rec.name === 'string' ? rec.name.trim() : ''
    const role = typeof rec.role === 'string' ? rec.role.trim() : ''
    if (!name || !role) continue
    const normalized = name.toLowerCase()
    if (seen.has(normalized)) continue
    seen.add(normalized)
    out.push({
      name,
      role,
      ...(typeof rec.prompt === 'string' && rec.prompt.trim()
        ? { prompt: rec.prompt.trim() }
        : {}),
      ...(typeof rec.icon === 'string' && rec.icon.trim()
        ? { icon: rec.icon.trim() }
        : {}),
      ...(typeof rec.color === 'string' && rec.color.trim()
        ? { color: rec.color.trim() }
        : {}),
    })
    if (out.length >= 4) break
  }
  return out
}

function stripPermissionTag(text: string): string {
  return text.replace(/<!--NEEDS_PERMISSIONS:\s*[\w\s,]+-->/g, '').trim()
}

function stripHandoffTags(text: string): string {
  return text.replace(/<HANDOFF\s+target\s*=\s*"[^"]+"(?:\s+reason\s*=\s*"[^"]*")?\s*\/?>/gi, '').trim()
}

function stripAgentRecommendations(text: string): string {
  return text.replace(/<!--AGENT_RECOMMENDATIONS:\s*[\s\S]*?-->/g, '').trim()
}

export function sanitizeDisplayText(text: string): string {
  return stripAgentRecommendations(stripHandoffTags(stripPermissionTag(text)))
}
