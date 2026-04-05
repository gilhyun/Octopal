export const AGENT_COLORS = ['#7c9cff', '#8ce99a', '#ffa94d', '#ff8ab0', '#b197fc', '#ffd43b', '#63e6be']

export function colorForName(name: string) {
  let hash = 0
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0
  return AGENT_COLORS[Math.abs(hash) % AGENT_COLORS.length]
}

export function basename(p: string) {
  return p.split('/').filter(Boolean).pop() || p
}
