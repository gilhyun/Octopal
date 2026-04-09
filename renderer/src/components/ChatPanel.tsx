import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { basename } from '../utils'
import { MentionPopup } from './MentionPopup'
import { AgentAvatar } from './AgentAvatar'
import type { Attachment, Message, TokenUsage } from '../types'
import { Paperclip, Download, FileText, X, Send, Square, ImageOff, ArrowDown, PanelLeftOpen, PanelRightOpen, PanelRightClose, Code, ChevronDown, ChevronRight, Zap } from 'lucide-react'
import { MarkdownRenderer } from './MarkdownRenderer'

/** Pending attachment before send — holds local preview data */
export interface PendingAttachment {
  id: string
  file: File
  previewUrl: string  // object URL for image preview
  type: 'image' | 'text'
  textContent?: string   // raw text for pasted-text attachments (for preview)
  isPastedText?: boolean // flag to distinguish pasted text from file-picker text files
}

const PASTE_ATTACHMENT_THRESHOLD = 500 // chars — pastes longer than this become an attachment

const ALLOWED_IMAGE = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
const ALLOWED_TEXT = [
  'text/plain', 'application/json', 'text/csv', 'text/x-log',
  // fallback for .log/.json/.csv that may not have correct mime
]
const ALLOWED_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.txt', '.log', '.json', '.csv']
const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10MB
const MAX_ATTACHMENTS = 5

/** Collapsible block for pasted-text attachments in chat bubbles */
function PastedTextBlock({ attachment, folderPath }: { attachment: Attachment; folderPath: string }) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const [content, setContent] = useState<string | null>(null)

  const loadContent = async () => {
    if (content !== null) { setExpanded(e => !e); return }
    try {
      const abs = await window.api.getAbsolutePath({ folderPath, relativePath: attachment.path })
      const res = await fetch(`local-file://${encodeURI(abs)}`)
      const text = await res.text()
      setContent(text)
      setExpanded(true)
    } catch {
      setContent(t('chat.pastedTextError'))
      setExpanded(true)
    }
  }

  return (
    <div className="pasted-text-block">
      <div className="pasted-text-block-header" onClick={loadContent}>
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <Code size={14} />
        <span>{t('chat.pastedText')}</span>
        <span className="pasted-text-block-size">{attachment.size.toLocaleString()} {t('chat.chars')}</span>
      </div>
      {expanded && content !== null && (
        <pre className="pasted-text-block-body">{content}</pre>
      )}
    </div>
  )
}

/** Collapsible wrapper for existing long inline messages */
function CollapsibleLongText({ text }: { text: string }) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const preview = text.slice(0, 300)

  return (
    <div className="collapsible-long-text">
      <span>{expanded ? text : preview + '…'}</span>
      <button className="collapsible-toggle" onClick={() => setExpanded(e => !e)}>
        {expanded ? t('chat.showLess') : t('chat.showMore')}
      </button>
    </div>
  )
}

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return `${n}`
}

