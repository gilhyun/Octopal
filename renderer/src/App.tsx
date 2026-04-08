import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import './i18n'
import type { ActivityLogEntry, Attachment, Message, PermissionRequest } from './types'
import { LeftSidebar } from './components/LeftSidebar'
import { ChatPanel } from './components/ChatPanel'
import { WikiPanel } from './components/WikiPanel'
import { RightSidebar } from './components/RightSidebar'
import { ActivityPanel } from './components/ActivityPanel'
import { CreateAgentModal } from './components/modals/CreateAgentModal'
import { CreateWorkspaceModal } from './components/modals/CreateWorkspaceModal'
import { WelcomeModal } from './components/modals/WelcomeModal'
import { OpenFolderModal } from './components/modals/OpenFolderModal'
import { EditAgentModal } from './components/modals/EditAgentModal'
import { ClaudeLoginModal } from './components/modals/ClaudeLoginModal'
import { SettingsPanel } from './components/SettingsPanel'

export function App() {
  const { t, i18n } = useTranslation()
  const [state, setState] = useState<AppState>({ workspaces: [], activeWorkspaceId: null })
  const [activeFolder, setActiveFolder] = useState<string | null>(null)
  const [octos, setOctos] = useState<OctoFile[]>([])
  const [messages, setMessages] = useState<Record<string, Message[]>>({})
  // Track whether there are more (older) messages to load per folder
  const [hasMoreMessages, setHasMoreMessages] = useState<Record<string, boolean>>({})
  const [loadingMore, setLoadingMore] = useState(false)
  const PAGE_SIZE = 50
  // Activity log of concrete actions (write/edit/bash/webfetch), keyed by folder
  const [activityLog, setActivityLog] = useState<Record<string, ActivityLogEntry[]>>({})
  const [input, setInput] = useState('')
  const [showCreateAgent, setShowCreateAgent] = useState(false)
  const [showCreateWorkspace, setShowCreateWorkspace] = useState(false)
  const [showWelcome, setShowWelcome] = useState(false)
  const [editingAgent, setEditingAgent] = useState<OctoFile | null>(null)
  const [claudeCliStatus, setClaudeCliStatus] = useState<{ installed: boolean; loggedIn: boolean } | null>(null)
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false)
  const [mentionOpen, setMentionOpen] = useState(false)
  const [mentionQuery, setMentionQuery] = useState('')
  const [centerTab, setCenterTab] = useState<'chat' | 'wiki' | 'activity' | 'settings'>('chat')
  const [leftSidebarOpen, setLeftSidebarOpen] = useState(true)
  const [rightSidebarOpen, setRightSidebarOpen] = useState(true)
  const [platform, setPlatform] = useState<string>('darwin')

  // runId -> { folderPath, messageId } so activity events can find the right bubble
  const runMapRef = useRef<Map<string, { folderPath: string; messageId: string }>>(new Map())

  // Per-agent FIFO lock — key is `${folderPath}::${agentNameLower}`.
  // When an invokeAgent call starts, it awaits the previous promise on this key,
  // then replaces it with its own. This guarantees a single agent is never running
  // two Claude processes in parallel (which would corrupt history and race on files).
  const agentLocksRef = useRef<Map<string, Promise<void>>>(new Map())

  // Debounce buffer: collect consecutive user messages before triggering agents
  const DEBOUNCE_MS = 1200
  const bufferRef = useRef<{
    folderPath: string
    messages: Array<{ text: string; ts: number; attachments?: Attachment[] }>
    timer: ReturnType<typeof setTimeout> | null
  } | null>(null)

  const activeWorkspace = state.workspaces.find((w) => w.id === state.activeWorkspaceId) || null

  // ── Lifecycle ──

  // Load state on mount + apply saved language
  useEffect(() => {
    window.api.getPlatform().then((p) => setPlatform(p))
    window.api.checkClaudeCli().then((status) => {
      if (!status.installed || !status.loggedIn) {
        setClaudeCliStatus(status)
      }
    })
    window.api.loadSettings().then((settings) => {
      if (settings.general.language && settings.general.language !== i18n.language) {
        i18n.changeLanguage(settings.general.language)
      }
    })
    window.api.loadState().then(async (s) => {
      if (s.workspaces.length === 0) {
        // 첫 실행: "Personal" 스페이스 자동 생성 후 웰컴 모달
        const fresh = await window.api.createWorkspace('Personal')
        setState(fresh)
        setShowWelcome(true)
      } else {
        setState(s)
        const active = s.workspaces.find((w) => w.id === s.activeWorkspaceId)
        if (active && active.folders.length > 0) setActiveFolder(active.folders[0])
      }
    })
  }, [])

  // Compact mode: below this threshold sidebars open as overlays
  const COMPACT_BREAKPOINT = 700
  // Auto-collapse: below this threshold sidebars auto-close
  const COLLAPSE_BREAKPOINT = 900
  const [compactMode, setCompactMode] = useState(window.innerWidth < COMPACT_BREAKPOINT)

  // Track whether sidebars were auto-collapsed by resize (not manually closed)
  const autoCollapsedRef = useRef(false)

  useEffect(() => {
    const handleResize = () => {
      const w = window.innerWidth
      setCompactMode(w < COMPACT_BREAKPOINT)
      if (w < COLLAPSE_BREAKPOINT) {
        if (!autoCollapsedRef.current) {
          autoCollapsedRef.current = true
          setLeftSidebarOpen(false)
          setRightSidebarOpen(false)
        }
      } else {
        if (autoCollapsedRef.current) {
          autoCollapsedRef.current = false
          setLeftSidebarOpen(true)
          setRightSidebarOpen(true)
        }
      }
    }
    window.addEventListener('resize', handleResize)
    handleResize()
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  // Reset active folder when workspace changes
  useEffect(() => {
    if (activeWorkspace && activeWorkspace.folders.length > 0) {
      if (!activeFolder || !activeWorkspace.folders.includes(activeFolder)) {
        setActiveFolder(activeWorkspace.folders[0])
      }
    } else {
      setActiveFolder(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.activeWorkspaceId])

  // Track folders that have already bootstrapped their default agent so we
  // don't re-trigger during the same session (e.g. when re-selecting a folder).
  const bootstrappedFoldersRef = useRef<Set<string>>(new Set())

  // Load octos + history when folder changes (paged — last PAGE_SIZE messages)
  useEffect(() => {
    if (!activeFolder) {
      setOctos([])
      return
    }

    const folder = activeFolder // capture for async closures

    const bootstrap = async () => {
      const existingOctos = await window.api.listOctos(folder)

      // Auto-create assistant.octo if the folder has no agents
      if (existingOctos.length === 0 && !bootstrappedFoldersRef.current.has(folder)) {
        bootstrappedFoldersRef.current.add(folder)
        const createResult = await window.api.createOcto({
          folderPath: folder,
          name: 'assistant',
          role: 'General assistant. Scans the project, answers questions, and helps with tasks.',
          icon: '🐙',
        })
        if (createResult.ok) {
          // Re-list to pick up the new agent
          const refreshed = await window.api.listOctos(folder)
          setOctos(refreshed)

          // Load history (should be empty for a fresh folder)
          const { messages: history, hasMore } = await window.api.loadHistoryPaged({ folderPath: folder, limit: PAGE_SIZE })
          setHasMoreMessages((prev) => ({ ...prev, [folder]: hasMore }))
          setMessages((prev) => ({ ...prev, [folder]: history }))

          // Auto-send first message from assistant
          const assistant = refreshed.find((o) => o.name === 'assistant')
          if (assistant && history.length === 0) {
            const ts = Date.now()
            const pendingId = `p-${ts}-assistant-first`
            const runId = `run-${ts}-assistant-first-${Math.random().toString(36).slice(2, 8)}`
            runMapRef.current.set(runId, { folderPath: folder, messageId: pendingId })

            setMessages((prev) => ({
              ...prev,
              [folder]: [
                ...(prev[folder] || []),
                {
                  id: pendingId,
                  agentName: 'assistant',
                  text: '',
                  ts,
                  pending: true,
                  activity: t('app.scanningProject'),
                },
              ],
            }))

            const firstPrompt = [
              'You have just been added to this project folder. This is your first interaction — there is no user message yet.',
              'Scan the project folder to understand what it contains, then provide a welcome message.',
              '',
              'FORMAT YOUR RESPONSE EXACTLY LIKE THIS:',
              '',
              'If the folder has code/files:',
              '```',
              '👋 Hi! I\'m your AI assistant for this project.',
              '',
              '**Here\'s what I found:**',
              '- 📁 Project: `<project-name>` (<framework> + <language>)',
              '- 📦 Dependencies: <top 3-5 notable deps>',
              '- 📄 <N> files scanned',
              '',
              '**Try asking me:**',
              '- "Explain the project structure"',
              '- "Find where <relevant feature> is handled"',
              '- "Help me fix a bug in <relevant area>"',
              '',
              '💡 **Tips:**',
              '- Need more help? **Hire AI teammates** — specialists like designers, planners, or reviewers!',
              '- Each agent\'s capabilities (file write, shell, network) can be configured in their settings.',
              '- You\'ll see a real-time **activity log** of everything agents do in the sidebar.',
              '```',
              '',
              'If the folder is empty:',
              '```',
              '👋 Hi! I\'m your AI assistant.',
              '',
              'This folder is empty — no worries! I can help you:',
              '- 🛠 Scaffold a new project',
              '- 📝 Create config files',
              '- 💡 Brainstorm ideas',
              '- 🤖 Hire more AI teammates to collaborate with',
              '',
              '🔐 **About permissions:**',
              '- I can read files by default, but writing/shell/network need to be **enabled in agent settings**.',
              '- When an agent suggests involving another teammate, you\'ll see **Approve / Dismiss** buttons to stay in control.',
              '- Check the **activity log** in the sidebar to see everything agents are doing in real time.',
              '',
              'Just type a message to get started!',
              '```',
              '',
              'IMPORTANT: Output ONLY the message content (not the ``` fences). Keep the emoji, bold, and bullet formatting exactly as shown.',
              'Fill in the placeholders with actual project info. Tailor the "Try asking me" suggestions to the specific project.',
              'Keep it short and friendly (under 150 words). Do not ask questions.',
            ].join('\n')

            const res = await window.api.sendMessage({
              folderPath: folder,
              octoPath: assistant.path,
              prompt: firstPrompt,
              userTs: ts,
              runId,
              peers: [],
            })

            runMapRef.current.delete(runId)

            setMessages((prev) => {
              const list = prev[folder] || []
              const rawText = res.ok ? res.output : `Error: ${(res as any).error}`
              const permReq = res.ok ? parsePermissionRequest(rawText, assistant.name) : undefined
              return {
                ...prev,
                [folder]: list.map((m) =>
                  m.id === pendingId
                    ? {
                        ...m,
                        text: permReq ? stripPermissionTag(rawText) : rawText,
                        pending: false,
                        error: !res.ok,
                        activity: undefined,
                        permissionRequest: permReq,
                      }
                    : m
                ),
              }
            })
          }
          return // already loaded history above
        }
      }

      setOctos(existingOctos)

      // Load history normally
      const { messages: history, hasMore } = await window.api.loadHistoryPaged({ folderPath: folder, limit: PAGE_SIZE })
      setHasMoreMessages((prev) => ({ ...prev, [folder]: hasMore }))
      setMessages((prev) => {
        const existing = prev[folder] || []
        const pendingMessages = existing.filter((m) => m.pending)
        if (pendingMessages.length === 0) {
          return { ...prev, [folder]: history }
        }
        const historyIds = new Set(history.map((m) => m.id))
        const missingPending = pendingMessages.filter((m) => !historyIds.has(m.id))
        return { ...prev, [folder]: [...history, ...missingPending] }
      })
    }

    bootstrap()
  }, [activeFolder])

  // Load older messages (called when user scrolls to top)
  const loadMoreMessages = async () => {
    if (!activeFolder || loadingMore) return
    if (!hasMoreMessages[activeFolder]) return

    setLoadingMore(true)
    const currentMessages = messages[activeFolder] || []
    // Find the oldest non-pending message's timestamp
    const oldestTs = currentMessages.find((m) => !m.pending)?.ts
    if (oldestTs == null) {
      setLoadingMore(false)
      return
    }

    const { messages: older, hasMore } = await window.api.loadHistoryPaged({
      folderPath: activeFolder,
      limit: PAGE_SIZE,
      beforeTs: oldestTs,
    })

    setHasMoreMessages((prev) => ({ ...prev, [activeFolder]: hasMore }))
    setMessages((prev) => {
      const existing = prev[activeFolder] || []
      // Deduplicate by id
      const existingIds = new Set(existing.map((m) => m.id))
      const newOlder = older.filter((m) => !existingIds.has(m.id))
      return { ...prev, [activeFolder]: [...newOlder, ...existing] }
    })
    setLoadingMore(false)
  }

  // Listen for window limit reached notification
  useEffect(() => {
    const unsubscribe = window.api.onWindowLimitReached((max) => {
      // Show a brief notification — reuse the same pattern as agent limit
      alert(t('app.windowLimit', { max }))
    })
    return unsubscribe
  }, [])

  // Watch for .octo file changes in the active folder
  useEffect(() => {
    const unsubscribe = window.api.onOctosChanged((changedFolder) => {
      if (changedFolder === activeFolder) {
        window.api.listOctos(changedFolder).then(setOctos)
      }
    })
    return unsubscribe
  }, [activeFolder])

  // Listen for agent activity (tool calls) and update the pending bubble
  useEffect(() => {
    const unsubscribe = window.api.onActivity(({ runId, text }) => {
      const mapping = runMapRef.current.get(runId)
      if (!mapping) return
      setMessages((prev) => {
        const list = prev[mapping.folderPath] || []
        return {
          ...prev,
          [mapping.folderPath]: list.map((m) =>
            m.id === mapping.messageId ? { ...m, activity: text } : m
          ),
        }
      })
    })
    return unsubscribe
  }, [])

  // Activity log: collect Write/Edit/Bash/WebFetch events from all agents, per folder.
  useEffect(() => {
    const unsubscribe = window.api.onActivityLog((entry) => {
      const id = `log-${entry.ts}-${Math.random().toString(36).slice(2, 6)}`
      setActivityLog((prev) => {
        const list = prev[entry.folderPath] || []
        const next = [...list, {
          id,
          agentName: entry.agentName,
          tool: entry.tool,
          target: entry.target,
          ts: entry.ts,
        }].slice(-200) // cap at 200 entries per folder
        return { ...prev, [entry.folderPath]: next }
      })
    })
    return unsubscribe
  }, [])

  const folderMessages = activeFolder ? messages[activeFolder] || [] : []
  const folderActivity = activeFolder ? activityLog[activeFolder] || [] : []

  // ── Workspace / Folder actions ──

  const pickFolder = async () => {
    if (!state.activeWorkspaceId) return
    const p = await window.api.pickFolder(state.activeWorkspaceId)
    if (!p) return
    const fresh = await window.api.loadState()
    setState(fresh)
    setActiveFolder(p)
  }

  const removeFolder = async (p: string) => {
    if (!state.activeWorkspaceId) return
    const fresh = await window.api.removeFolder(state.activeWorkspaceId, p)
    setState(fresh)
    if (activeFolder === p) {
      const ws = fresh.workspaces.find((w) => w.id === fresh.activeWorkspaceId)
      setActiveFolder(ws?.folders[0] || null)
    }
  }

  const switchWorkspace = async (id: string) => {
    const fresh = await window.api.setActiveWorkspace(id)
    setState(fresh)
    setWorkspaceMenuOpen(false)
  }

  const removeWorkspace = async (id: string) => {
    if (!confirm(t('app.removeWorkspaceConfirm'))) return
    const fresh = await window.api.removeWorkspace(id)
    setState(fresh)
    setWorkspaceMenuOpen(false)
  }

  // ── Messaging ──

  const parseMentions = (text: string): string[] => {
    const re = /@([\w\p{L}\p{N}_-]+)/gu
    const found: string[] = []
    let m
    while ((m = re.exec(text)) !== null) found.push(m[1])
    return found
  }

  /** Parse <!--NEEDS_PERMISSIONS: fileWrite, bash, network--> from agent output */
  const parsePermissionRequest = (
    text: string,
    agentName: string
  ): PermissionRequest | undefined => {
    const re = /<!--NEEDS_PERMISSIONS:\s*([\w\s,]+)-->/
    const match = re.exec(text)
    if (!match) return undefined
    const validKeys = ['fileWrite', 'bash', 'network'] as const
    const perms = match[1]
      .split(',')
      .map((s) => s.trim())
      .filter((s): s is 'fileWrite' | 'bash' | 'network' =>
        validKeys.includes(s as any)
      )
    if (perms.length === 0) return undefined
    const agent = octos.find(
      (o) => o.name.toLowerCase() === agentName.toLowerCase()
    )
    return { permissions: perms, agentPath: agent?.path }
  }

  /** Strip the permission tag from displayed text */
  const stripPermissionTag = (text: string): string =>
    text.replace(/<!--NEEDS_PERMISSIONS:\s*[\w\s,]+-->/g, '').trim()

  const send = (attachments?: Attachment[]) => {
    const hasText = input.trim().length > 0
    const hasAttachments = attachments && attachments.length > 0
    if ((!hasText && !hasAttachments) || !activeFolder) return
    const text = input.trim()
    setInput('')
    setMentionOpen(false)

    const ts = Date.now()
    const userMessage: Message = {
      id: `u-${ts}`,
      agentName: 'user',
      text,
      ts,
      ...(hasAttachments ? { attachments } : {}),
    }
    setMessages((prev) => ({
      ...prev,
      [activeFolder]: [
        ...(prev[activeFolder] || []),
        userMessage,
      ],
    }))

    // Persist the user message immediately to room-log.json so it survives
    // reloads even if no agent responds (or a hot-reload kills the chain).
    window.api.appendUserMessage({
      folderPath: activeFolder,
      message: {
        id: userMessage.id,
        ts,
        text,
        attachments: hasAttachments ? attachments : undefined,
      },
    })

    // Add to buffer
    if (!bufferRef.current || bufferRef.current.folderPath !== activeFolder) {
      if (bufferRef.current?.timer) clearTimeout(bufferRef.current.timer)
      bufferRef.current = { folderPath: activeFolder, messages: [], timer: null }
    }
    bufferRef.current.messages.push({ text, ts, attachments: hasAttachments ? attachments : undefined })

    // Reset debounce timer
    if (bufferRef.current.timer) clearTimeout(bufferRef.current.timer)
    bufferRef.current.timer = setTimeout(flushBuffer, DEBOUNCE_MS)
  }

  const flushBuffer = async () => {
    const buf = bufferRef.current
    if (!buf || buf.messages.length === 0) return
    const folderPath = buf.folderPath
    const bufferedMessages = buf.messages
    bufferRef.current = null

    const combinedText =
      bufferedMessages.length === 1
        ? bufferedMessages[0].text
        : bufferedMessages.map((m, i) => `(${i + 1}) ${m.text}`).join('\n')

    // Collect all attachments from buffered messages
    const allAttachments: Attachment[] = bufferedMessages.flatMap(
      (m) => m.attachments || []
    )

    const userTs = bufferedMessages[0].ts

    const allMentions = bufferedMessages.flatMap((m) => parseMentions(m.text))
    let leader: OctoFile | null = null
    let collaborators: OctoFile[] = []

    if (allMentions.length > 0) {
      const isAll = allMentions.includes('all')
      const mentionedAgents = isAll
        ? octos
        : octos.filter((r) =>
            allMentions.some((m) => r.name.toLowerCase() === m.toLowerCase())
          )
      if (mentionedAgents.length > 0) {
        leader = mentionedAgents[0]
        collaborators = mentionedAgents.slice(1)
      }
    } else {
      const visibleAgents = octos.filter((r) => !r.hidden)
      if (visibleAgents.length === 1) {
        // Only one visible agent — skip dispatcher, route directly
        leader = visibleAgents[0]
      } else if (visibleAgents.length > 1) {
        const dispatcherMsgId = `d-${userTs}`
        setMessages((prev) => ({
          ...prev,
          [folderPath]: [
            ...(prev[folderPath] || []),
            {
              id: dispatcherMsgId,
              agentName: '__dispatcher__',
              text: t('chat.routing'),
              ts: Date.now(),
              pending: true,
            },
          ],
        }))
        const recent = (messages[folderPath] || [])
          .filter((m) => m.agentName !== '__dispatcher__' && !m.pending)
          .slice(-6)
          .map((m) => ({ agentName: m.agentName, text: m.text }))
        const res = await window.api.dispatch({
          message: combinedText,
          agents: visibleAgents.map((r) => ({ name: r.name, role: r.role })),
          recentHistory: recent,
        })
        setMessages((prev) => ({
          ...prev,
          [folderPath]: (prev[folderPath] || []).filter((m) => m.id !== dispatcherMsgId),
        }))
        if (res.ok) {
          const leaderMatch = octos.find((r) => r.name === res.leader)
          if (leaderMatch) {
            leader = leaderMatch
            collaborators = octos.filter((r) => res.collaborators.includes(r.name))
          }
        }
      }
    }

    if (!leader) return

    const called = new Set<string>([leader.name.toLowerCase()])
    invokeAgent(leader, combinedText, userTs, 0, called, collaborators, allAttachments)
  }

  const MAX_CHAIN_DEPTH = 3
  const invokeAgent = async (
    target: OctoFile,
    prompt: string,
    userTs: number,
    depth: number,
    alreadyCalled: Set<string>,
    collaborators: OctoFile[] = [],
    attachments: Attachment[] = []
  ) => {
    if (!activeFolder) return
    const folderPathAtStart = activeFolder
    // Snapshot the current octos list so chain logic still works even if the
    // user switches to a different folder/workspace mid-run.
    const octosSnapshot = [...octos]

    const pendingId = `p-${userTs}-${target.name}-${depth}-${Date.now()}`
    const runId = `run-${userTs}-${target.name}-${depth}-${Math.random().toString(36).slice(2, 8)}`
    runMapRef.current.set(runId, { folderPath: folderPathAtStart, messageId: pendingId })

    // Show a placeholder bubble immediately. If the agent is busy we'll show
    // "Waiting for <name>…" until the previous run releases the lock.
    const lockKey = `${folderPathAtStart}::${target.name.toLowerCase()}`
    const previousLock = agentLocksRef.current.get(lockKey)
    const willQueue = !!previousLock
    setMessages((prev) => ({
      ...prev,
      [folderPathAtStart]: [
        ...(prev[folderPathAtStart] || []),
        {
          id: pendingId,
          agentName: target.name,
          text: '',
          ts: Date.now(),
          pending: true,
          activity: willQueue
            ? t('app.waiting', { name: target.name })
            : t('app.thinking'),
        },
      ],
    }))

    // Install our own promise as the new tail of the chain.
    let release: () => void = () => {}
    const ourLock = new Promise<void>((resolve) => { release = resolve })
    agentLocksRef.current.set(lockKey, ourLock)

    // Wait for the previous run on this agent to finish before we start.
    if (previousLock) {
      try { await previousLock } catch {}
      // Update the activity line now that we're starting.
      setMessages((prev) => {
        const list = prev[folderPathAtStart] || []
        return {
          ...prev,
          [folderPathAtStart]: list.map((m) =>
            m.id === pendingId ? { ...m, activity: t('app.thinking') } : m
          ),
        }
      })
    }

    const peers = octosSnapshot
      .filter((r) => r.name.toLowerCase() !== target.name.toLowerCase())
      .map((r) => ({ name: r.name, role: r.role }))

    const isLeader = depth === 0 && collaborators.length > 0
    const collaboratorPayload = collaborators.map((c) => ({ name: c.name, role: c.role }))

    // Prepare image paths for vision support
    const imagePaths = attachments
      .filter((a) => a.type === 'image')
      .map((a) => a.path)

    // Forward pasted-text attachments so agents can read them
    const textPaths = attachments
      .filter((a) => a.type === 'text')
      .map((a) => a.path)

    const res = await window.api.sendMessage({
      folderPath: folderPathAtStart,
      octoPath: target.path,
      prompt,
      userTs,
      runId,
      peers,
      collaborators: collaboratorPayload,
      isLeader,
      imagePaths: imagePaths.length > 0 ? imagePaths : undefined,
      textPaths: textPaths.length > 0 ? textPaths : undefined,
    })

    runMapRef.current.delete(runId)

    // Release our lock slot so the next queued caller can proceed.
    if (agentLocksRef.current.get(lockKey) === ourLock) {
      agentLocksRef.current.delete(lockKey)
    }
    release()

    const rawText = res.ok ? res.output : `Error: ${res.error}`
    const permReq = res.ok ? parsePermissionRequest(rawText, target.name) : undefined

    setMessages((prev) => {
      const list = prev[folderPathAtStart] || []
      return {
        ...prev,
        [folderPathAtStart]: list.map((m) =>
          m.id === pendingId
            ? {
                ...m,
                text: permReq ? stripPermissionTag(rawText) : rawText,
                pending: false,
                error: !res.ok,
                activity: undefined,
                permissionRequest: permReq,
              }
            : m
        ),
      }
    })

    // Chain: parse @mentions from the agent's response
    if (!res.ok || depth >= MAX_CHAIN_DEPTH) return
    const mentioned = parseMentions(res.output)
    if (mentioned.length === 0) return

    const nextTargets = octosSnapshot.filter((r) => {
      const ln = r.name.toLowerCase()
      return (
        ln !== target.name.toLowerCase() &&
        !alreadyCalled.has(ln) &&
        mentioned.some((m) => m.toLowerCase() === ln)
      )
    })
    if (nextTargets.length === 0) return

    // Ask the classifier whether this is a real handoff, a proposal that needs
    // user approval, or just a passing reference.
    const classification = await window.api.classifyMention({
      speakerName: target.name,
      speakerText: res.output,
      mentionedNames: nextTargets.map((r) => r.name),
    })

    const decision =
      classification.ok ? classification.decision : 'approval'

    if (decision === 'ignore') return

    if (decision === 'approval') {
      // Park the chain on the speaker's message — user decides via the UI.
      setMessages((prev) => {
        const list = prev[folderPathAtStart] || []
        return {
          ...prev,
          [folderPathAtStart]: list.map((m) =>
            m.id === pendingId
              ? {
                  ...m,
                  handoff: { targets: nextTargets.map((r) => r.name) },
                }
              : m
          ),
        }
      })
      // Remember the context so approval can resume the chain with full info.
      pendingHandoffsRef.current.set(pendingId, {
        folderPath: folderPathAtStart,
        speakerName: target.name,
        speakerOutput: res.output,
        nextTargetPaths: nextTargets.map((r) => r.path),
        userTs,
        depth,
        alreadyCalled: new Set(alreadyCalled),
      })
      return
    }

    // handoff: auto-chain
    for (const next of nextTargets) {
      const contextPrompt = `${target.name} just said in the group chat:\n\n"${res.output}"\n\n${target.name} mentioned you (@${next.name}) and may want your input. Respond to their message.`
      const newCalled = new Set(alreadyCalled)
      newCalled.add(next.name.toLowerCase())
      invokeAgent(next, contextPrompt, userTs, depth + 1, newCalled)
    }
  }

  // Map of messageId -> stored handoff context, so approval can resume a parked chain.
  const pendingHandoffsRef = useRef<
    Map<
      string,
      {
        folderPath: string
        speakerName: string
        speakerOutput: string
        nextTargetPaths: string[]
        userTs: number
        depth: number
        alreadyCalled: Set<string>
      }
    >
  >(new Map())

  const approveHandoff = (messageId: string) => {
    const ctx = pendingHandoffsRef.current.get(messageId)
    if (!ctx) return
    pendingHandoffsRef.current.delete(messageId)

    // Mark the message as approved so the UI hides the buttons.
    setMessages((prev) => {
      const list = prev[ctx.folderPath] || []
      return {
        ...prev,
        [ctx.folderPath]: list.map((m) =>
          m.id === messageId && m.handoff
            ? { ...m, handoff: { ...m.handoff, approved: true } }
            : m
        ),
      }
    })

    const nextTargets = octos.filter((r) => ctx.nextTargetPaths.includes(r.path))
    for (const next of nextTargets) {
      const contextPrompt = `${ctx.speakerName} said in the group chat:\n\n"${ctx.speakerOutput}"\n\n${ctx.speakerName} asked the user whether to involve you, and the user approved. Respond to their message and take over the part they asked you to handle.`
      const newCalled = new Set(ctx.alreadyCalled)
      newCalled.add(next.name.toLowerCase())
      invokeAgent(next, contextPrompt, ctx.userTs, ctx.depth + 1, newCalled)
    }
  }

  const dismissHandoff = (messageId: string) => {
    const ctx = pendingHandoffsRef.current.get(messageId)
    if (!ctx) return
    pendingHandoffsRef.current.delete(messageId)
    setMessages((prev) => {
      const list = prev[ctx.folderPath] || []
      return {
        ...prev,
        [ctx.folderPath]: list.map((m) =>
          m.id === messageId && m.handoff
            ? { ...m, handoff: { ...m.handoff, approved: false } }
            : m
        ),
      }
    })
  }

  const grantPermission = async (messageId: string) => {
    if (!activeFolder) return
    const folderMsgs = messages[activeFolder] || []
    const msg = folderMsgs.find((m) => m.id === messageId)
    if (!msg?.permissionRequest?.agentPath) return

    const { permissions, agentPath } = msg.permissionRequest
    const permUpdate: OctoPermissions = {}
    for (const p of permissions) {
      permUpdate[p] = true
    }
    const res = await window.api.updateOcto({ octoPath: agentPath, permissions: permUpdate })
    if (!res.ok) return

    // Mark as granted in UI
    setMessages((prev) => {
      const list = prev[activeFolder] || []
      return {
        ...prev,
        [activeFolder]: list.map((m) =>
          m.id === messageId && m.permissionRequest
            ? { ...m, permissionRequest: { ...m.permissionRequest, granted: true } }
            : m
        ),
      }
    })
    // Refresh octo list so future calls use updated permissions
    const updatedOctos = await window.api.listOctos(activeFolder)
    setOctos(updatedOctos)

    // Auto re-invoke the agent after permission grant
    // Find the agent that requested permissions
    const agentName = msg.agentName
    const targetOcto = updatedOctos.find(
      (o) => o.name.toLowerCase() === agentName?.toLowerCase()
    )
    if (targetOcto) {
      // Find the last user message before the permission request
      const msgIndex = folderMsgs.findIndex((m) => m.id === messageId)
      let lastUserMsg: Message | undefined
      for (let i = msgIndex - 1; i >= 0; i--) {
        if (folderMsgs[i].agentName === 'user') {
          lastUserMsg = folderMsgs[i]
          break
        }
      }
      if (lastUserMsg) {
        const retryPrompt = t('app.permRetryPrompt', { request: lastUserMsg.text })
        invokeAgent(targetOcto, retryPrompt, lastUserMsg.ts, 0, new Set())
      }
    }
  }

  const dismissPermission = (messageId: string) => {
    if (!activeFolder) return
    setMessages((prev) => {
      const list = prev[activeFolder] || []
      return {
        ...prev,
        [activeFolder]: list.map((m) =>
          m.id === messageId && m.permissionRequest
            ? { ...m, permissionRequest: { ...m.permissionRequest, granted: false } }
            : m
        ),
      }
    })
  }

  // ── Render ──

  return (
    <div className={`app platform-${platform} ${!leftSidebarOpen ? 'left-sidebar-collapsed' : ''} ${!rightSidebarOpen ? 'right-sidebar-collapsed' : ''} ${compactMode ? 'compact-mode' : ''}`}>
      {/* Overlay backdrop for compact mode */}
      {compactMode && (leftSidebarOpen || rightSidebarOpen) && (
        <div
          className="sidebar-overlay-backdrop"
          onClick={() => { setLeftSidebarOpen(false); setRightSidebarOpen(false) }}
        />
      )}
      {leftSidebarOpen && (
        <LeftSidebar
          activeWorkspace={activeWorkspace}
          state={state}
          activeFolder={activeFolder}
          centerTab={centerTab}
          setCenterTab={setCenterTab}
          activityCount={folderActivity.length}
          workspaceMenuOpen={workspaceMenuOpen}
          setWorkspaceMenuOpen={setWorkspaceMenuOpen}
          setActiveFolder={setActiveFolder}
          switchWorkspace={switchWorkspace}
          removeWorkspace={removeWorkspace}
          removeFolder={removeFolder}
          pickFolder={pickFolder}
          setShowCreateWorkspace={setShowCreateWorkspace}
          onCollapse={() => setLeftSidebarOpen(false)}
        />
      )}

      <div className={`center-panel ${centerTab === 'activity' || centerTab === 'settings' ? 'center-panel--wide' : ''}`}>
        {centerTab === 'chat' ? (
          <ChatPanel
            activeFolder={activeFolder}
            activeWorkspace={activeWorkspace}
            octos={octos}
            folderMessages={folderMessages}
            input={input}
            setInput={setInput}
            mentionOpen={mentionOpen}
            setMentionOpen={setMentionOpen}
            mentionQuery={mentionQuery}
            setMentionQuery={setMentionQuery}
            send={send}
            onApproveHandoff={approveHandoff}
            onDismissHandoff={dismissHandoff}
            onGrantPermission={grantPermission}
            onDismissPermission={dismissPermission}
            hasMoreMessages={!!hasMoreMessages[activeFolder || '']}
            loadingMore={loadingMore}
            onLoadMore={loadMoreMessages}
            hasPendingAgents={folderMessages.some((m) => m.pending)}
            leftSidebarOpen={leftSidebarOpen}
            rightSidebarOpen={rightSidebarOpen}
            onToggleLeftSidebar={() => setLeftSidebarOpen((v) => !v)}
            onToggleRightSidebar={() => setRightSidebarOpen((v) => !v)}
            onStopAll={async () => {
              await window.api.stopAllAgents()
              // Clear pending state from all messages in current folder
              if (activeFolder) {
                setMessages((prev) => ({
                  ...prev,
                  [activeFolder]: (prev[activeFolder] || []).map((m) =>
                    m.pending ? { ...m, pending: false, text: m.text || t('app.stopped') } : m,
                  ),
                }))
              }
            }}
          />
        ) : centerTab === 'activity' ? (
          <ActivityPanel activityLog={folderActivity} octos={octos} />
        ) : centerTab === 'settings' ? (
          <SettingsPanel />
        ) : state.activeWorkspaceId ? (
          <WikiPanel workspaceId={state.activeWorkspaceId} />
        ) : null}
      </div>

      {centerTab === 'chat' && rightSidebarOpen && (
        <RightSidebar
          octos={octos}
          activeFolder={activeFolder}
          activityLog={folderActivity}
          setInput={setInput}
          setEditingAgent={setEditingAgent}
          setShowCreateAgent={setShowCreateAgent}
        />
      )}

      {editingAgent && activeFolder && (
        <EditAgentModal
          agent={editingAgent}
          onClose={() => setEditingAgent(null)}
          onSaved={() => {
            setEditingAgent(null)
            if (activeFolder) window.api.listOctos(activeFolder).then(setOctos)
          }}
          onDeleted={() => {
            setEditingAgent(null)
            if (activeFolder) window.api.listOctos(activeFolder).then(setOctos)
          }}
        />
      )}

      {showCreateAgent && activeFolder && (
        <CreateAgentModal
          folderPath={activeFolder}
          onClose={() => setShowCreateAgent(false)}
          onCreated={() => {
            setShowCreateAgent(false)
            if (activeFolder) window.api.listOctos(activeFolder).then(setOctos)
          }}
        />
      )}

      {showCreateWorkspace && (
        <CreateWorkspaceModal
          canCancel={state.workspaces.length > 0}
          onClose={() => setShowCreateWorkspace(false)}
          onCreated={async (name) => {
            const fresh = await window.api.createWorkspace(name)
            setState(fresh)
            setShowCreateWorkspace(false)
          }}
        />
      )}

      {showWelcome && (
        <WelcomeModal
          onPickFolder={async () => {
            if (!state.activeWorkspaceId) return
            const p = await window.api.pickFolder(state.activeWorkspaceId)
            if (!p) return // picker cancelled → keep modal open
            const fresh = await window.api.loadState()
            setState(fresh)
            setActiveFolder(p)
            setShowWelcome(false)
          }}
        />
      )}

      {!showWelcome && activeWorkspace && activeWorkspace.folders.length === 0 && (
        <OpenFolderModal
          onPickFolder={async () => {
            if (!state.activeWorkspaceId) return
            const p = await window.api.pickFolder(state.activeWorkspaceId)
            if (!p) return // picker cancelled → keep modal open
            const fresh = await window.api.loadState()
            setState(fresh)
            setActiveFolder(p)
          }}
        />
      )}

      {claudeCliStatus && (!claudeCliStatus.installed || !claudeCliStatus.loggedIn) && (
        <ClaudeLoginModal
          installed={claudeCliStatus.installed}
          onDismiss={() => setClaudeCliStatus(null)}
        />
      )}
    </div>
  )
}
