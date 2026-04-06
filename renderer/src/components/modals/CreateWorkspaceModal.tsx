import { useState } from 'react'

interface CreateWorkspaceModalProps {
  canCancel: boolean
  onClose: () => void
  onCreated: (name: string) => void
}

export function CreateWorkspaceModal({ canCancel, onClose, onCreated }: CreateWorkspaceModalProps) {
  const [name, setName] = useState('')

  return (
    <div className="modal-backdrop" onClick={canCancel ? onClose : undefined}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        {!canCancel && (
          <div className="welcome-mascot">
            <img src="logo.png" alt="Octopal" className="welcome-mascot-img" />
          </div>
        )}
        <div className="modal-title" style={!canCancel ? { textAlign: 'center' } : undefined}>
          {canCancel ? 'New workspace' : 'Welcome to Octopal'}
        </div>
        {!canCancel && (
          <div className="modal-hint" style={{ textAlign: 'center' }}>
            Start by creating a workspace. You can have multiple workspaces for different contexts
            — work, side projects, experiments.
          </div>
        )}
        <label className="modal-label">Workspace name</label>
        <input
          className="modal-input"
          placeholder="Personal"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && name.trim()) onCreated(name)
          }}
          autoFocus
        />
        <div className="modal-actions">
          {canCancel && (
            <button className="btn-secondary" onClick={onClose}>
              Cancel
            </button>
          )}
          <button
            className="btn-primary"
            disabled={!name.trim()}
            onClick={() => onCreated(name)}
          >
            Create
          </button>
        </div>
      </div>
    </div>
  )
}
