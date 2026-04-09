import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { EmojiPicker } from '../EmojiPicker'

interface EditAgentModalProps {
  agent: OctoFile
  folderPath: string
  onClose: () => void
  onSaved: () => void
  onDeleted: () => void
}

function formatMcpJson(mcpServers: McpServersConfig | null | undefined): string {
  if (!mcpServers || Object.keys(mcpServers).length === 0) return ''
  return JSON.stringify(mcpServers, null, 2)
}

export function EditAgentModal({ agent, folderPath, onClose, onSaved, onDeleted }: EditAgentModalProps) {
  const { t } = useTranslation()
  const [name, setName] = useState(agent.name)
  const [role, setRole] = useState(agent.role)
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

  const save = async () => {
    setError(null)
    setMcpError(null)

    // Parse & validate MCP config
    let mcpServers: McpServersConfig | null = null
    if (mcpJson.trim()) {
      try {
        mcpServers = JSON.parse(mcpJson.trim())
      } catch {
        setMcpError(t('mcp.jsonError'))
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
    const res = await window.api.updateOcto({
      octoPath: agent.path,
      name,
      role,
      icon,
      color,
      permissions,
      mcpServers,
    })
    if (res.ok) onSaved()
    else setError(res.error)
  }

  const remove = async () => {
    if (!confirm(t('modals.editAgent.deleteConfirm', { name: agent.name }))) return
    const res = await window.api.deleteOcto(agent.path)
    if (res.ok) onDeleted()
    else setError(res.error)
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">{t('modals.editAgent.title')}</div>

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
        />

        <label className="modal-label">{t('label.role')}</label>
        <textarea
          className="modal-textarea"
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
          <button className="btn-danger" onClick={remove}>
            {t('common.delete')}
          </button>
          <div style={{ flex: 1 }} />
          <button className="btn-secondary" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn-primary" onClick={save}>
            {t('common.save')}
          </button>
        </div>
      </div>
    </div>
  )
}
