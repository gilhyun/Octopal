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
        <div className="modal-title">
          {canCancel ? 'New workspace' : 'Welcome to RuneChat'}
        </div>
        {!canCancel && (
          <div className="modal-hint">
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
