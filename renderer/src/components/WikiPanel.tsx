import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FileText, Plus, Trash2, Save, ChevronDown, ChevronRight } from 'lucide-react'
import { MarkdownRenderer } from './MarkdownRenderer'

/** Split "docs/guides/intro.md" → { folder: "docs/guides", file: "intro.md" }
 *  Pages at root return folder = "" (empty string). */
function splitFolder(name: string): { folder: string; file: string } {
  const i = name.lastIndexOf('/')
  if (i === -1) return { folder: '', file: name }
  return { folder: name.slice(0, i), file: name.slice(i + 1) }
}

interface WikiPanelProps {
  workspaceId: string
}

export function WikiPanel({ workspaceId }: WikiPanelProps) {
  const { t } = useTranslation()
  const [pages, setPages] = useState<WikiPage[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [content, setContent] = useState('')
  const [dirty, setDirty] = useState(false)
  const [editMode, setEditMode] = useState(false)
  const [saving, setSaving] = useState(false)
  const [newPageName, setNewPageName] = useState<string | null>(null)
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(new Set())
  const listGenerationRef = useRef(0)
  const readGenerationRef = useRef(0)
  const editRevisionRef = useRef(0)
  const saveGenerationRef = useRef(0)
  const selectedRef = useRef(selected)
  selectedRef.current = selected
  const workspaceIdRef = useRef(workspaceId)
  workspaceIdRef.current = workspaceId
  const loadedSnapshotRef = useRef<{ key: string; mtime?: number } | null>(null)

  // Group pages by folder prefix. Root pages go under "" (empty key).
  // Folders sorted alphabetically; root pages rendered first.
  const grouped = useMemo(() => {
    const map = new Map<string, WikiPage[]>()
    for (const p of pages) {
      const { folder } = splitFolder(p.name)
      const arr = map.get(folder) ?? []
      arr.push(p)
      map.set(folder, arr)
    }
    const entries = Array.from(map.entries())
    entries.sort(([a], [b]) => {
      if (a === '') return -1
      if (b === '') return 1
      return a.localeCompare(b)
    })
    return entries
  }, [pages])

  const selectedMtime = useMemo(
    () => pages.find((page) => page.name === selected)?.mtime,
    [pages, selected],
  )

  const toggleFolder = (folder: string) => {
    setCollapsedFolders((prev) => {
      const next = new Set(prev)
      if (next.has(folder)) next.delete(folder)
      else next.add(folder)
      return next
    })
  }

  const refreshPages = useCallback(async () => {
    const generation = ++listGenerationRef.current
    const requestedWorkspace = workspaceId
    try {
      const list = await window.api.wikiList(requestedWorkspace)
      if (
        generation !== listGenerationRef.current
        || workspaceIdRef.current !== requestedWorkspace
      ) return
      setPages(list)
      // Use functional setState to avoid stale closure — always gets latest value
      setSelected((prev) => {
        if (list.length === 0) return null
        if (!prev) return list[0].name
        // If current selection was deleted externally, fall back to first page
        if (!list.some((p) => p.name === prev)) return list[0].name
        return prev
      })
      if (list.length === 0) setContent('')
    } catch {
      // Polling/list refresh failure is non-fatal; retain the last good list.
    }
  }, [workspaceId])

  useEffect(() => {
    void refreshPages()
  }, [refreshPages])

  useEffect(() => {
    if (!selected) {
      readGenerationRef.current += 1
      loadedSnapshotRef.current = null
      editRevisionRef.current = 0
      setContent('')
      setDirty(false)
      return
    }

    const key = `${workspaceId}\u0000${selected}`
    const loaded = loadedSnapshotRef.current
    const pageChanged = loaded?.key !== key
    const externalChange = !pageChanged && selectedMtime !== undefined && loaded.mtime !== selectedMtime
    if (!pageChanged && !externalChange) return
    // Never overwrite local edits merely because an agent changed the same
    // page. Once the user saves/discards, dirty becomes false and the latest
    // disk revision is loaded.
    if (!pageChanged && dirty) return

    const generation = ++readGenerationRef.current
    let cancelled = false
    window.api.wikiRead({ workspaceId, name: selected }).then((res) => {
      if (cancelled || generation !== readGenerationRef.current) return
      if (workspaceIdRef.current !== workspaceId || selectedRef.current !== selected) return
      if (res.ok) {
        loadedSnapshotRef.current = { key, mtime: selectedMtime }
        editRevisionRef.current = 0
        setContent(res.content)
        setDirty(false)
      }
    }).catch(() => {
      // Keep the last good content; a later selection or mtime change retries.
    })
    return () => {
      cancelled = true
    }
  }, [dirty, selected, selectedMtime, workspaceId])

  // Poll for external changes (agents writing) every 3s
  useEffect(() => {
    const interval = setInterval(() => {
      if (!dirty) void refreshPages()
    }, 3000)
    return () => clearInterval(interval)
  }, [dirty, refreshPages])

  const openCreatePage = () => {
    setNewPageName('')
  }

  const confirmCreatePage = async () => {
    const name = (newPageName || '').trim()
    if (!name) {
      setNewPageName(null)
      return
    }
    const res = await window.api.wikiWrite({
      workspaceId: workspaceId,
      name,
      content: `# ${name.replace(/\.md$/, '')}\n\n`,
    })
    setNewPageName(null)
    if (res.ok) {
      refreshPages()
      setSelected(res.name)
      setEditMode(true)
    } else {
      alert(res.error)
    }
  }

  const deletePage = async () => {
    if (!selected) return
    if (!confirm(t('wiki.deleteConfirm', { name: selected }))) return
    await window.api.wikiDelete({ workspaceId: workspaceId, name: selected })
    setSelected(null)
    refreshPages()
  }

  const save = async () => {
    if (!selected) return
    const requestedWorkspace = workspaceId
    const requestedPage = selected
    const revision = editRevisionRef.current
    const generation = ++saveGenerationRef.current
    setSaving(true)
    try {
      const res = await window.api.wikiWrite({
        workspaceId: requestedWorkspace,
        name: requestedPage,
        content,
      })
      if (res.ok) {
        // Keep the page dirty if the user typed again while this write was in
        // flight, or navigated to another page/workspace.
        if (
          workspaceIdRef.current === requestedWorkspace
          && selectedRef.current === requestedPage
          && editRevisionRef.current === revision
        ) {
          setDirty(false)
        }
        void refreshPages()
      } else {
        alert(res.error)
      }
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : String(e))
    } finally {
      if (generation === saveGenerationRef.current) setSaving(false)
    }
  }

  return (
    <div className="wiki-panel">
      <aside className="wiki-sidebar">
        <div className="wiki-sidebar-header drag" data-tauri-drag-region>
          <span className="section-title">{t('wiki.title')}</span>
          <button className="wiki-new-btn" onClick={openCreatePage} title={t('wiki.newPage')}>
            <Plus size={14} />
          </button>
        </div>
        <div className="wiki-page-list">
          {pages.length === 0 && (
            <div className="empty-agents">{t('wiki.noPages')}</div>
          )}
          {grouped.map(([folder, folderPages]) => {
            const collapsed = collapsedFolders.has(folder)
            const renderPage = (p: WikiPage) => {
              const { file } = splitFolder(p.name)
              return (
                <button
                  key={p.name}
                  className={`wiki-page-item ${p.name === selected ? 'active' : ''}`}
                  onClick={() => {
                    if (dirty && !confirm(t('wiki.discardChanges'))) return
                    setSelected(p.name)
                    setEditMode(false)
                  }}
                >
                  <FileText size={12} />
                  <span className="wiki-page-name">{file.replace(/\.md$/, '')}</span>
                </button>
              )
            }
            // Root group: no header, just render pages flat
            if (folder === '') {
              return (
                <div key="__root__" className="wiki-folder-group">
                  {folderPages.map(renderPage)}
                </div>
              )
            }
            return (
              <div key={folder} className="wiki-folder-group">
                <button
                  className="wiki-folder-header"
                  onClick={() => toggleFolder(folder)}
                  title={folder}
                >
                  {collapsed ? <ChevronRight size={10} /> : <ChevronDown size={10} />}
                  <span className="wiki-folder-name">{folder}</span>
                </button>
                {!collapsed && folderPages.map(renderPage)}
              </div>
            )
          })}
        </div>
      </aside>

      <main className="wiki-main">
        {!selected ? (
          <div className="empty">
            <div className="empty-title">{t('wiki.emptyTitle')}</div>
            <div className="empty-sub">
              {t('wiki.emptyDesc').split('\n').map((line, i) => (
                <span key={i}>{line}{i === 0 && <br />}</span>
              ))}
            </div>
          </div>
        ) : (
          <>
            <header className="wiki-header drag" data-tauri-drag-region>
              <div className="wiki-title">{selected.replace(/\.md$/, '')}</div>
              <div className="wiki-actions">
                <button
                  className="btn-secondary"
                  onClick={() => setEditMode((v) => !v)}
                >
                  {editMode ? t('common.preview') : t('common.edit')}
                </button>
                {editMode && dirty && (
                  <button className="btn-primary" onClick={save} disabled={saving}>
                    <Save size={12} /> {saving ? t('common.saving') : t('common.save')}
                  </button>
                )}
                <button className="btn-danger" onClick={deletePage}>
                  <Trash2 size={12} />
                </button>
              </div>
            </header>
            <div className="wiki-body">
              {editMode ? (
                <textarea
                  className="wiki-editor"
                  value={content}
                  onChange={(e) => {
                    editRevisionRef.current += 1
                    setContent(e.target.value)
                    setDirty(true)
                  }}
                  placeholder={t('wiki.editorPlaceholder')}
                />
              ) : (
                <div className="wiki-preview">
                  <MarkdownRenderer content={content || t('wiki.emptyContent')} />
                </div>
              )}
            </div>
          </>
        )}
      </main>

      {newPageName !== null && (
        <div className="modal-backdrop" onClick={() => setNewPageName(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-title">{t('wiki.newPageTitle')}</div>
            <label className="modal-label">{t('wiki.nameLabel')}</label>
            <input
              className="modal-input"
              placeholder={t('wiki.namePlaceholder')}
              value={newPageName}
              onChange={(e) => setNewPageName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') confirmCreatePage()
                if (e.key === 'Escape') setNewPageName(null)
              }}
              autoFocus
            />
            <div className="modal-actions">
              <button className="btn-secondary" onClick={() => setNewPageName(null)}>
                {t('common.cancel')}
              </button>
              <button
                className="btn-primary"
                onClick={confirmCreatePage}
                disabled={!newPageName.trim()}
              >
                {t('common.create')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
