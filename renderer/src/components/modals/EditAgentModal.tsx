import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { EmojiPicker } from '../EmojiPicker'
import { McpValidationModal } from './McpValidationModal'
import { AgentModelTab } from './AgentModelTab'

type AgentTab = 'basic' | 'prompt' | 'permissions' | 'model' | 'mcp'

interface EditAgentModalProps {
  agent: OctoFile
  folderPath: string
  onClose: () => void
  onSaved: () => void
  onDeleted: () => void
}

const MAX_AGENT_NAME_LENGTH = 80

export type AgentNameValidationError = 'required' | 'invalid' | 'tooLong' | null

/**
 * Mirror the safe, single-path-component character set used when creating an
 * agent. This is UX validation only; the IPC command remains the security
 * boundary and must perform the same validation independently.
 */
export function validateAgentName(name: string): AgentNameValidationError {
  const trimmed = name.trim()
  if (!trimmed) return 'required'
  if (!/^[\p{L}\p{N}_ -]+$/u.test(trimmed)) return 'invalid'
  if (Array.from(trimmed).length > MAX_AGENT_NAME_LENGTH) return 'tooLong'
  return null
}

function formatMcpJson(mcpServers: McpServersConfig | null | undefined): string {
  if (!mcpServers || Object.keys(mcpServers).length === 0) return ''
  return JSON.stringify(mcpServers, null, 2)
}

