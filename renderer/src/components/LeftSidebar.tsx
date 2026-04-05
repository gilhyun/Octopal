import { useRef, useEffect } from 'react'
import { basename } from '../utils'
import { FolderOpen, ChevronDown, X } from 'lucide-react'

interface LeftSidebarProps {
  activeWorkspace: Workspace | null
  state: AppState
  activeFolder: string | null
  workspaceMenuOpen: boolean
  setWorkspaceMenuOpen: (v: boolean | ((prev: boolean) => boolean)) => void
  setActiveFolder: (f: string) => void
  switchWorkspace: (id: string) => void
  removeWorkspace: (id: string) => void
  removeFolder: (p: string) => void
  pickFolder: () => void
  setShowCreateWorkspace: (v: boolean) => void
}

export function LeftSidebar({
  activeWorkspace,
  state,
  activeFolder,
  workspaceMenuOpen,
  setWorkspaceMenuOpen,
  setActiveFolder,
  switchWorkspace,
  removeWorkspace,
  removeFolder,
  pickFolder,
  setShowCreateWorkspace,
}: LeftSidebarProps) {
  const folders = activeWorkspace?.folders || []
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!workspaceMenuOpen) return

    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setWorkspaceMenuOpen(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [workspaceMenuOpen, setWorkspaceMenuOpen])

  return (
    <aside className="left-sidebar">
      <div className="sidebar-header drag" />
      <div className="workspace-section" ref={menuRef}>
        <button
          className="workspace-switcher"
          onClick={() => setWorkspaceMenuOpen((v: boolean) => !v)}
        >
          <span className="workspace-name">{activeWorkspace?.name || 'RuneChat'}</span>
          <span className="workspace-caret"><ChevronDown size={14} /></span>
        </button>
        {workspaceMenuOpen && (
          <div className="workspace-menu">
            {state.workspaces.map((w) => (
              <div
                key={w.id}
                className={`workspace-item ${w.id === state.activeWorkspaceId ? 'active' : ''}`}
                onClick={() => switchWorkspace(w.id)}
              >
                <span className="workspace-item-name">{w.name}</span>
                {state.workspaces.length > 1 && (
                  <button
                    className="workspace-item-remove"
                    onClick={(e) => {
                      e.stopPropagation()
                      removeWorkspace(w.id)
                    }}
                    title="Remove workspace"
                  >
                    <X size={14} />
                  </button>
                )}
              </div>
            ))}
            <div className="workspace-divider" />
            <button
              className="workspace-add"
              onClick={() => {
                setWorkspaceMenuOpen(false)
                setShowCreateWorkspace(true)
              }}
            >
              + New workspace
            </button>
          </div>
        )}
      </div>
      <div className="section-label">Folders</div>
      <div className="project-list">
        {folders.map((f) => (
          <button
            key={f}
            className={`project-item ${f === activeFolder ? 'active' : ''}`}
            onClick={() => setActiveFolder(f)}
            onContextMenu={(e) => {
              e.preventDefault()
              if (confirm(`Remove ${basename(f)} from the list?`)) removeFolder(f)
            }}
            title={f}
          >
            <span className="project-icon"><FolderOpen size={16} /></span>
            <span className="project-name">{basename(f)}</span>
          </button>
        ))}
        <button className="add-btn" onClick={pickFolder} disabled={!activeWorkspace}>
          + Open folder
        </button>
      </div>
    </aside>
  )
}
