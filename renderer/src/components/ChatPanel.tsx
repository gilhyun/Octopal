import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { basename } from '../utils'
import { MentionPopup } from './MentionPopup'
import { AgentAvatar } from './AgentAvatar'
import type { Attachment, Message } from '../types'
import { Paperclip, Download, FileText, X, Send, ImageOff, ArrowDown } from 'lucide-react'
import { MarkdownRenderer } from './MarkdownRenderer'

/** Pending attachment before send — holds local preview data */
export interface PendingAttachment {
  id: string
  file: File
  previewUrl: string  // object URL for image preview
  type: 'image' | 'text'
}

const ALLOWED_IMAGE = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
const ALLOWED_TEXT = [
  'text/plain', 'application/json', 'text/csv', 'text/x-log',
  // fallback for .log/.json/.csv that may not have correct mime
]
const ALLOWED_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.txt', '.log', '.json', '.csv']
const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10MB
const MAX_ATTACHMENTS = 5

interface ChatPanelProps {
  activeFolder: string | null
  activeWorkspace: Workspace | null
  runes: RuneFile[]
  folderMessages: Message[]
  input: string
  setInput: (v: string) => void
  mentionOpen: boolean
  setMentionOpen: (v: boolean) => void
  mentionQuery: string
  setMentionQuery: (v: string) => void
  send: (attachments?: Attachment[]) => void
  onApproveHandoff: (messageId: string) => void
  onDismissHandoff: (messageId: string) => void
}

