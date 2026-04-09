import { useState } from 'react'
import { useTranslation, Trans } from 'react-i18next'
import { EmojiPicker } from '../EmojiPicker'
import { AlertTriangle } from 'lucide-react'

interface CreateAgentModalProps {
  folderPath: string
  onClose: () => void
  onCreated: () => void
}

export function CreateAgentModal({ folderPath, onClose, onCreated }: CreateAgentModalProps) {
  const { t } = useTranslation()
  const [name, setName] = useState('')
  const [role, setRole] = useState('')
  const [icon, setIcon] = useState('')
  const [color, setColor] = useState('')
  const [fileWrite, setFileWrite] = useState(false)
  const [bash, setBash] = useState(false)
  const [network, setNetwork] = useState(false)
  const [allowPaths, setAllowPaths] = useState('')
  const [denyPaths, setDenyPaths] = useState('')
  const [mcpJson, setMcpJson] = useState('')
  const [mcpError, setMcpError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [limitReached, setLimitReached] = useState<number | null>(null)

  const create = async () => {
    setError(null)
    setMcpError(null)
    setLimitReached(null)
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

    // Parse MCP config
    let mcpServers: McpServersConfig | undefined
    if (mcpJson.trim()) {
      try {
        mcpServers = JSON.parse(mcpJson.trim())
      } catch {
        setMcpError(t('mcp.jsonError'))
        return
      }
    }

    const res = await window.api.createOcto({
      folderPath,
      name,
      role,
      icon: icon || undefined,
      color: color || undefined,
      permissions,
      mcpServers,
    })
    if (res.ok) {
      onCreated()
    } else if (res.error.startsWith('AGENT_LIMIT:')) {
      const max = parseInt(res.error.split(':')[1], 10)
      setLimitReached(max)
    } else {
      setError(res.error)
    }
  }

  // Agent limit popup
  if (limitReached !== null) {
    return (
      <div className="modal-backdrop" onClick={onClose}>
        <div className="modal" onClick={(e) => e.stopPropagation()}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, padding: '8px 0' }}>
            <AlertTriangle size={36} style={{ color: 'var(--warning, #f0a030)' }} />
            <div className="modal-title" style={{ marginBottom: 0 }}>{t('agents.limit')}</div>
            <p
              style={{ color: 'var(--text-secondary)', textAlign: 'center', margin: 0, fontSize: 13, lineHeight: 1.5 }}
            >
              <Trans
                i18nKey="agents.limitMsg"
                values={{ max: limitReached }}
                components={{ strong: <strong />, br: <br /> }}
              />
            </p>
          </div>
          <div className="modal-actions">
            <button className="btn-primary" onClick={onClose}>{t('common.ok')}</button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">{t('modals.createAgent.title')}</div>

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
          placeholder={t('modals.createAgent.namePlaceholder')}
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
        />

        <label className="modal-label">{t('label.role')}</label>
        <textarea
          className="modal-textarea"
          placeholder={t('modals.createAgent.rolePlaceholder')}
          value={role}
          onChange={(e) => setRole(e.target.value)}
        />

        <label className="modal-label">{t('modals.createAgent.permissions')}</label>
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

        <label className="modal-label">{t('mcp.title')}</label>
        <div className="modal-hint" style={{ marginTop: 0 }}>
          {t('mcp.hint')}
        </div>
        <textarea
          className="modal-textarea"
          placeholder={t('mcp.placeholder')}
          value={mcpJson}
          onChange={(e) => { setMcpJson(e.target.value); setMcpError(null) }}
          rows={6}
          style={{ fontFamily: 'monospace', fontSize: 12 }}
        />
        {mcpError && <div className="modal-error">{mcpError}</div>}

        {error && <div className="modal-error">{error}</div>}

        <div className="modal-actions">
          <button className="btn-secondary" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn-primary" onClick={create}>
            {t('common.create')}
          </button>
        </div>
      </div>
    </div>
  )
}
