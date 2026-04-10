import { colorForName } from '../utils'

interface AgentAvatarProps {
  name: string
  icon?: string
  color?: string
  size?: 'xs' | 'sm' | 'md'
  showOnlineDot?: boolean
  mcpStatus?: McpStatus
}

/** Returns true if the string starts with an emoji (non-ASCII grapheme) */
function isEmoji(str: string): boolean {
  if (!str) return false
  return /^[\p{Emoji_Presentation}\p{Extended_Pictographic}]/u.test(str)
}

export function AgentAvatar({ name, icon, color, size = 'md', showOnlineDot = false, mcpStatus }: AgentAvatarProps) {
  const bgColor = color || colorForName(name)
  const hasEmoji = icon && isEmoji(icon)

  // Determine dot CSS class based on MCP status
  const dotClass = mcpStatus
    ? `online-dot online-dot--${mcpStatus}`
    : 'online-dot'

  return (
    <div
      className={`avatar ${size !== 'md' ? size : ''} ${hasEmoji ? 'avatar-emoji' : ''}`}
      style={{ background: bgColor }}
    >
      {hasEmoji ? (
        <span className="avatar-emoji-char">{icon}</span>
      ) : (
        name[0].toUpperCase()
      )}
      {showOnlineDot && <span className={dotClass} />}
    </div>
  )
}
