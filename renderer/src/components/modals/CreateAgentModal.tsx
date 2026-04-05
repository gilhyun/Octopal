import { useState } from 'react'
import { EmojiPicker } from '../EmojiPicker'

interface CreateAgentModalProps {
  folderPath: string
  onClose: () => void
  onCreated: () => void
}

export function CreateAgentModal({ folderPath, onClose, onCreated }: CreateAgentModalProps) {
  const [name, setName] = useState('')
  const [role, setRole] = useState('')
  const [icon, setIcon] = useState('')
  const [color, setColor] = useState('')
  const [fileWrite, setFileWrite] = useState(false)
  const [bash, setBash] = useState(false)
  const [network, setNetwork] = useState(false)
  const [allowPaths, setAllowPaths] = useState('')
  const [denyPaths, setDenyPaths] = useState('')
  const [error, setError] = useState<string | null>(null)

  const create = async () => {
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
    const res = await window.api.createRune({
      folderPath,
      name,
      role,
      icon: icon || undefined,
      color: color || undefined,
      permissions,
    })
    if (res.ok) onCreated()
    else setError(res.error)
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">New agent</div>

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
          placeholder="reviewer"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
        />

        <label className="modal-label">Role</label>
        <textarea
          className="modal-textarea"
          placeholder="Code reviewer, security focused"
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
          <button className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" onClick={create}>
            Create
          </button>
        </div>
      </div>
    </div>
  )
}
