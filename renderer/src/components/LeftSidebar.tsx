import { useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { basename } from '../utils'
import { Plus, FolderOpen, ChevronDown, X, BookOpen, Activity, Settings, PanelLeftClose, LayoutGrid } from 'lucide-react'

interface LeftSidebarProps {
  activeWorkspace: Workspace | null
  state: AppState
  activeFolder: string | null
  centerTab: 'chat' | 'wiki' | 'activity' | 'settings' | 'tasks'
  setCenterTab: (tab: 'chat' | 'wiki' | 'activity' | 'settings' | 'tasks') => void
  activityCount: number
  workspaceMenuOpen: boolean
  setWorkspaceMenuOpen: (v: boolean | ((prev: boolean) => boolean)) => void
  setActiveFolder: (f: string | null) => void
  switchWorkspace: (id: string) => void
  removeWorkspace: (id: string) => void
  removeFolder: (p: string) => void
  pickFolder: () => void
  setShowCreateWorkspace: (v: boolean) => void
  onCollapse: () => void
}

export function LeftSidebar({
  activeWorkspace,
  state,
  activeFolder,
  centerTab,
  setCenterTab,
  activityCount,
  workspaceMenuOpen,
  setWorkspaceMenuOpen,
  setActiveFolder,
  switchWorkspace,
  removeWorkspace,
  removeFolder,
  pickFolder,
  setShowCreateWorkspace,
  onCollapse,
}: LeftSidebarProps) {
  const { t } = useTranslation()
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
      <div className="sidebar-header drag" data-tauri-drag-region>
        <div style={{ flex: 1 }} />
        <button
          className="sidebar-toggle-btn"
          onClick={onCollapse}
          title={t('sidebar.collapseSidebar')}
        >
          <PanelLeftClose size={16} />
        </button>
      </div>
      <div className="workspace-section" ref={menuRef}>
        <button
          className="workspace-switcher"
          onClick={() => setWorkspaceMenuOpen((v: boolean) => !v)}
        >
          <span className="workspace-name">{activeWorkspace?.name || 'Octopal'}</span>
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
                    title={t('sidebar.removeWorkspace')}
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
              {t('sidebar.newWorkspace')}
            </button>
          </div>
        )}
      </div>
      <div className="sidebar-nav">
        <button
          className={`sidebar-nav-item ${centerTab === 'wiki' ? 'active' : ''}`}
          onClick={() => {
            if (centerTab === 'wiki') {
              if (!activeFolder && folders.length > 0) {
                setActiveFolder(folders[0])
              }
              setCenterTab('chat')
            } else {
              setActiveFolder(null)
              setCenterTab('wiki')
            }
          }}
          disabled={!state.activeWorkspaceId}
        >
          <BookOpen size={16} />
          <span>{t('sidebar.wiki')}</span>
        </button>
        <button
          className={`sidebar-nav-item ${centerTab === 'activity' ? 'active' : ''}`}
          onClick={() => {
            if (centerTab === 'activity') {
              if (!activeFolder && folders.length > 0) {
                setActiveFolder(folders[0])
              }
              setCenterTab('chat')
            } else {
              setCenterTab('activity')
            }
          }}
          disabled={!state.activeWorkspaceId}
        >
          <Activity size={16} />
          <span>{t('sidebar.activity')}</span>
          {activityCount > 0 && (
            <span className="sidebar-nav-badge">{activityCount}</span>
          )}
        </button>
        {/* TODO: Tasks menu temporarily hidden
        <button
          className={`sidebar-nav-item ${centerTab === 'tasks' ? 'active' : ''}`}
          onClick={() => {
            if (centerTab === 'tasks') {
              if (!activeFolder && folders.length > 0) {
                setActiveFolder(folders[0])
              }
              setCenterTab('chat')
            } else {
              setCenterTab('tasks')
            }
          }}
          disabled={!state.activeWorkspaceId}
        >
          <LayoutGrid size={16} />
          <span>Tasks</span>
        </button>
        */}
      </div>
      <div className="project-list">
        <button className="add-folder-btn" onClick={pickFolder} disabled={!activeWorkspace}>
          <Plus size={14} />
          <span>{t('sidebar.addFolder')}</span>
        </button>
        {folders.map((f) => (
          <button
            key={f}
            className={`project-item ${f === activeFolder ? 'active' : ''}`}
            onClick={() => { setActiveFolder(f); setCenterTab('chat') }}
            onContextMenu={(e) => {
              e.preventDefault()
              if (confirm(t('sidebar.removeFolderConfirm', { name: basename(f) }))) removeFolder(f)
            }}
            title={f}
          >
            <span className="project-icon"><FolderOpen size={16} /></span>
            <span className="project-name">{basename(f)}</span>
          </button>
        ))}
      </div>
      <div className="sidebar-footer">
        <button
          className={`sidebar-footer-btn ${centerTab === 'settings' ? 'active' : ''}`}
          onClick={() => {
            if (centerTab === 'settings') {
              if (!activeFolder && folders.length > 0) {
                setActiveFolder(folders[0])
              }
              setCenterTab('chat')
            } else {
              setCenterTab('settings')
            }
          }}
        >
          <Settings size={16} />
          <span>{t('sidebar.settings')}</span>
        </button>
      </div>
    </aside>
  )
}
