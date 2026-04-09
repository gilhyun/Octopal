import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FileText, Plus, Trash2, Save } from 'lucide-react'
import { MarkdownRenderer } from './MarkdownRenderer'

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

  const refreshPages = () => {
    window.api.wikiList(workspaceId).then((list) => {
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
    })
  }

  useEffect(() => {
    refreshPages()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId])

  useEffect(() => {
    if (!selected) {
      setContent('')
      setDirty(false)
      return
    }
    window.api.wikiRead({ workspaceId: workspaceId, name: selected }).then((res) => {
      if (res.ok) {
        setContent(res.content)
        setDirty(false)
      }
    })
  }, [selected, workspaceId])

  // Poll for external changes (agents writing) every 3s
  useEffect(() => {
    const interval = setInterval(() => {
      if (!dirty) refreshPages()
    }, 3000)
    return () => clearInterval(interval)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty])

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
    setSaving(true)
    const res = await window.api.wikiWrite({
      workspaceId: workspaceId,
      name: selected,
      content,
    })
    setSaving(false)
    if (res.ok) {
      setDirty(false)
    } else {
      alert(res.error)
    }
  }

  return (
    <div className="wiki-panel">
      <aside className="wiki-sidebar">
        <div className="wiki-sidebar-header drag">
          <span className="section-title">{t('wiki.title')}</span>
          <button className="wiki-new-btn" onClick={openCreatePage} title={t('wiki.newPage')}>
            <Plus size={14} />
          </button>
        </div>
        <div className="wiki-page-list">
          {pages.length === 0 && (
            <div className="empty-agents">{t('wiki.noPages')}</div>
          )}
          {pages.map((p) => (
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
              <span className="wiki-page-name">{p.name.replace(/\.md$/, '')}</span>
            </button>
          ))}
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
            <header className="wiki-header">
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
