export const AGENT_COLORS = [
  '#B0A080',  // Sand         (warm primary)
  '#8AA898',  // Sage         (earthy green)
  '#A89888',  // Clay         (warm neutral)
  '#90A8A0',  // Eucalyptus   (muted green)
  '#C0A878',  // Amber        (warm gold)
  '#98A0B0',  // Stone Blue   (cool accent)
  '#A8B090',  // Olive        (earthy)
]

export function colorForName(name: string | undefined | null) {
  const s = name || '?'
  let hash = 0
  for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) | 0
  return AGENT_COLORS[Math.abs(hash) % AGENT_COLORS.length]
}

export function basename(p: string) {
  return p.split('/').filter(Boolean).pop() || p
}

/**
 * Merge disk-loaded history with in-memory pending messages.
 * Pending messages (agent working indicators) only exist in memory,
 * so they would be lost when history is reloaded from disk on folder switch.
 * This function preserves them by appending any pending messages
 * whose IDs are not already present in the loaded history.
 */
export function mergeWithPending<T extends { id: string; pending?: boolean }>(
  loaded: T[],
  existing: T[],
): T[] {
  const pendingMessages = existing.filter((m) => m.pending)
  const loadedIds = new Set(loaded.map((m) => m.id))
  const missingPending = pendingMessages.filter((m) => !loadedIds.has(m.id))
  return [...loaded, ...missingPending]
}
