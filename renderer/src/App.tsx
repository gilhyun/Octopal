import { useEffect, useRef, useState } from 'react'
import type { ActivityLogEntry, Attachment, Message } from './types'
import { LeftSidebar } from './components/LeftSidebar'
import { ChatPanel } from './components/ChatPanel'
import { WikiPanel } from './components/WikiPanel'
import { RightSidebar } from './components/RightSidebar'
import { CreateAgentModal } from './components/modals/CreateAgentModal'
import { CreateWorkspaceModal } from './components/modals/CreateWorkspaceModal'
import { EditAgentModal } from './components/modals/EditAgentModal'

export function App() {
  const [state, setState] = useState<AppState>({ workspaces: [], activeWorkspaceId: null })
  const [activeFolder, setActiveFolder] = useState<string | null>(null)
  const [runes, setRunes] = useState<RuneFile[]>([])
  const [messages, setMessages] = useState<Record<string, Message[]>>({})
  // Activity log of concrete actions (write/edit/bash/webfetch), keyed by folder
  const [activityLog, setActivityLog] = useState<Record<string, ActivityLogEntry[]>>({})
  const [input, setInput] = useState('')
  const [showCreateAgent, setShowCreateAgent] = useState(false)
  const [showCreateWorkspace, setShowCreateWorkspace] = useState(false)
  const [editingAgent, setEditingAgent] = useState<RuneFile | null>(null)
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false)
  const [mentionOpen, setMentionOpen] = useState(false)
  const [mentionQuery, setMentionQuery] = useState('')
  const [centerTab, setCenterTab] = useState<'chat' | 'wiki'>('chat')

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

  // Load state on mount
  useEffect(() => {
    window.api.loadState().then((s) => {
      setState(s)
      if (s.workspaces.length === 0) {
        setShowCreateWorkspace(true)
      } else {
        const active = s.workspaces.find((w) => w.id === s.activeWorkspaceId)
        if (active && active.folders.length > 0) setActiveFolder(active.folders[0])
      }
    })
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

  // Load runes + history when folder changes
  useEffect(() => {
    if (!activeFolder) {
      setRunes([])
      return
    }
    window.api.listRunes(activeFolder).then(setRunes)
    window.api.loadHistory(activeFolder).then((history) => {
      setMessages((prev) => ({ ...prev, [activeFolder]: history }))
    })
  }, [activeFolder])

  // Watch for .rune file changes in the active folder
  useEffect(() => {
    const unsubscribe = window.api.onRunesChanged((changedFolder) => {
      if (changedFolder === activeFolder) {
        window.api.listRunes(changedFolder).then(setRunes)
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
    if (!confirm('Remove this workspace? Folders inside remain on disk.')) return
    const fresh = await window.api.removeWorkspace(id)
    setState(fresh)
    setWorkspaceMenuOpen(false)
  }

  // ── Messaging ──

  const parseMentions = (text: string): string[] => {
    const re = /@(\w+)/g
    const found: string[] = []
    let m
    while ((m = re.exec(text)) !== null) found.push(m[1])
    return found
  }

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
    let leader: RuneFile | null = null
    let collaborators: RuneFile[] = []

    if (allMentions.length > 0) {
      const isAll = allMentions.includes('all')
      const mentionedAgents = isAll
        ? runes
        : runes.filter((r) =>
            allMentions.some((m) => r.name.toLowerCase() === m.toLowerCase())
          )
      if (mentionedAgents.length > 0) {
        leader = mentionedAgents[0]
        collaborators = mentionedAgents.slice(1)
      }
    } else if (runes.length > 0) {
      const dispatcherMsgId = `d-${userTs}`
      setMessages((prev) => ({
        ...prev,
        [folderPath]: [
          ...(prev[folderPath] || []),
          {
            id: dispatcherMsgId,
            agentName: '__dispatcher__',
            text: 'Routing…',
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
        agents: runes.map((r) => ({ name: r.name, role: r.role })),
        recentHistory: recent,
      })
      setMessages((prev) => ({
        ...prev,
        [folderPath]: (prev[folderPath] || []).filter((m) => m.id !== dispatcherMsgId),
      }))
      if (res.ok) {
        const leaderMatch = runes.find((r) => r.name === res.leader)
        if (leaderMatch) {
          leader = leaderMatch
          collaborators = runes.filter((r) => res.collaborators.includes(r.name))
        }
      }
    }

    if (!leader) return

    const called = new Set<string>([leader.name.toLowerCase()])
    invokeAgent(leader, combinedText, userTs, 0, called, collaborators, allAttachments)
  }

  const MAX_CHAIN_DEPTH = 3
  const invokeAgent = async (
    target: RuneFile,
    prompt: string,
    userTs: number,
    depth: number,
    alreadyCalled: Set<string>,
    collaborators: RuneFile[] = [],
    attachments: Attachment[] = []
  ) => {
    if (!activeFolder) return
    const folderPathAtStart = activeFolder

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
            ? `Waiting — ${target.name} is still working on a previous message…`
            : 'Thinking…',
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
            m.id === pendingId ? { ...m, activity: 'Thinking…' } : m
          ),
        }
      })
    }

    const peers = runes
      .filter((r) => r.name.toLowerCase() !== target.name.toLowerCase())
      .map((r) => ({ name: r.name, role: r.role }))

    const isLeader = depth === 0 && collaborators.length > 0
    const collaboratorPayload = collaborators.map((c) => ({ name: c.name, role: c.role }))

    // Prepare image paths for vision support
    const imagePaths = attachments
      .filter((a) => a.type === 'image')
      .map((a) => a.path)

    const res = await window.api.sendMessage({
      folderPath: folderPathAtStart,
      runePath: target.path,
      prompt,
      userTs,
      runId,
      peers,
      collaborators: collaboratorPayload,
      isLeader,
      imagePaths: imagePaths.length > 0 ? imagePaths : undefined,
    })

    runMapRef.current.delete(runId)

    // Release our lock slot so the next queued caller can proceed.
    if (agentLocksRef.current.get(lockKey) === ourLock) {
      agentLocksRef.current.delete(lockKey)
    }
    release()

    setMessages((prev) => {
      const list = prev[folderPathAtStart] || []
      return {
        ...prev,
        [folderPathAtStart]: list.map((m) =>
          m.id === pendingId
            ? {
                ...m,
                text: res.ok ? res.output : `Error: ${res.error}`,
                pending: false,
                error: !res.ok,
                activity: undefined,
              }
            : m
        ),
      }
    })

    // Chain: parse @mentions from the agent's response
    if (!res.ok || depth >= MAX_CHAIN_DEPTH) return
    const mentioned = parseMentions(res.output)
    if (mentioned.length === 0) return

    const nextTargets = runes.filter((r) => {
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

    const nextTargets = runes.filter((r) => ctx.nextTargetPaths.includes(r.path))
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

  // ── Render ──

  return (
    <div className="app">
      <LeftSidebar
        activeWorkspace={activeWorkspace}
        state={state}
        activeFolder={activeFolder}
        workspaceMenuOpen={workspaceMenuOpen}
        setWorkspaceMenuOpen={setWorkspaceMenuOpen}
        setActiveFolder={setActiveFolder}
        switchWorkspace={switchWorkspace}
        removeWorkspace={removeWorkspace}
        removeFolder={removeFolder}
        pickFolder={pickFolder}
        setShowCreateWorkspace={setShowCreateWorkspace}
      />

      <div className="center-panel">
        <div className="center-tabs drag">
          <button
            className={`center-tab ${centerTab === 'chat' ? 'active' : ''}`}
            onClick={() => setCenterTab('chat')}
          >
            Chat
          </button>
          <button
            className={`center-tab ${centerTab === 'wiki' ? 'active' : ''}`}
            onClick={() => setCenterTab('wiki')}
            disabled={!activeFolder}
          >
            Wiki
          </button>
        </div>
        {centerTab === 'chat' ? (
          <ChatPanel
            activeFolder={activeFolder}
            activeWorkspace={activeWorkspace}
            runes={runes}
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
          />
        ) : activeFolder ? (
          <WikiPanel activeFolder={activeFolder} />
        ) : null}
      </div>

      <RightSidebar
        runes={runes}
        activeFolder={activeFolder}
        activityLog={folderActivity}
        setInput={setInput}
        setEditingAgent={setEditingAgent}
        setShowCreateAgent={setShowCreateAgent}
      />

      {editingAgent && activeFolder && (
        <EditAgentModal
          agent={editingAgent}
          onClose={() => setEditingAgent(null)}
          onSaved={() => {
            setEditingAgent(null)
            if (activeFolder) window.api.listRunes(activeFolder).then(setRunes)
          }}
          onDeleted={() => {
            setEditingAgent(null)
            if (activeFolder) window.api.listRunes(activeFolder).then(setRunes)
          }}
        />
      )}

      {showCreateAgent && activeFolder && (
        <CreateAgentModal
          folderPath={activeFolder}
          onClose={() => setShowCreateAgent(false)}
          onCreated={() => {
            setShowCreateAgent(false)
            if (activeFolder) window.api.listRunes(activeFolder).then(setRunes)
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
    </div>
  )
}
