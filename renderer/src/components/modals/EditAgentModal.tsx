import { useState } from 'react'
import { EmojiPicker } from '../EmojiPicker'

interface EditAgentModalProps {
  agent: RuneFile
  onClose: () => void
  onSaved: () => void
  onDeleted: () => void
}

export function EditAgentModal({ agent, onClose, onSaved, onDeleted }: EditAgentModalProps) {
  const [name, setName] = useState(agent.name)
  const [role, setRole] = useState(agent.role)
  const [icon, setIcon] = useState(agent.icon || '')
  const [color, setColor] = useState(agent.color || '')
  const [fileWrite, setFileWrite] = useState(agent.permissions?.fileWrite === true)
  const [bash, setBash] = useState(agent.permissions?.bash === true)
  const [network, setNetwork] = useState(agent.permissions?.network === true)
  const [allowPaths, setAllowPaths] = useState((agent.permissions?.allowPaths || []).join(', '))
  const [denyPaths, setDenyPaths] = useState((agent.permissions?.denyPaths || []).join(', '))
  const [error, setError] = useState<string | null>(null)

  const save = async () => {
    setError(null)
    const permissions: RunePermissions = {
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
    const res = await window.api.updateRune({
      runePath: agent.path,
      name,
      role,
      icon,
      color,
      permissions,
    })
    if (res.ok) onSaved()
    else setError(res.error)
  }

  const remove = async () => {
    if (!confirm(`Delete ${agent.name}? This removes the .rune file permanently.`)) return
    const res = await window.api.deleteRune(agent.path)
    if (res.ok) onDeleted()
    else setError(res.error)
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">Edit agent</div>

        <EmojiPicker
          value={icon}
          onChange={setIcon}
          name={name || '?'}
          color={color || undefined}
          onColorChange={setColor}
        />

        <label className="modal-label">Name</label>
        <input
          className="modal-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />

        <label className="modal-label">Role</label>
        <textarea
          className="modal-textarea"
          value={role}
          onChange={(e) => setRole(e.target.value)}
        />

        <label className="modal-label">Permissions</label>
        <div className="modal-hint" style={{ marginTop: 0 }}>
          Without any of these, the agent can only reply with text. Turn one on to let it act.
        </div>
        <div className="perm-row">
          <label className="perm-toggle">
            <input
              type="checkbox"
              checked={fileWrite}
              onChange={(e) => setFileWrite(e.target.checked)}
            />
            <span>Write / edit files</span>
          </label>
          <label className="perm-toggle">
            <input
              type="checkbox"
              checked={bash}
              onChange={(e) => setBash(e.target.checked)}
            />
            <span>Run shell commands</span>
          </label>
          <label className="perm-toggle">
            <input
              type="checkbox"
              checked={network}
              onChange={(e) => setNetwork(e.target.checked)}
            />
            <span>Access the network</span>
          </label>
        </div>

        <label className="modal-label">Allow paths (comma-separated globs)</label>
        <input
          className="modal-input"
          placeholder="src/**, tests/**"
          value={allowPaths}
          onChange={(e) => setAllowPaths(e.target.value)}
        />

        <label className="modal-label">Deny paths</label>
        <input
          className="modal-input"
          placeholder=".env, secrets/**"
          value={denyPaths}
          onChange={(e) => setDenyPaths(e.target.value)}
        />

        {error && <div className="modal-error">{error}</div>}

        <div className="modal-actions">
          <button className="btn-danger" onClick={remove}>
            Delete
          </button>
          <div style={{ flex: 1 }} />
          <button className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" onClick={save}>
            Save
          </button>
        </div>
      </div>
    </div>
  )
}
