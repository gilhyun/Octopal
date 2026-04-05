import { useState, useRef, useEffect } from 'react'
import { AgentAvatar } from './AgentAvatar'
import { AGENT_COLORS, colorForName } from '../utils'

interface EmojiPickerProps {
  value: string
  onChange: (emoji: string) => void
  name: string
  color?: string
  onColorChange?: (color: string) => void
}

const EMOJI_SECTIONS: { title: string; emojis: string[] }[] = [
  {
    title: '추천',
    emojis: [
      '🤖', '🎨', '📋', '🔧', '🧪', '💬', '📝', '🚀',
      '🎯', '⚡', '🧠', '🔍', '🛠️', '📊', '🎭', '🌟',
    ],
  },
  {
    title: '사람',
    emojis: [
      '👨‍💻', '👩‍💻', '🧑‍🎨', '👷', '🧑‍🔬', '🧑‍💼', '🧑‍🏫', '🤓',
      '🦸', '🧙', '🧝', '🥷', '👾', '😎', '🤠', '🧑‍🚀',
    ],
  },
  {
    title: '동물',
    emojis: [
      '🐱', '🐶', '🦊', '🐼', '🐸', '🦉', '🐝', '🦋',
      '🐙', '🦄', '🐳', '🐧', '🦁', '🐺', '🦈', '🐲',
    ],
  },
  {
    title: '기타',
    emojis: [
      '🔥', '⭐', '💎', '🌈', '🌙', '☀️', '🌊', '♻️',
      '📦', '🔐', '🌍', '🍀', '💡', '🎵', '🏆', '🎮',
    ],
  },
]

export function EmojiPicker({ value, onChange, name, color, onColorChange }: EmojiPickerProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [activeTab, setActiveTab] = useState(0)
  const wrapperRef = useRef<HTMLDivElement>(null)

  // Close on outside click
  useEffect(() => {
    if (!isOpen) return
    const handler = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setIsOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [isOpen])

  const handleSelect = (emoji: string) => {
    onChange(emoji)
    setIsOpen(false)
  }

  const clearEmoji = () => {
    onChange('')
    setIsOpen(false)
  }

  const currentColor = color || colorForName(name || '?')

  return (
    <div className="avatar-config-row">
      <div className="emoji-picker-wrapper" ref={wrapperRef}>
        <button
          type="button"
          className="emoji-picker-trigger avatar-trigger"
          onClick={() => setIsOpen(!isOpen)}
          title="클릭하여 아바타 변경"
        >
          <AgentAvatar name={name || '?'} icon={value || undefined} color={currentColor} size="md" />
        </button>

        {isOpen && (
          <div className="emoji-picker-dropdown">
            <div className="emoji-picker-tabs">
              {EMOJI_SECTIONS.map((section, i) => (
                <button
                  key={section.title}
                  type="button"
                  className={`emoji-tab ${activeTab === i ? 'active' : ''}`}
                  onClick={() => setActiveTab(i)}
                >
                  {section.title}
                </button>
              ))}
            </div>

            <div className="emoji-grid">
              {EMOJI_SECTIONS[activeTab].emojis.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  className={`emoji-cell ${value === emoji ? 'selected' : ''}`}
                  onClick={() => handleSelect(emoji)}
                >
                  {emoji}
                </button>
              ))}
            </div>

            {/* Color palette */}
            {onColorChange && (
              <div className="color-palette-section">
                <div className="color-palette-title">배경색</div>
                <div className="color-palette">
                  {AGENT_COLORS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      className={`color-swatch ${currentColor === c ? 'selected' : ''}`}
                      style={{ background: c }}
                      onClick={() => onColorChange(c)}
                    />
                  ))}
                </div>
              </div>
            )}

            <button type="button" className="emoji-clear" onClick={clearEmoji}>
              ❌ 아바타 초기화
            </button>
          </div>
        )}
      </div>

      <span className="avatar-config-hint">클릭하여 아바타 변경</span>
    </div>
  )
}