function formatCost(usd: number): string {
  if (usd < 0.001) return `$${usd.toFixed(4)}`
  if (usd < 0.01) return `$${usd.toFixed(3)}`
  return `$${usd.toFixed(2)}`
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

/** Inline token usage badge shown below agent messages */
function TokenUsageBadge({ usage }: { usage: TokenUsage }) {
  const [expanded, setExpanded] = useState(false)
  const totalTokens = usage.inputTokens + usage.outputTokens

  return (
    <div className="token-usage-badge">
      <div className="token-usage-summary" onClick={() => setExpanded(e => !e)}>
        <Zap size={12} />
        <span className="token-usage-total">{formatTokenCount(totalTokens)} tokens</span>
        {usage.costUsd != null && (
          <span className="token-usage-cost">{formatCost(usage.costUsd)}</span>
        )}
        {usage.durationMs != null && (
          <span className="token-usage-duration">{formatDuration(usage.durationMs)}</span>
        )}
      </div>
      {expanded && (
        <div className="token-usage-detail">
          <div className="token-usage-row">
            <span className="token-usage-label">Input</span>
            <span className="token-usage-value">{formatTokenCount(usage.inputTokens)}</span>
          </div>
          <div className="token-usage-row">
            <span className="token-usage-label">Output</span>
            <span className="token-usage-value">{formatTokenCount(usage.outputTokens)}</span>
          </div>
          {usage.cacheReadTokens != null && usage.cacheReadTokens > 0 && (
            <div className="token-usage-row">
              <span className="token-usage-label">Cache read</span>
              <span className="token-usage-value">{formatTokenCount(usage.cacheReadTokens)}</span>
            </div>
          )}
          {usage.cacheCreationTokens != null && usage.cacheCreationTokens > 0 && (
            <div className="token-usage-row">
              <span className="token-usage-label">Cache write</span>
              <span className="token-usage-value">{formatTokenCount(usage.cacheCreationTokens)}</span>
            </div>
          )}
          {usage.model && (
            <div className="token-usage-row">
              <span className="token-usage-label">Model</span>
              <span className="token-usage-value token-usage-model">{usage.model}</span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

interface ChatPanelProps {
  activeFolder: string | null
  activeWorkspace: Workspace | null
  octos: OctoFile[]
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
  onGrantPermission: (messageId: string) => void
  onDismissPermission: (messageId: string) => void
  hasMoreMessages: boolean
  loadingMore: boolean
  onLoadMore: () => Promise<void>
  hasPendingAgents: boolean
  leftSidebarOpen: boolean
  rightSidebarOpen: boolean
  onToggleLeftSidebar: () => void
  onToggleRightSidebar: () => void
  onStopAll: () => void
}

export function ChatPanel({
  activeFolder,
  activeWorkspace,
  octos,
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
  onGrantPermission,
  onDismissPermission,
  hasMoreMessages,
  loadingMore,
  onLoadMore,
  hasPendingAgents,
  leftSidebarOpen,
  rightSidebarOpen,
  onToggleLeftSidebar,
  onToggleRightSidebar,
  onStopAll,
}: ChatPanelProps) {
  const { t } = useTranslation()
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const messagesContainerRef = useRef<HTMLDivElement>(null)
  const isNearBottomRef = useRef(true)

  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([])
  const [isDragging, setIsDragging] = useState(false)
  const [failedImages, setFailedImages] = useState<Set<string>>(new Set())
  const [showScrollDown, setShowScrollDown] = useState(false)
  const [mentionIndex, setMentionIndex] = useState(0)
  const dragCounterRef = useRef(0)
  const initialScrollDoneRef = useRef<string | null>(null)

  // Auto-grow textarea based on content
  const adjustTextareaHeight = useCallback(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    const newHeight = Math.min(el.scrollHeight, 120)
    el.style.height = newHeight + 'px'
    el.style.overflowY = el.scrollHeight > 120 ? 'auto' : 'hidden'
  }, [])

  // ── File handling helpers ──

  const isFileAllowed = (file: File): boolean => {
    if (ALLOWED_IMAGE.includes(file.type)) return true
    if (ALLOWED_TEXT.some(t => file.type.startsWith(t))) return true
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

  // ── Pasted-text attachment helper ──
  const addPastedText = useCallback((text: string) => {
    setPendingAttachments(prev => {
      if (prev.length >= MAX_ATTACHMENTS) return prev
      const id = `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const filename = `pasted-text-${Date.now()}.txt`
      const file = new File([text], filename, { type: 'text/plain' })
      return [...prev, {
        id,
        file,
        previewUrl: '',
        type: 'text' as const,
        textContent: text,
        isPastedText: true,
      }]
    })
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
      return
    }

    // Long text paste → convert to attachment
    const text = e.clipboardData.getData('text/plain')
    if (text.length >= PASTE_ATTACHMENT_THRESHOLD) {
      e.preventDefault()
      addPastedText(text)
    }
  }, [addFiles, addPastedText])

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
        if ('attachment' in result) {
          const att = result.attachment as Attachment
          if (pa.isPastedText) (att as any).isPastedText = true
          saved.push(att)
        }
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

  // Track scroll position
  const handleMessagesScroll = () => {
    const el = messagesContainerRef.current
    if (!el) return
    const threshold = 80
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < threshold
    isNearBottomRef.current = atBottom
    setShowScrollDown(!atBottom)

    if (el.scrollTop < 60 && hasMoreMessages && !loadingMore) {
      const prevScrollHeight = el.scrollHeight
      onLoadMore().then(() => {
        requestAnimationFrame(() => {
          const newScrollHeight = el.scrollHeight
          el.scrollTop = newScrollHeight - prevScrollHeight
        })
      })
    }
  }

  useEffect(() => {
    isNearBottomRef.current = true
    initialScrollDoneRef.current = null
    setShowScrollDown(false)
  }, [activeFolder])

  useEffect(() => {
    if (!activeFolder || folderMessages.length === 0) return

    if (initialScrollDoneRef.current !== activeFolder) {
      initialScrollDoneRef.current = activeFolder
      requestAnimationFrame(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'instant' })
        isNearBottomRef.current = true
      })
      return
    }

    if (isNearBottomRef.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [folderMessages, activeFolder])

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    isNearBottomRef.current = true
    setShowScrollDown(false)
  }

  const filteredMentions = useMemo(() => {
    const candidates = [...octos.map((r) => r.name), 'all']
    const q = mentionQuery.toLowerCase()
    return candidates.filter((n) => n.toLowerCase().startsWith(q))
  }, [octos, mentionQuery])

  const onInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const v = e.target.value
    setInput(v)
    adjustTextareaHeight()
    const cursorPos = e.target.selectionStart || v.length
    const before = v.slice(0, cursorPos)
    const match = before.match(/@([\w\p{L}\p{N}_-]*)$/u)
    if (match) {
      setMentionOpen(true)
      setMentionQuery(match[1])
      setMentionIndex(0)
    } else {
      setMentionOpen(false)
    }
  }

  const handleSend = async () => {
    const attachments = await savePendingAttachments()
    send(attachments.length > 0 ? attachments : undefined)
    setTimeout(() => adjustTextareaHeight(), 0)
    // 전송 후 스크롤이 하단이 아니면 하단으로 이동
    if (!isNearBottomRef.current) {
      setTimeout(() => scrollToBottom(), 50)
    }
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (mentionOpen && filteredMentions.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setMentionIndex((prev) => (prev + 1) % filteredMentions.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setMentionIndex((prev) => (prev - 1 + filteredMentions.length) % filteredMentions.length)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        if (e.nativeEvent.isComposing || e.keyCode === 229) return
        e.preventDefault()
        pickMention(filteredMentions[mentionIndex])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setMentionOpen(false)
        return
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      if (e.nativeEvent.isComposing || e.keyCode === 229) return
      e.preventDefault()
      handleSend()
    }
    if (e.key === 'Escape') setMentionOpen(false)
  }

  const pickMention = (name: string) => {
    const cursorPos = textareaRef.current?.selectionStart || input.length
    const before = input.slice(0, cursorPos).replace(/@[\w\p{L}\p{N}_-]*$/u, `@${name} `)
    const after = input.slice(cursorPos)
    setInput(before + after)
    setMentionOpen(false)
    textareaRef.current?.focus()
  }

  const formatPermissions = (perms: string[]) =>
    perms.map((p) =>
      p === 'fileWrite' ? t('chat.permFileWrite') : p === 'bash' ? t('chat.permShell') : t('chat.permNetwork')
    ).join(', ')

  return (
    <main
      className="chat"
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <header className="chat-header drag">
        {!leftSidebarOpen && (
          <button
            className="sidebar-toggle-btn chat-toggle-btn"
            onClick={onToggleLeftSidebar}
            title={t('sidebar.expandSidebar')}
          >
            <PanelLeftOpen size={16} />
          </button>
        )}
        <div style={{ flex: 1 }}>
          <div className="room-title">
            {activeFolder ? basename(activeFolder) : t('chat.noFolder')}
          </div>
          <div className="room-meta">
            {activeFolder
              ? t('chat.agentCount', { count: octos.length })
              : activeWorkspace
              ? t('chat.openFolderToStart')
              : t('chat.createWorkspaceToStart')}
          </div>
        </div>
        <button
          className={`sidebar-toggle-btn chat-toggle-btn${rightSidebarOpen ? ' panel-active' : ''}`}
          onClick={onToggleRightSidebar}
          title={rightSidebarOpen ? t('sidebar.collapseAgents') : t('sidebar.expandAgents')}
        >
          {rightSidebarOpen ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}
        </button>
      </header>

      {/* Drag & Drop overlay */}
      {isDragging && (
        <div className="drop-overlay">
          <div className="drop-overlay-content">
            <div className="drop-overlay-icon"><Download size={40} /></div>
            <div className="drop-overlay-text">{t('chat.dropFiles')}</div>
          </div>
        </div>
      )}

      <div className="messages" ref={messagesContainerRef} onScroll={handleMessagesScroll}>
        {loadingMore && (
          <div className="load-more-indicator">
            <span className="load-more-dot" />
            {t('chat.loadingOlder')}
          </div>
        )}
        {hasMoreMessages && !loadingMore && folderMessages.length > 0 && (
          <div className="load-more-hint">{t('chat.scrollUpOlder')}</div>
        )}
        {folderMessages.length === 0 && !loadingMore && (
          <div className="empty">
            <div className="empty-title">{t('chat.emptyTitle')}</div>
            <div className="empty-sub">
              {activeFolder
                ? t('chat.emptyWithFolder')
                : t('chat.emptyNoFolder')}
            </div>
          </div>
        )}
        {folderMessages.map((m) => {
          const isUser = m.agentName === 'user'
          const isDispatcher = m.agentName === '__dispatcher__'
          const isSystem = m.agentName === '__system__'
          if (isDispatcher) {
            return (
              <div key={m.id} className="dispatcher-indicator">
                <span className="dispatcher-dot" />
                {t('chat.routing')}
              </div>
            )
          }
          if (isSystem) {
            return (
              <div key={m.id} className="dispatcher-indicator system-message">
                {m.text}
              </div>
            )
          }
          const agentOcto = octos.find(r => r.name === m.agentName)
          return (
            <div key={m.id} className={`message ${isUser ? 'user' : 'agent'}`}>
              {!isUser && (
                <AgentAvatar name={m.agentName} icon={agentOcto?.icon} size="sm" />
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
                    {isUser ? (
                      m.text.length > PASTE_ATTACHMENT_THRESHOLD ? (
                        <CollapsibleLongText text={m.text} />
                      ) : m.text
                    ) : <MarkdownRenderer content={m.text} />}
                  </div>
                )}
                {m.handoff && m.handoff.approved === undefined && (
                  <div className="handoff-prompt">
                    <div className="handoff-text">
                      {t('chat.callTargets', { targets: m.handoff.targets.map((tgt) => `@${tgt}`).join(', ') })}
                    </div>
                    <div className="handoff-actions">
                      <button
                        className="btn-primary"
                        onClick={() => onApproveHandoff(m.id)}
                      >
                        {t('common.approve')}
                      </button>
                      <button
                        className="btn-secondary"
                        onClick={() => onDismissHandoff(m.id)}
                      >
                        {t('common.dismiss')}
                      </button>
                    </div>
                  </div>
                )}
                {m.handoff && m.handoff.approved === false && (
                  <div className="handoff-resolved">{t('chat.handoffDismissed')}</div>
                )}
                {m.handoff && m.handoff.approved === true && (
                  <div className="handoff-resolved">{t('chat.handoffApproved')}</div>
                )}
                {m.permissionRequest && m.permissionRequest.granted === undefined && (
                  <div className="permission-prompt">
                    <div className="permission-text">
                      {t('chat.grantPermission', { permissions: formatPermissions(m.permissionRequest.permissions) })}
                    </div>
                    <div className="permission-actions">
                      <button
                        className="btn-grant"
                        onClick={() => onGrantPermission(m.id)}
                      >
                        {t('common.grant')}
                      </button>
                      <button
                        className="btn-secondary"
                        onClick={() => onDismissPermission(m.id)}
                      >
                        {t('common.dismiss')}
                      </button>
                    </div>
                  </div>
                )}
                {m.permissionRequest && m.permissionRequest.granted === true && (
                  <div className="permission-resolved granted">{t('chat.permissionGranted')}</div>
                )}
                {m.permissionRequest && m.permissionRequest.granted === false && (
                  <div className="permission-resolved dismissed">{t('chat.permissionDismissed')}</div>
                )}
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
                      ) : (att as any).isPastedText ? (
                        <PastedTextBlock key={att.id} attachment={att} folderPath={activeFolder!} />
                      ) : (
                        <div key={att.id} className="message-file-badge">
                          <span className="message-file-icon"><FileText size={16} /></span>
                          <span className="message-file-name">{att.filename}</span>
                        </div>
                      )
                    )}
                  </div>
                )}
                {!isUser && !m.pending && m.usage && (
                  <TokenUsageBadge usage={m.usage} />
                )}
              </div>
            </div>
          )
        })}
        <div ref={messagesEndRef} />
      </div>

      {/* Scroll-to-bottom FAB */}
      {showScrollDown && (
        <button className="scroll-to-bottom" onClick={scrollToBottom} title={t('chat.scrollToBottom')}>
          <ArrowDown size={18} />
        </button>
      )}

      <footer className="composer">
        {mentionOpen && filteredMentions.length > 0 && (
          <MentionPopup filteredMentions={filteredMentions} pickMention={pickMention} octos={octos} selectedIndex={mentionIndex} />
        )}

        {/* Attachment preview */}
        {pendingAttachments.length > 0 && (
          <div className="attachment-preview">
            {pendingAttachments.map((att) => (
              att.isPastedText && att.textContent ? (
                <div key={att.id} className="attachment-thumb pasted-text">
                  <div className="paste-header">
                    <Code size={14} />
                    <span>{t('chat.pastedText')}</span>
                  </div>
                  <div className="paste-preview">{att.textContent.slice(0, 200)}</div>
                  <div className="paste-meta">
                    {att.textContent.length.toLocaleString()} {t('chat.chars')}
                  </div>
                  <button
                    className="attachment-remove"
                    onClick={() => removeAttachment(att.id)}
                    aria-label={t('chat.removeAttachment')}
                  >
                    <X size={12} />
                  </button>
                </div>
              ) : (
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
                    aria-label={t('chat.removeAttachment')}
                  >
                    <X size={12} />
                  </button>
                </div>
              )
            ))}
          </div>
        )}

        <div className="composer-row">
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
            title={t('chat.attachFile')}
          >
            <Paperclip size={18} />
          </button>
          <textarea
            ref={textareaRef}
            className="composer-textarea"
            placeholder={
              activeFolder
                ? t('chat.placeholder')
                : t('chat.placeholderDisabled')
            }
            value={input}
            onChange={onInputChange}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            disabled={!activeFolder}
            rows={1}
          />
          {hasPendingAgents && !input.trim() ? (
            <button className="send stop-btn" onClick={onStopAll} title={t('chat.stopAllAgents')}>
              <Square size={14} fill="currentColor" />
            </button>
          ) : (
            <button className="send" onClick={handleSend} disabled={!activeFolder}>
              <Send size={16} />
            </button>
          )}
        </div>
      </footer>
    </main>
  )
}
