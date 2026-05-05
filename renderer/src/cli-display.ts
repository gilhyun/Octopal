export function cliDisplayName(binaryName: string): string {
  if (!binaryName) return ''
  switch (binaryName) {
    case 'claude':
      return 'Claude CLI'
    case 'codex':
      return 'Codex CLI'
    default:
      return `${binaryName} CLI`
  }
}

export function cliVersionLabel(binaryName: string, rawVersion?: string | null): string {
  const version = rawVersion?.trim()
  if (!version) return ''

  const lower = version.toLowerCase()
  const binaryLower = binaryName.toLowerCase()
  const prefixes = [
    cliDisplayName(binaryName).toLowerCase(),
    `${binaryLower}-cli`,
    `${binaryLower} cli`,
  ].sort((a, b) => b.length - a.length)

  for (const prefix of prefixes) {
    if (lower === prefix) return ''
    if (lower.startsWith(`${prefix} `)) {
      return version.slice(prefix.length).trim()
    }
  }

  if (lower.startsWith(`${binaryLower} `)) {
    const rest = version.slice(binaryName.length).trim()
    if (/^v?\d/.test(rest)) return rest
  }

  return version
}