export function EditAgentModal({ agent, folderPath, onClose, onSaved, onDeleted }: EditAgentModalProps) {
  const { t } = useTranslation()
  const [tab, setTab] = useState<AgentTab>('basic')
  const [name, setName] = useState(agent.name)
  const [role, setRole] = useState(agent.role)
  const [prompt, setPrompt] = useState('')
  const [promptLoading, setPromptLoading] = useState(true)
  const [promptLoadError, setPromptLoadError] = useState<string | null>(null)
  const [icon, setIcon] = useState(agent.icon || '')
  const [color, setColor] = useState(agent.color || '')
  const [fileWrite, setFileWrite] = useState(agent.permissions?.fileWrite === true)
  const [bash, setBash] = useState(agent.permissions?.bash === true)
  const [network, setNetwork] = useState(agent.permissions?.network === true)
  const [allowPaths, setAllowPaths] = useState((agent.permissions?.allowPaths || []).join(', '))
  const [denyPaths, setDenyPaths] = useState((agent.permissions?.denyPaths || []).join(', '))
  const [mcpJson, setMcpJson] = useState(formatMcpJson(agent.mcpServers))
  const [mcpError, setMcpError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [showMcpValidation, setShowMcpValidation] = useState(false)
  const [pendingMcpServers, setPendingMcpServers] = useState<McpServersConfig | null>(null)
  // Phase 6 §5.1 — per-agent provider/model. `undefined` ⇒ inherit
  // workspace default at turn time (rendered as "Use workspace default"
  // checkbox). Initial values come from the agent's stored config.
  const [provider, setProvider] = useState<string | undefined>(agent.provider)
  const [model, setModel] = useState<string | undefined>(agent.model)

  // Load prompt.md content on mount
  useEffect(() => {
    let cancelled = false
    setPrompt('')
    setPromptLoading(true)
    setPromptLoadError(null)
    window.api.readAgentPrompt(agent.path).then((res) => {
      if (cancelled) return
      if (res.ok) {
        setPrompt(res.path)
      } else {
        setPromptLoadError(res.error)
      }
      setPromptLoading(false)
    }).catch((e: unknown) => {
      if (cancelled) return
      setPromptLoadError(e instanceof Error ? e.message : String(e))
      setPromptLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [agent.path])

  const save = async () => {
    setError(null)
    setMcpError(null)

    const nameValidationError = validateAgentName(name)
    if (nameValidationError) {
      setTab('basic')
      return
    }

    // Parse & validate MCP config
    let mcpServers: McpServersConfig | null = null
    if (mcpJson.trim()) {
      try {
        mcpServers = JSON.parse(mcpJson.trim())
      } catch {
        setMcpError(t('mcp.jsonError'))
        setTab('mcp')
        return
      }
    }

    const permissions: OctoPermissions = {
      fileWrite,
      bash,
      network,
      allowPaths: allowPaths
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      denyPaths: denyPaths
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    }
    setSaving(true)
    try {
      const res = await window.api.updateOcto({
        octoPath: agent.path,
        name: name.trim(),
        role,
        // Never turn a not-yet-loaded (or failed-to-load) prompt into an
        // explicit empty write. `undefined` crosses the adapter as null and
        // Rust treats it as "do not touch prompt.md".
        prompt: !promptLoading && !promptLoadError ? prompt : undefined,
        icon,
        color,
        permissions,
        mcpServers,
        // Phase 6 — 3-state forwarding:
        //   undefined → don't touch (inherits previous value if any)
        //   ""        → REMOVE the field (user clicked "Use workspace default")
        //   "<value>" → set
        // Local state uses `undefined` for inherit, so we map to "" on
        // the wire when the user previously had a value but cleared it.
        // For agents that never had the field, `agent.provider` is
        // already undefined and we keep it that way (no wire write).
        provider: provider === undefined && agent.provider !== undefined ? '' : provider,
        model: model === undefined && agent.model !== undefined ? '' : model,
      })
      if (res.ok) {
        // If MCP servers were configured, run validation
        if (mcpServers && Object.keys(mcpServers).length > 0) {
          setPendingMcpServers(mcpServers)
          setShowMcpValidation(true)
        } else {
          onSaved()
        }
      } else {
        setError(res.error)
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const remove = async () => {
    if (!confirm(t('modals.editAgent.deleteConfirm', { name: agent.name }))) return
    const res = await window.api.deleteOcto(agent.path)
    if (res.ok) onDeleted()
    else setError(res.error)
  }

  if (showMcpValidation && pendingMcpServers) {
    return (
      <McpValidationModal
        mcpServers={pendingMcpServers}
        onClose={() => { setShowMcpValidation(false); onSaved() }}
        onDone={() => { setShowMcpValidation(false); onSaved() }}
      />
    )
  }

  const tabs: { id: AgentTab; label: string }[] = [
    { id: 'basic', label: t('modals.editAgent.tabBasic') },
    { id: 'prompt', label: t('modals.editAgent.tabPrompt') },
    { id: 'permissions', label: t('modals.editAgent.tabPermissions') },
    { id: 'model', label: t('modals.editAgent.tabModel') },
    { id: 'mcp', label: t('modals.editAgent.tabMcp') },
  ]
  const nameValidationError = validateAgentName(name)

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">{t('modals.editAgent.title')}</div>

        <div className="agent-modal-tabs">
          {tabs.map((tb) => (
            <button
              key={tb.id}
              className={`agent-modal-tab ${tab === tb.id ? 'active' : ''}`}
              onClick={() => setTab(tb.id)}
            >
              {tb.label}
            </button>
          ))}
        </div>

        <div className="agent-modal-tab-content">
          {tab === 'basic' && (
            <>
              <EmojiPicker
                value={icon}
                onChange={setIcon}
                name={name || '?'}
                color={color || undefined}
                onColorChange={setColor}
              />

              <label className="modal-label">{t('label.name')}</label>
              <input
                className="modal-input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                aria-invalid={nameValidationError !== null}
                aria-describedby={nameValidationError ? 'edit-agent-name-error' : undefined}
              />
              {nameValidationError && (
                <div id="edit-agent-name-error" className="modal-error" role="alert">
                  {nameValidationError === 'required'
                    ? t('modals.editAgent.nameRequired')
                    : nameValidationError === 'tooLong'
                      ? t('modals.editAgent.nameTooLong', { max: MAX_AGENT_NAME_LENGTH })
                      : t('modals.editAgent.nameInvalid')}
                </div>
              )}

              <label className="modal-label">{t('label.role')}</label>
              <input
                className="modal-input"
                value={role}
                onChange={(e) => setRole(e.target.value)}
                placeholder={t('modals.editAgent.rolePlaceholder')}
              />
              <div className="modal-hint">{t('modals.editAgent.roleHint')}</div>
            </>
          )}

          {tab === 'prompt' && (
            <>
              <label className="modal-label" style={{ marginTop: 0 }}>{t('modals.editAgent.promptLabel')}</label>
              <div className="modal-hint" style={{ marginTop: 0 }}>
                {t('modals.editAgent.promptHint')}
              </div>
              {promptLoading ? (
                <div style={{ color: 'var(--text-secondary)', fontSize: 13, padding: '12px 0' }}>
                  {t('common.loading')}
                </div>
              ) : promptLoadError ? (
                <div className="modal-error" role="alert">
                  {t('modals.editAgent.promptLoadError', { error: promptLoadError })}
                </div>
              ) : (
                <textarea
                  className="modal-textarea modal-textarea--mono"
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder={t('modals.editAgent.promptPlaceholder')}
                  rows={12}
                />
              )}
            </>
          )}

          {tab === 'permissions' && (
            <>
              <label className="modal-label" style={{ marginTop: 0 }}>{t('modals.createAgent.permissions')}</label>
              <div className="modal-hint" style={{ marginTop: 0 }}>
                {t('modals.createAgent.permissionsHint')}
              </div>
              <div className="perm-row">
                <label className="perm-toggle">
                  <input
                    type="checkbox"
                    checked={fileWrite}
                    onChange={(e) => setFileWrite(e.target.checked)}
                  />
                  <span>{t('modals.createAgent.permFileWrite')}</span>
                </label>
                <label className="perm-toggle">
                  <input
                    type="checkbox"
                    checked={bash}
                    onChange={(e) => setBash(e.target.checked)}
                  />
                  <span>{t('modals.createAgent.permShell')}</span>
                </label>
                <label className="perm-toggle">
                  <input
                    type="checkbox"
                    checked={network}
                    onChange={(e) => setNetwork(e.target.checked)}
                  />
                  <span>{t('modals.createAgent.permNetwork')}</span>
                </label>
              </div>

              <label className="modal-label">{t('modals.createAgent.allowPaths')}</label>
              <input
                className="modal-input"
                placeholder={t('modals.createAgent.allowPathsPlaceholder')}
                value={allowPaths}
                onChange={(e) => setAllowPaths(e.target.value)}
              />

              <label className="modal-label">{t('modals.createAgent.denyPaths')}</label>
              <input
                className="modal-input"
                placeholder={t('modals.createAgent.denyPathsPlaceholder')}
                value={denyPaths}
                onChange={(e) => setDenyPaths(e.target.value)}
              />
            </>
          )}

          {tab === 'model' && (
            <AgentModelTab
              provider={provider}
              model={model}
              onProviderChange={setProvider}
              onModelChange={setModel}
            />
          )}

          {tab === 'mcp' && (
            <>
              <label className="modal-label" style={{ marginTop: 0 }}>{t('mcp.title')}</label>
              <div className="modal-hint" style={{ marginTop: 0 }}>
                {t('mcp.hint')}
              </div>
              <textarea
                className="modal-textarea modal-textarea--mono"
                placeholder={t('mcp.placeholder')}
                value={mcpJson}
                onChange={(e) => { setMcpJson(e.target.value); setMcpError(null) }}
                rows={8}
              />
              {mcpError && <div className="modal-error">{mcpError}</div>}
            </>
          )}
        </div>

        {error && <div className="modal-error">{error}</div>}

        <div className="modal-actions">
          <button className="btn-danger" onClick={remove}>
            {t('common.delete')}
          </button>
          <div style={{ flex: 1 }} />
          <button className="btn-secondary" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            className="btn-primary"
            onClick={save}
            disabled={saving || nameValidationError !== null}
          >
            {saving ? t('common.saving') : t('common.save')}
          </button>
        </div>
      </div>
    </div>
  )
}
