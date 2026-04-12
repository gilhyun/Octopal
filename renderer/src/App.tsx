import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import './i18n'
import type { ActivityLogEntry, Attachment, InterruptConfirm, Message, PermissionRequest, TokenUsage } from './types'
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
import { FileAccessApprovalModal, type FileAccessDecision } from './components/modals/FileAccessApprovalModal'
import { SettingsPanel } from './components/SettingsPanel'
import { TaskBoard } from './components/TaskBoard'
import { ToastContainer, showToast } from './components/Toast'
import { expandShortcut } from './shortcut-expander'

/** Race a promise against a timeout. Rejects with a descriptive error if ms elapses. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

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
  const [centerTab, setCenterTab] = useState<'chat' | 'wiki' | 'activity' | 'settings' | 'tasks'>('chat')
  const [leftSidebarOpen, setLeftSidebarOpen] = useState(true)
  const [rightSidebarOpen, setRightSidebarOpen] = useState(true)
  const [platform, setPlatform] = useState<string>('darwin')

  // File access approval modal state
  const [fileAccessRequest, setFileAccessRequest] = useState<{
    requestId: string
    agentName: string
    targetPath: string
    reason?: string
    blocked?: boolean
  } | null>(null)

  // runId -> { folderPath, messageId } so activity events can find the right bubble
  const runMapRef = useRef<Map<string, { folderPath: string; messageId: string }>>(new Map())

  // Per-agent FIFO lock — key is `${folderPath}::${agentNameLower}`.
  // When an invokeAgent call starts, it awaits the previous promise on this key,
  // then replaces it with its own. This guarantees a single agent is never running
  // two Claude processes in parallel (which would corrupt history and race on files).
  const agentLocksRef = useRef<Map<string, Promise<void>>>(new Map())

  // Track active agent runs for bundling/interrupt — key is `${folderPath}::${agentNameLower}`
  const activeRunsRef = useRef<Map<string, {
    agentName: string
    runId: string
    prompt: string
    userTs: number
  }>>(new Map())

  // Pending interrupt confirmations — resolve(true) = proceed, resolve(false) = cancel
  const pendingInterruptRef = useRef<Map<string, {
    resolve: (confirmed: boolean) => void
    messageId: string
    folderPath: string
    runningAgents: string[]
    bufferedText: string
    bufferedAttachments: Attachment[]
    userTs: number
  }>>(new Map())

  // Track active chain runs for completion reporting — key is `chain-${userTs}`
  const activeChainRef = useRef<Map<string, {
    folderPath: string
    userTs: number
    originalPrompt: string
    agents: Set<string>           // agents involved in this chain
    completedAgents: Set<string>  // agents that finished
    startTs: number
  }>>(new Map())

  // MCP status per agent (keyed by agent path)
  const [mcpStatuses, setMcpStatuses] = useState<Record<string, McpStatus>>({})

  // Text shortcuts for token-saving expansions (loaded from settings)
  const shortcutsRef = useRef<TextShortcut[]>([])

  // Debounce buffer: collect consecutive user messages before triggering agents
  const DEBOUNCE_MS = 1200
  const bufferRef = useRef<{
    folderPath: string
    messages: Array<{ text: string; ts: number; attachments?: Attachment[] }>
    timer: ReturnType<typeof setTimeout> | null
  } | null>(null)

  const activeWorkspace = state.workspaces.find((w) => w.id === state.activeWorkspaceId) || null

  // ── MCP Health Check ──

  // Check MCP health for all agents that have MCP servers configured
  const checkMcpHealth = async (agents: OctoFile[]) => {
    const mcpAgents = agents.filter((a) => a.mcpServers && Object.keys(a.mcpServers).length > 0)
    if (mcpAgents.length === 0) return

    // Mark all as checking
    setMcpStatuses((prev) => {
      const next = { ...prev }
      for (const a of mcpAgents) next[a.path] = 'checking'
      return next
    })

    // Run health checks in parallel
    await Promise.allSettled(
      mcpAgents.map(async (agent) => {
        try {
          const result = await window.api.mcpHealthCheck({ mcpServers: agent.mcpServers! })
          if (!result.ok) {
            setMcpStatuses((prev) => ({ ...prev, [agent.path]: 'error' }))
            return
          }
          const allOk = Object.values(result.results).every((r) => r.status === 'ok')
          setMcpStatuses((prev) => ({ ...prev, [agent.path]: allOk ? 'ok' : 'error' }))
        } catch {
          setMcpStatuses((prev) => ({ ...prev, [agent.path]: 'error' }))
        }
      })
    )
  }

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
      shortcutsRef.current = settings.shortcuts?.textExpansions || []
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

  // Listen for MCP token expiry notifications from main process
  useEffect(() => {
    return window.api.onMcpTokenExpiry((data) => {
      // Mark agent MCP status as error
      const agent = octos.find((o) => o.name === data.agentName)
      if (agent) setMcpStatuses((prev) => ({ ...prev, [agent.path]: 'error' }))

      showToast({
        type: 'warning',
        title: t('mcpValidation.tokenExpiry'),
        message: t('mcpValidation.tokenExpiryMessage', {
          agent: data.agentName,
          server: data.serverName,
        }),
        duration: 0, // sticky — user must dismiss
        action: {
          label: t('mcpValidation.updateToken'),
          onClick: () => {
            if (agent) setEditingAgent(agent)
          },
        },
      })
    })
  }, [t, octos])

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
          setMessages((prev) => ({ ...prev, [folder]: history.map(m => ({ ...m, text: sanitizeDisplayText(m.text ?? '') })) }))

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

      // Hydrate pending-handoff state from disk so the Approve/Dismiss
      // buttons survive window reloads. The persisted blob uses
      // { handoffs: { [messageId]: ctx } } with Sets stored as arrays.
      let hydratedHandoffs = new Map<string, any>()
      try {
        const raw = await window.api.readPendingState(folder)
        const entries = (raw?.handoffs ?? {}) as Record<string, any>
        for (const [id, ctx] of Object.entries(entries)) {
          hydratedHandoffs.set(id, {
            folderPath: ctx.folderPath,
            speakerName: ctx.speakerName,
            speakerOutput: ctx.speakerOutput,
            nextTargetPaths: ctx.nextTargetPaths || [],
            nextTargetReasons: ctx.nextTargetReasons || [],
            userTs: ctx.userTs,
            depth: ctx.depth ?? 0,
            alreadyCalled: new Set(ctx.alreadyCalled || []),
          })
          pendingHandoffsRef.current.set(id, {
            folderPath: ctx.folderPath,
            speakerName: ctx.speakerName,
            speakerOutput: ctx.speakerOutput,
            nextTargetPaths: ctx.nextTargetPaths || [],
            nextTargetReasons: ctx.nextTargetReasons || [],
            userTs: ctx.userTs,
            depth: ctx.depth ?? 0,
            alreadyCalled: new Set<string>(ctx.alreadyCalled || []),
          })
        }
      } catch {
        // Non-fatal — fall through with empty hydration
      }

      setMessages((prev) => {
        const existing = prev[folder] || []
        // Preserve pending messages and unresolved permission requests (in-memory only)
        const preserveMessages = existing.filter(
          (m) => m.pending || (m.permissionRequest && m.permissionRequest.granted === undefined)
        )
        // Re-attach hydrated `handoff` field to the matching history messages
        // so the Approve/Dismiss buttons re-appear on reload.
        const attachHandoff = (m: Message): Message => {
          const ctx = hydratedHandoffs.get(m.id)
          if (!ctx) return m
          return {
            ...m,
            handoff: {
              targets: ctx.nextTargetPaths
                .map((path: string) => existingOctos.find((o) => o.path === path)?.name)
                .filter((n: string | undefined): n is string => !!n),
            },
          }
        }
        // Strip protocol tags from every loaded history message so users
        // never see raw <HANDOFF> or <!--NEEDS_PERMISSIONS--> markup.
        const cleanHistory = history.map(m => ({ ...m, text: sanitizeDisplayText(m.text ?? '') }))
        if (preserveMessages.length === 0) {
          return { ...prev, [folder]: cleanHistory.map(attachHandoff) }
        }
        const historyIds = new Set(cleanHistory.map((m) => m.id))
        const missingPreserved = preserveMessages.filter((m) => !historyIds.has(m.id))
        const permMap = new Map(
          preserveMessages
            .filter((m) => m.permissionRequest)
            .map((m) => [m.id, m.permissionRequest])
        )
        const mergedHistory = cleanHistory.map((m) => {
          let merged: Message = m
          if (permMap.has(m.id)) merged = { ...merged, permissionRequest: permMap.get(m.id) }
          merged = attachHandoff(merged)
          return merged
        })
        return { ...prev, [folder]: [...mergedHistory, ...missingPreserved] }
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
      const existingIds = new Set(existing.map((m) => m.id))
      const newOlder = older
        .filter((m) => !existingIds.has(m.id))
        .map(m => ({ ...m, text: sanitizeDisplayText(m.text ?? '') }))
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

  // Watch for .octo file changes in the active folder (cross-window sync)
  useEffect(() => {
    const unsubscribe = window.api.onOctosChanged((changedFolder) => {
      if (changedFolder === activeFolder) {
        // Refresh the agent list in the sidebar
        window.api.listOctos(changedFolder).then(setOctos)

        // Refresh chat messages (merge with in-flight pending messages)
        window.api.loadHistoryPaged({ folderPath: changedFolder, limit: PAGE_SIZE }).then(({ messages: history, hasMore }) => {
          setHasMoreMessages((prev) => ({ ...prev, [changedFolder]: hasMore }))
          const cleanHistory = history.map(m => ({ ...m, text: sanitizeDisplayText(m.text ?? '') }))
          setMessages((prev) => {
            const existing = prev[changedFolder] || []
            const preserveMessages = existing.filter(
              (m) => (m.pending && !m.id.startsWith('remote-')) || (m.permissionRequest && m.permissionRequest.granted === undefined)
            )
            if (preserveMessages.length === 0) {
              return { ...prev, [changedFolder]: cleanHistory }
            }
            const historyIds = new Set(cleanHistory.map((m) => m.id))
            const missingPreserved = preserveMessages.filter((m) => !historyIds.has(m.id))
            const permMap = new Map(
              preserveMessages
                .filter((m) => m.permissionRequest)
                .map((m) => [m.id, m.permissionRequest])
            )
            const mergedHistory = cleanHistory.map((m) =>
              permMap.has(m.id) ? { ...m, permissionRequest: permMap.get(m.id) } : m
            )
            return { ...prev, [changedFolder]: [...mergedHistory, ...missingPreserved] }
          })
        })
      }
    })
    return unsubscribe
  }, [activeFolder])

  // Run MCP health checks when agents change
  useEffect(() => {
    if (octos.length > 0) checkMcpHealth(octos)
  }, [octos.map((o) => `${o.path}:${JSON.stringify(o.mcpServers)}`).join(',')])

  // Listen for agent activity (tool calls) and update the pending bubble.
  // For the window that sent the message, runMapRef has the mapping.
  // For OTHER windows, we create a temporary "remote pending" bubble so the
  // typing indicator is visible everywhere.
  useEffect(() => {
    const unsubscribe = window.api.onActivity(({ runId, text, folderPath: evFolder, agentName: evAgent }) => {
      const mapping = runMapRef.current.get(runId)
      if (mapping) {
        // This window owns the run — update the existing pending message
        setMessages((prev) => {
          const list = prev[mapping.folderPath] || []
          return {
            ...prev,
            [mapping.folderPath]: list.map((m) =>
              m.id === mapping.messageId ? { ...m, activity: text } : m
            ),
          }
        })
      } else if (evFolder && evAgent) {
        // Another window's run — show a remote typing indicator
        const remotePendingId = `remote-${runId}`
        setMessages((prev) => {
          const list = prev[evFolder] || []
          const existing = list.find((m) => m.id === remotePendingId)
          if (existing) {
            // Update existing remote pending bubble
            return {
              ...prev,
              [evFolder]: list.map((m) =>
                m.id === remotePendingId ? { ...m, activity: text } : m
              ),
            }
          }
          // Create a new remote pending bubble
          return {
            ...prev,
            [evFolder]: [
              ...list,
              {
                id: remotePendingId,
                agentName: evAgent,
                text: '',
                ts: Date.now(),
                pending: true,
                activity: text,
              },
            ],
          }
        })
      }
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
          backupId: entry.backupId,
          conflictWith: entry.conflictWith,
        }].slice(-200) // cap at 200 entries per folder
        return { ...prev, [entry.folderPath]: next }
      })
    })
    return unsubscribe
  }, [])

  // Token usage: attach usage reports to the corresponding message bubbles
  useEffect(() => {
    const unsubscribe = window.api.onUsageReport(({ runId, usage }) => {
      const mapping = runMapRef.current.get(runId)
      if (!mapping) return
      setMessages((prev) => {
        const list = prev[mapping.folderPath] || []
        return {
          ...prev,
          [mapping.folderPath]: list.map((m) =>
            m.id === mapping.messageId ? { ...m, usage } : m
          ),
        }
      })
    })
    return unsubscribe
  }, [])

  // Listen for file access approval requests from main process
  useEffect(() => {
    const unsubscribe = window.api.onFileAccessRequest((data) => {
      setFileAccessRequest(data)
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

  /**
   * Parse structured <HANDOFF target="..." reason="..."> tags from an
   * agent's reply. This is the ONLY way to trigger a chain to another
   * agent — free @mentions in the body are just references.
   *
   * Format is forgiving about quote styles and whitespace, and `reason` is
   * optional. Multiple tags are allowed (parallel fan-out).
   */
  const parseHandoffTags = (text: string): Array<{ target: string; reason: string }> => {
    // Use `"` as the canonical delimiter (matching the prompt instruction).
    // The reason text may contain single quotes, parentheses, URLs, etc. —
    // `[^"]*` allows everything except the closing double-quote.
    const re = /<HANDOFF\s+target\s*=\s*"([^"]+)"(?:\s+reason\s*=\s*"([^"]*)")?\s*\/?>/gi
    const out: Array<{ target: string; reason: string }> = []
    let m
    while ((m = re.exec(text)) !== null) {
      out.push({ target: m[1].trim(), reason: (m[2] || '').trim() })
    }
    return out
  }

  /** Strip <HANDOFF ...> tags from displayed text so users don't see the protocol. */
  const stripHandoffTags = (text: string): string =>
    text.replace(/<HANDOFF\s+target\s*=\s*"[^"]+"(?:\s+reason\s*=\s*"[^"]*")?\s*\/?>/gi, '').trim()

  /**
   * Clean protocol tags from message text. Used both at invoke-time (real-time
   * response) AND at history-load time (room-history.json → messages state).
   * Without this, reloading the app would show raw `<HANDOFF>` and
   * `<!--NEEDS_PERMISSIONS-->` tags in the chat bubbles.
   */
  const sanitizeDisplayText = (text: string): string =>
    stripHandoffTags(stripPermissionTag(text))

  const send = (attachments?: Attachment[]) => {
    const hasText = input.trim().length > 0
    const hasAttachments = attachments && attachments.length > 0
    console.log('[Send] input:', JSON.stringify(input.trim()), 'hasText:', hasText, 'hasAttachments:', hasAttachments, 'activeFolder:', activeFolder)
    if ((!hasText && !hasAttachments) || !activeFolder) return

    // Expand text shortcuts before sending — saves tokens & enables Layer 0 routing
    let text = input.trim()
    if (shortcutsRef.current.length > 0) {
      const match = expandShortcut(text, shortcutsRef.current)
      if (match) {
        text = match.expandedText
      }
    }

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
    console.log('[FlushBuffer] folderPath:', folderPath, 'messages:', bufferedMessages.length, 'texts:', bufferedMessages.map(m => m.text))

    let combinedText =
      bufferedMessages.length === 1
        ? bufferedMessages[0].text
        : bufferedMessages.map((m, i) => `(${i + 1}) ${m.text}`).join('\n')

    // Collect all attachments from buffered messages
    const allAttachments: Attachment[] = bufferedMessages.flatMap(
      (m) => m.attachments || []
    )

    const userTs = bufferedMessages[0].ts

    // ── Message Bundling & Interrupt ────────────────────
    // Check if any agent is currently running in this folder.
    // If so, determine if the new message is related (supplement/modify)
    // and interrupt + bundle if needed.
    const runningInFolder = Array.from(activeRunsRef.current.entries())
      .filter(([key]) => key.startsWith(`${folderPath}::`))

    if (runningInFolder.length > 0) {
      const [, activeRun] = runningInFolder[0]
      // When multiple agents are running, confirm with the user before
      // interrupting. When a single agent is running, interrupt silently —
      // the user just typed, so they expect the new message to land.
      if (runningInFolder.length > 1) {
        const runningAgentNames = runningInFolder.map(([, r]) => r.agentName)
        const confirmMsgId = `interrupt-confirm-${Date.now()}`

        const confirmed = await new Promise<boolean>((resolve) => {
          pendingInterruptRef.current.set(confirmMsgId, {
            resolve,
            messageId: confirmMsgId,
            folderPath,
            runningAgents: runningAgentNames,
            bufferedText: combinedText,
            bufferedAttachments: allAttachments,
            userTs,
          })

          setMessages((prev) => ({
            ...prev,
            [folderPath]: [
              ...(prev[folderPath] || []),
              {
                id: confirmMsgId,
                agentName: '__system__',
                text: t('app.interruptConfirm', {
                  count: runningInFolder.length,
                  agents: runningAgentNames.join(', '),
                }),
                ts: Date.now(),
                pending: false,
                interruptConfirm: {
                  runningAgents: runningAgentNames,
                },
              },
            ],
          }))
        })

        if (!confirmed) {
          // User cancelled — don't interrupt, don't route this message
          return
        }
      }

      // Interrupt all running agents in this folder
      for (const [, run] of runningInFolder) {
        await window.api.stopAgent(run.runId)
      }

      // Show a system message about the interrupt + bundle
      const bundleMsgId = `bundle-${Date.now()}`
      const stoppedNames = runningInFolder.length > 1
        ? runningInFolder.map(([, r]) => `@${r.agentName}`).join(', ')
        : `@${activeRun.agentName}`
      setMessages((prev) => ({
        ...prev,
        [folderPath]: [
          ...(prev[folderPath] || []),
          {
            id: bundleMsgId,
            agentName: '__system__',
            text: runningInFolder.length > 1
              ? t('app.bundleMultiStop', { agents: stoppedNames, count: runningInFolder.length })
              : t('app.bundleForward', { agent: activeRun.agentName }),
            ts: Date.now(),
            pending: false,
          },
        ],
      }))

      // Merge original prompt + new message so the rerouted agent gets full
      // context. Replaces the old "modify vs supplement" classifier (always
      // returned supplement), which was a stub that added overhead without
      // improving quality.
      combinedText = `${activeRun.prompt}\n\n${t('app.additionalInstruction', { text: combinedText })}`
    }

    // ── Routing ─────────────────────────────────────────
    const allMentions = bufferedMessages.flatMap((m) => parseMentions(m.text))
    console.log('[Routing] allMentions:', allMentions, 'octos:', octos.map(o => o.name), 'hidden:', octos.filter(o => o.hidden).map(o => o.name))
    let leader: OctoFile | null = null
    let collaborators: OctoFile[] = []
    let dispatcherModel: 'sonnet' | 'opus' | undefined

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
    }

    // If no leader yet (no mentions, or mentions didn't match any agent), use dispatcher.
    // Isolated agents are excluded — they can only be reached via explicit @mention.
    if (!leader) {
      const visibleAgents = octos.filter((r) => !r.hidden && !r.isolated)
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
              dispatcherAgents: visibleAgents.map((r) => r.name),
            },
          ],
        }))
        const recent = (messages[folderPath] || [])
          .filter((m) => m.agentName !== '__dispatcher__' && m.agentName !== '__system__' && !m.pending)
          .slice(-6)
          .map((m) => ({ agentName: m.agentName, text: m.text }))
        let res: { ok: boolean; leader?: string; collaborators?: string[]; model?: string }
        try {
          res = await withTimeout(
            window.api.dispatch({
              message: combinedText,
              agents: visibleAgents.map((r) => ({ name: r.name, role: r.role })),
              recentHistory: recent,
              folderPath,
            }),
            20_000,
            'Dispatcher routing',
          )
        } catch (err) {
          console.warn('[Dispatcher] routing failed, falling back to first visible agent:', err)
          res = { ok: false }
        } finally {
          setMessages((prev) => ({
            ...prev,
            [folderPath]: (prev[folderPath] || []).filter((m) => m.id !== dispatcherMsgId),
          }))
        }
        if (res.ok) {
          const leaderMatch = octos.find((r) => r.name === res.leader)
          if (leaderMatch) {
            leader = leaderMatch
            collaborators = octos.filter((r) => (res.collaborators ?? []).includes(r.name))
            dispatcherModel = res.model
          }
        }
        // Fallback: if dispatcher failed or returned no leader, pick first visible agent
        if (!leader) {
          leader = visibleAgents[0]
          console.warn('[Dispatcher] No leader resolved, falling back to:', leader.name)
        }
      }
    }

    if (!leader) {
      console.error('[Routing] ❌ No leader found! Aborting.')
      return
    }

    console.log('[Routing] ✅ leader:', leader.name, 'collaborators:', collaborators.map(c => c.name), 'model:', dispatcherModel)
    const called = new Set<string>([leader.name.toLowerCase()])
    invokeAgent(leader, combinedText, userTs, 0, called, collaborators, allAttachments, dispatcherModel)
  }

  // No hard depth limit — the alreadyCalled set prevents cycles naturally.
  // Safety cap only to guard against truly pathological edge cases.
  const MAX_CHAIN_DEPTH = 50
  const invokeAgent = async (
    target: OctoFile,
    prompt: string,
    userTs: number,
    depth: number,
    alreadyCalled: Set<string>,
    collaborators: OctoFile[] = [],
    attachments: Attachment[] = [],
    model?: 'sonnet' | 'opus'
  ) => {
    if (!activeFolder) return
    const folderPathAtStart = activeFolder
    // Snapshot the current octos list so chain logic still works even if the
    // user switches to a different folder/workspace mid-run.
    const octosSnapshot = [...octos]

    // Chain tracking for completion reporting
    const chainKey = `chain-${userTs}`
    if (depth === 0) {
      activeChainRef.current.set(chainKey, {
        folderPath: folderPathAtStart,
        userTs,
        originalPrompt: prompt,
        agents: new Set([target.name]),
        completedAgents: new Set(),
        startTs: Date.now(),
      })
    } else {
      const chain = activeChainRef.current.get(chainKey)
      if (chain) chain.agents.add(target.name)
    }

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
    // Timeout after 120s to prevent infinite hang if a previous run is stuck.
    if (previousLock) {
      try {
        await withTimeout(previousLock, 120_000, `Agent lock wait (${target.name})`)
      } catch (err) {
        console.warn(`[AgentLock] ${target.name} lock wait timed out, proceeding anyway:`, err)
        // Force-clear the stale lock so future runs aren't blocked
        if (agentLocksRef.current.get(lockKey) !== ourLock) {
          agentLocksRef.current.delete(lockKey)
        }
      }
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

    // Peers = every other visible, non-isolated agent. Isolated agents are
    // not surfaced as handoff targets — they're single-shot workers that
    // only run when the user explicitly @mentions them.
    const peers = octosSnapshot
      .filter((r) => r.name.toLowerCase() !== target.name.toLowerCase())
      .filter((r) => !r.isolated)
      .map((r) => ({ name: r.name, role: r.role }))

    const isLeader = depth === 0 && collaborators.length > 0
    const collaboratorPayload = collaborators.map((c) => ({ name: c.name, role: c.role }))

    // Track this run for bundling/interrupt
    activeRunsRef.current.set(lockKey, {
      agentName: target.name,
      runId,
      prompt,
      userTs,
    })

    // Prepare image paths for vision support
    const imagePaths = attachments
      .filter((a) => a.type === 'image')
      .map((a) => a.path)

    // Forward pasted-text attachments so agents can read them
    const textPaths = attachments
      .filter((a) => a.type === 'text')
      .map((a) => a.path)

    console.log('[InvokeAgent] 🚀 target:', target.name, 'depth:', depth, 'prompt:', prompt.slice(0, 100), 'model:', model, 'octoPath:', target.path)
    let res: { ok: boolean; output: string; error?: string }
    try {
      res = await window.api.sendMessage({
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
        model,
      })
    } catch (err) {
      console.error('[InvokeAgent] ❌ sendMessage error for', target.name, ':', err)
      res = { ok: false, output: '', error: String(err) }
    } finally {
      runMapRef.current.delete(runId)
      activeRunsRef.current.delete(lockKey)

      // Release our lock slot so the next queued caller can proceed.
      if (agentLocksRef.current.get(lockKey) === ourLock) {
        agentLocksRef.current.delete(lockKey)
      }
      release()
    }

    // Handle interrupted responses — remove the pending bubble silently
    if (res.ok && res.output === '[interrupted]') {
      setMessages((prev) => ({
        ...prev,
        [folderPathAtStart]: (prev[folderPathAtStart] || []).filter(
          (m) => m.id !== pendingId
        ),
      }))
      return // Don't chain — bundled re-invocation will handle it
    }

    console.log('[InvokeAgent] 📥 response for', target.name, '- ok:', res.ok, 'output length:', res.output?.length, 'error:', res.error, 'output preview:', res.output?.slice(0, 200))
    const rawText = res.ok ? res.output : `Error: ${res.error}`
    const permReq = res.ok ? parsePermissionRequest(rawText, target.name) : undefined
    // Hide both the permission-request tag and the handoff tag from the
    // rendered bubble so users never see the protocol markup.
    const displayText = stripHandoffTags(permReq ? stripPermissionTag(rawText) : rawText)

    setMessages((prev) => {
      const list = prev[folderPathAtStart] || []
      return {
        ...prev,
        [folderPathAtStart]: list.map((m) =>
          m.id === pendingId
            ? {
                ...m,
                text: displayText,
                pending: false,
                error: !res.ok,
                activity: undefined,
                permissionRequest: permReq,
              }
            : m
        ),
      }
    })

    // Mark this agent as completed in the chain
    const chain = activeChainRef.current.get(chainKey)
    if (chain) chain.completedAgents.add(target.name)

    // Helper: emit completion report if all chain agents are done
    const maybeReportChainCompletion = () => {
      const c = activeChainRef.current.get(chainKey)
      if (!c || c.agents.size < 2) {
        // Single-agent task — no need for a summary report
        activeChainRef.current.delete(chainKey)
        return
      }
      if (c.completedAgents.size < c.agents.size) return // still running
      activeChainRef.current.delete(chainKey)

      const elapsed = Math.round((Date.now() - c.startTs) / 1000)
      const agentList = Array.from(c.agents).map((n) => `@${n}`).join(', ')
      const reportMsgId = `chain-report-${Date.now()}`
      setMessages((prev) => ({
        ...prev,
        [c.folderPath]: [
          ...(prev[c.folderPath] || []),
          {
            id: reportMsgId,
            agentName: '__system__',
            text: t('app.chainComplete', {
              agents: agentList,
              count: c.agents.size,
              elapsed,
            }),
            ts: Date.now(),
            pending: false,
          },
        ],
      }))
    }

    // Chain: parse the structured <HANDOFF> tag from the agent's response.
    // Replaces the old "@mention + classifier" pipeline — agents now emit an
    // explicit marker when they want to delegate, and the UI hides the tag
    // from the rendered text. Any free-form @mention in the reply is just a
    // reference, not a handoff.
    if (!res.ok || depth >= MAX_CHAIN_DEPTH) {
      maybeReportChainCompletion()
      return
    }
    const handoffs = parseHandoffTags(res.output)
    if (handoffs.length === 0) {
      maybeReportChainCompletion()
      return
    }

    const nextTargets = handoffs
      .map((h) => {
        const ln = h.target.toLowerCase()
        if (ln === target.name.toLowerCase()) return null
        if (alreadyCalled.has(ln)) return null
        const octo = octosSnapshot.find((r) => r.name.toLowerCase() === ln)
        return octo ? { octo, reason: h.reason } : null
      })
      .filter((x): x is { octo: OctoFile; reason: string } => x !== null)

    if (nextTargets.length === 0) {
      maybeReportChainCompletion()
      return
    }

    // Always gate handoffs on user approval for safety — the user can see
    // both the speaker's reply and the proposed target before the chain
    // continues. (Future: per-agent "auto-delegate" flag to skip this.)
    setMessages((prev) => {
      const list = prev[folderPathAtStart] || []
      return {
        ...prev,
        [folderPathAtStart]: list.map((m) =>
          m.id === pendingId
            ? {
                ...m,
                handoff: { targets: nextTargets.map((n) => n.octo.name) },
              }
            : m
        ),
      }
    })
    pendingHandoffsRef.current.set(pendingId, {
      folderPath: folderPathAtStart,
      speakerName: target.name,
      speakerOutput: res.output,
      nextTargetPaths: nextTargets.map((n) => n.octo.path),
      nextTargetReasons: nextTargets.map((n) => n.reason),
      userTs,
      depth,
      alreadyCalled: new Set(alreadyCalled),
    })
    persistPendingState(folderPathAtStart)
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
        /** Per-target reason extracted from the <HANDOFF reason="..."> attribute. Index-aligned with nextTargetPaths. */
        nextTargetReasons: string[]
        userTs: number
        depth: number
        alreadyCalled: Set<string>
      }
    >
  >(new Map())

  /**
   * Persist the pending-handoff map for a folder to disk. Serialization
   * converts the Sets to arrays; the inverse runs on hydration in the folder
   * switch effect below.
   *
   * Written opportunistically — failure is non-fatal. Worst case: a window
   * reload loses the pending approval buttons and the user has to resend.
   */
  const persistPendingState = (folderPath: string) => {
    const entries: Record<string, any> = {}
    for (const [id, ctx] of pendingHandoffsRef.current.entries()) {
      if (ctx.folderPath !== folderPath) continue
      entries[id] = {
        folderPath: ctx.folderPath,
        speakerName: ctx.speakerName,
        speakerOutput: ctx.speakerOutput,
        nextTargetPaths: ctx.nextTargetPaths,
        nextTargetReasons: ctx.nextTargetReasons,
        userTs: ctx.userTs,
        depth: ctx.depth,
        alreadyCalled: Array.from(ctx.alreadyCalled),
      }
    }
    window.api.writePendingState(folderPath, { handoffs: entries }).catch(() => {
      // Non-fatal — next write will try again.
    })
  }

  const approveHandoff = (messageId: string) => {
    const ctx = pendingHandoffsRef.current.get(messageId)
    if (!ctx) return
    pendingHandoffsRef.current.delete(messageId)
    persistPendingState(ctx.folderPath)

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

    // The target agent will see the speaker's full message (and all prior
    // room history) in the shared "Recent conversation" section of its
    // system prompt — no need to quote the speaker's reply back to it.
    // The user-prompt here just states the intent and passes along the
    // per-target reason the speaker gave.
    for (let i = 0; i < ctx.nextTargetPaths.length; i++) {
      const path = ctx.nextTargetPaths[i]
      const reason = ctx.nextTargetReasons[i] || ''
      const next = octos.find((r) => r.path === path)
      if (!next) continue

      const reasonLine = reason ? ` Reason: "${reason}".` : ''
      const contextPrompt = `@${ctx.speakerName} handed off to you (@${next.name}) and the user approved.${reasonLine} Pick up the task — the full conversation is in your recent-conversation context.`
      const newCalled = new Set(ctx.alreadyCalled)
      newCalled.add(next.name.toLowerCase())
      invokeAgent(next, contextPrompt, ctx.userTs, ctx.depth + 1, newCalled)
    }
  }

  const dismissHandoff = (messageId: string) => {
    const ctx = pendingHandoffsRef.current.get(messageId)
    if (!ctx) return
    pendingHandoffsRef.current.delete(messageId)
    persistPendingState(ctx.folderPath)
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

  const confirmInterrupt = (messageId: string) => {
    const ctx = pendingInterruptRef.current.get(messageId)
    if (!ctx) return
    pendingInterruptRef.current.delete(messageId)
    setMessages((prev) => {
      const list = prev[ctx.folderPath] || []
      return {
        ...prev,
        [ctx.folderPath]: list.map((m) =>
          m.id === messageId && m.interruptConfirm
            ? { ...m, interruptConfirm: { ...m.interruptConfirm, confirmed: true } }
            : m
        ),
      }
    })
    ctx.resolve(true)
  }

  const cancelInterrupt = (messageId: string) => {
    const ctx = pendingInterruptRef.current.get(messageId)
    if (!ctx) return
    pendingInterruptRef.current.delete(messageId)
    setMessages((prev) => {
      const list = prev[ctx.folderPath] || []
      return {
        ...prev,
        [ctx.folderPath]: list.map((m) =>
          m.id === messageId && m.interruptConfirm
            ? { ...m, interruptConfirm: { ...m.interruptConfirm, confirmed: false } }
            : m
        ),
      }
    })
    ctx.resolve(false)
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
        if (folderMsgs[i].agentName === 'user' || folderMsgs[i].agentName === 'You') {
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

      <div className={`center-panel ${centerTab === 'activity' || centerTab === 'timeline' || centerTab === 'settings' || centerTab === 'tasks' ? 'center-panel--wide' : ''}`}>
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
            onConfirmInterrupt={confirmInterrupt}
            onCancelInterrupt={cancelInterrupt}
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

              // Clear activeRunsRef entries for ALL folders (not just current)
              activeRunsRef.current.clear()

              // Clear pending state from ALL folders, not just the current one
              setMessages((prev) => {
                const next = { ...prev }
                for (const folderKey of Object.keys(next)) {
                  next[folderKey] = (next[folderKey] || []).map((m) =>
                    m.pending ? { ...m, pending: false, text: m.text || t('app.stopped') } : m,
                  )
                }
                return next
              })
            }}
            shortcuts={shortcutsRef.current}
          />
        ) : centerTab === 'activity' ? (
          <ActivityPanel
            activityLog={folderActivity}
            octos={octos}
            folderMessages={folderMessages}
            folderPath={activeFolder ?? undefined}
          />
        ) : centerTab === 'tasks' ? (
          <TaskBoard />
        ) : centerTab === 'settings' ? (
          <SettingsPanel onSettingsSaved={(s) => {
            shortcutsRef.current = s.shortcuts?.textExpansions || []
          }} />
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
          mcpStatuses={mcpStatuses}
        />
      )}

      {editingAgent && activeFolder && (
        <EditAgentModal
          agent={editingAgent}
          folderPath={activeFolder}
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
          onClose={() => {
            setShowCreateAgent(false)
            if (activeFolder) window.api.listOctos(activeFolder).then(setOctos)
          }}
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
          onStatusChange={(status) => setClaudeCliStatus(status)}
        />
      )}

      {fileAccessRequest && (
        <FileAccessApprovalModal
          agentName={fileAccessRequest.agentName}
          targetPath={fileAccessRequest.targetPath}
          reason={fileAccessRequest.reason}
          blocked={fileAccessRequest.blocked}
          onDecision={(decision: FileAccessDecision) => {
            window.api.respondFileAccess({
              requestId: fileAccessRequest.requestId,
              decision,
              targetPath: fileAccessRequest.targetPath,
              projectFolder: activeFolder || undefined,
            })
            setFileAccessRequest(null)
          }}
          onClose={() => setFileAccessRequest(null)}
        />
      )}

      <ToastContainer />
    </div>
  )
}