export function ChatPanel({
  activeFolder,
  activeWorkspace,
  runes,
  folderMessages,
  input,
  setInput,
  mentionOpen,
  setMentionOpen,
  mentionQuery,
  setMentionQuery,
  send,
  onApproveHandoff,
  onDismissHandoff,
}: ChatPanelProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const messagesContainerRef = useRef<HTMLDivElement>(null)
  const isNearBottomRef = useRef(true)

  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([])
  const [isDragging, setIsDragging] = useState(false)
  const [failedImages, setFailedImages] = useState<Set<string>>(new Set())
  const [showScrollDown, setShowScrollDown] = useState(false)
  const dragCounterRef = useRef(0)

  // Auto-grow textarea based on content
  const adjustTextareaHeight = useCallback(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 120) + 'px' // max ~5줄
  }, [])

  // ── File handling helpers ──

  const isFileAllowed = (file: File): boolean => {
    // Check by mime type
    if (ALLOWED_IMAGE.includes(file.type)) return true
    if (ALLOWED_TEXT.some(t => file.type.startsWith(t))) return true
    // Fallback: check by extension
    const ext = '.' + file.name.split('.').pop()?.toLowerCase()
    return ALLOWED_EXTENSIONS.includes(ext)
  }

  const getFileType = (file: File): 'image' | 'text' => {
    return ALLOWED_IMAGE.includes(file.type) ? 'image' : 'text'
  }

  const addFiles = useCallback((files: File[]) => {
    setPendingAttachments(prev => {
      const remaining = MAX_ATTACHMENTS - prev.length
      if (remaining <= 0) return prev

      const validFiles = files
        .filter(f => f.size <= MAX_FILE_SIZE && isFileAllowed(f))
        .slice(0, remaining)

      const newAttachments: PendingAttachment[] = validFiles.map(f => ({
        id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        file: f,
        previewUrl: ALLOWED_IMAGE.includes(f.type) ? URL.createObjectURL(f) : '',
        type: getFileType(f),
      }))

      return [...prev, ...newAttachments]
    })
  }, [])

  const removeAttachment = useCallback((id: string) => {
    setPendingAttachments(prev => {
      const att = prev.find(a => a.id === id)
      if (att?.previewUrl) URL.revokeObjectURL(att.previewUrl)
      return prev.filter(a => a.id !== id)
    })
  }, [])

  // Clean up object URLs on unmount
  useEffect(() => {
    return () => {
      pendingAttachments.forEach(a => {
        if (a.previewUrl) URL.revokeObjectURL(a.previewUrl)
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Paste handler ──
  const onPaste = useCallback((e: React.ClipboardEvent) => {
    const items = Array.from(e.clipboardData.items)
    const files: File[] = []
    for (const item of items) {
      if (item.kind === 'file') {
        const file = item.getAsFile()
        if (file) files.push(file)
      }
    }
    if (files.length > 0) {
      e.preventDefault()
      addFiles(files)
    }
  }, [addFiles])

  // ── Drag & Drop handlers ──
  const onDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    dragCounterRef.current++
    if (e.dataTransfer.types.includes('Files')) {
      setIsDragging(true)
    }
  }, [])

  const onDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    dragCounterRef.current--
    if (dragCounterRef.current === 0) {
      setIsDragging(false)
    }
  }, [])

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
  }, [])

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    dragCounterRef.current = 0
    setIsDragging(false)
    const files = Array.from(e.dataTransfer.files)
    if (files.length > 0) addFiles(files)
  }, [addFiles])

  // ── File input change (📎 button) ──
  const onFileInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || [])
    if (files.length > 0) addFiles(files)
    e.target.value = '' // reset so same file can be re-selected
  }, [addFiles])

  // ── Save pending attachments via IPC and return Attachment[] ──
  const savePendingAttachments = async (): Promise<Attachment[]> => {
    if (pendingAttachments.length === 0 || !activeFolder) return []

    const saved: Attachment[] = []
    for (const pa of pendingAttachments) {
      const arrayBuffer = await pa.file.arrayBuffer()
      const base64 = btoa(
        new Uint8Array(arrayBuffer).reduce((data, byte) => data + String.fromCharCode(byte), '')
      )
      try {
        const result = await window.api.saveFile({
          folderPath: activeFolder,
          fileName: pa.file.name,
          data: base64,
          mimeType: pa.file.type || 'application/octet-stream',
        })
        if ('attachment' in result) saved.push(result.attachment as Attachment)
      } catch (err) {
        console.error('Failed to save attachment:', err)
      }
    }

    // Clean up preview URLs
    pendingAttachments.forEach(a => {
      if (a.previewUrl) URL.revokeObjectURL(a.previewUrl)
    })
    setPendingAttachments([])
    return saved
  }

  // Track scroll position — if user scrolled up, disable auto-scroll
  const handleMessagesScroll = () => {
    const el = messagesContainerRef.current
    if (!el) return
    const threshold = 80 // px from bottom
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < threshold
    isNearBottomRef.current = atBottom
    setShowScrollDown(!atBottom)
  }

  // Auto-scroll to bottom only when user is near bottom
  useEffect(() => {
    if (isNearBottomRef.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [folderMessages])

  // Scroll-to-bottom handler
  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    isNearBottomRef.current = true
    setShowScrollDown(false)
  }

  const filteredMentions = useMemo(() => {
    const candidates = [...runes.map((r) => r.name), 'all']
    const q = mentionQuery.toLowerCase()
    return candidates.filter((n) => n.toLowerCase().startsWith(q))
  }, [runes, mentionQuery])

  const onInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const v = e.target.value
    setInput(v)
    adjustTextareaHeight()
    const cursorPos = e.target.selectionStart || v.length
    const before = v.slice(0, cursorPos)
    const match = before.match(/@(\w*)$/)
    if (match) {
      setMentionOpen(true)
      setMentionQuery(match[1])
    } else {
      setMentionOpen(false)
    }
  }

  const handleSend = async () => {
    const attachments = await savePendingAttachments()
    send(attachments.length > 0 ? attachments : undefined)
    setTimeout(() => adjustTextareaHeight(), 0)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
    if (e.key === 'Escape') setMentionOpen(false)
  }

  const pickMention = (name: string) => {
    const cursorPos = textareaRef.current?.selectionStart || input.length
    const before = input.slice(0, cursorPos).replace(/@\w*$/, `@${name} `)
    const after = input.slice(cursorPos)
    setInput(before + after)
    setMentionOpen(false)
    textareaRef.current?.focus()
  }

  return (
    <main
      className="chat"
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <header className="chat-header drag">
        <div>
          <div className="room-title">
            {activeFolder ? basename(activeFolder) : 'No folder'}
          </div>
          <div className="room-meta">
            {activeFolder
              ? `${runes.length} agent${runes.length !== 1 ? 's' : ''}`
              : activeWorkspace
              ? 'Open a folder to start'
              : 'Create a workspace to start'}
          </div>
        </div>
      </header>

      {/* Drag & Drop overlay */}
      {isDragging && (
        <div className="drop-overlay">
          <div className="drop-overlay-content">
            <div className="drop-overlay-icon"><Download size={40} /></div>
            <div className="drop-overlay-text">파일을 여기에 놓으세요</div>
          </div>
        </div>
      )}

      <div className="messages" ref={messagesContainerRef} onScroll={handleMessagesScroll}>
        {folderMessages.length === 0 && (
          <div className="empty">
            <div className="empty-title">RuneChat</div>
            <div className="empty-sub">
              Use @name to talk to an agent. @all to talk to everyone.
            </div>
          </div>
        )}
        {folderMessages.map((m) => {
          const isUser = m.agentName === 'user'
          const isDispatcher = m.agentName === '__dispatcher__'
          if (isDispatcher) {
            return (
              <div key={m.id} className="dispatcher-indicator">
                <span className="dispatcher-dot" />
                Routing message to the right agent…
              </div>
            )
          }
          const agentRune = runes.find(r => r.name === m.agentName)
          return (
            <div key={m.id} className={`message ${isUser ? 'user' : 'agent'}`}>
              {!isUser && (
                <AgentAvatar name={m.agentName} icon={agentRune?.icon} size="sm" />
              )}
              <div className={`bubble ${m.pending ? 'pending' : ''} ${m.error ? 'error' : ''}`}>
                {!isUser && <div className="bubble-name">{m.agentName}</div>}
                {m.pending && m.activity ? (
                  <div className="bubble-activity">
                    <span className="activity-dot" />
                    {m.activity}
                  </div>
                ) : (
                  <div className="bubble-text">
                    {isUser ? m.text : <MarkdownRenderer content={m.text} />}
                  </div>
                )}
                {/* Pending handoff approval — shown only on the speaker's bubble */}
                {m.handoff && m.handoff.approved === undefined && (
                  <div className="handoff-prompt">
                    <div className="handoff-text">
                      Call {m.handoff.targets.map((t) => `@${t}`).join(', ')}?
                    </div>
                    <div className="handoff-actions">
                      <button
                        className="btn-primary"
                        onClick={() => onApproveHandoff(m.id)}
                      >
                        Approve
                      </button>
                      <button
                        className="btn-secondary"
                        onClick={() => onDismissHandoff(m.id)}
                      >
                        Dismiss
                      </button>
                    </div>
                  </div>
                )}
                {m.handoff && m.handoff.approved === false && (
                  <div className="handoff-resolved">Handoff dismissed</div>
                )}
                {m.handoff && m.handoff.approved === true && (
                  <div className="handoff-resolved">Handoff approved</div>
                )}
                {/* Inline attachments */}
                {m.attachments && m.attachments.length > 0 && (
                  <div className="message-images">
                    {m.attachments.map((att) =>
                      att.type === 'image' ? (
                        failedImages.has(att.id) ? (
                          <div key={att.id} className="message-image-error">
                            <ImageOff size={16} />
                            <span>{att.filename}</span>
                          </div>
                        ) : (
                          <img
                            key={att.id}
                            className="message-image"
                            src={`local-file://${encodeURI(`${activeFolder}/${att.path}`)}`}
                            alt={att.filename}
                            loading="lazy"
                            onError={() => setFailedImages(prev => new Set(prev).add(att.id))}
                            onClick={() => {
                              window.api.getAbsolutePath({
                                folderPath: activeFolder!,
                                relativePath: att.path,
                              }).then((abs: string) => {
                                window.open(`file://${abs}`, '_blank')
                              })
                            }}
                          />
                        )
                      ) : (
                        <div key={att.id} className="message-file-badge">
                          <span className="message-file-icon"><FileText size={16} /></span>
                          <span className="message-file-name">{att.filename}</span>
                        </div>
                      )
                    )}
                  </div>
                )}
              </div>
            </div>
          )
        })}
        <div ref={messagesEndRef} />
      </div>

      {/* Scroll-to-bottom FAB */}
      {showScrollDown && (
        <button className="scroll-to-bottom" onClick={scrollToBottom} title="맨 아래로">
          <ArrowDown size={18} />
        </button>
      )}

      <footer className="composer">
        {mentionOpen && filteredMentions.length > 0 && (
          <MentionPopup filteredMentions={filteredMentions} pickMention={pickMention} runes={runes} />
        )}

        {/* Attachment preview */}
        {pendingAttachments.length > 0 && (
          <div className="attachment-preview">
            {pendingAttachments.map((att) => (
              <div key={att.id} className={`attachment-thumb ${att.type === 'text' ? 'file-type' : ''}`}>
                {att.type === 'image' ? (
                  <img src={att.previewUrl} alt={att.file.name} />
                ) : (
                  <>
                    <span className="attachment-file-icon"><FileText size={20} /></span>
                    <span className="attachment-file-name">{att.file.name}</span>
                  </>
                )}
                <button
                  className="attachment-remove"
                  onClick={() => removeAttachment(att.id)}
                  aria-label="Remove attachment"
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="composer-row">
          {/* Hidden file input */}
          <input
            ref={fileInputRef}
            type="file"
            accept=".png,.jpg,.jpeg,.gif,.webp,.txt,.log,.json,.csv"
            multiple
            style={{ display: 'none' }}
            onChange={onFileInputChange}
          />
          <button
            className="attach-btn"
            onClick={() => fileInputRef.current?.click()}
            disabled={!activeFolder}
            title="파일 첨부"
          >
            <Paperclip size={18} />
          </button>
          <textarea
            ref={textareaRef}
            className="composer-textarea"
            placeholder={
              activeFolder
                ? 'Message the room… (@name to target one agent, @all for everyone)'
                : 'Open a folder to start chatting'
            }
            value={input}
            onChange={onInputChange}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            disabled={!activeFolder}
            rows={1}
          />
          <button className="send" onClick={handleSend} disabled={!activeFolder}>
            <Send size={16} />
          </button>
        </div>
      </footer>
    </main>
  )
}
