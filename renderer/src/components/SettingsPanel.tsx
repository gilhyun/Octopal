import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Settings,
  Users,
  Palette,
  Keyboard,
  Info,
  ExternalLink,
  RotateCw,
  Globe,
  Plus,
  Trash2,
  Zap,
  Wrench,
  Download,
  Check,
  FlaskConical,
} from 'lucide-react'

type SettingsTab = 'general' | 'agents' | 'appearance' | 'shortcuts' | 'advanced' | 'about'

// Converts an explicit Claude model name (e.g. `claude-opus-4-7`) into a
// compact user-facing label (`Opus 4.7`). Falls back to the raw model name
// if the format doesn't match so we never hide information from the user.
function prettyOpusLabel(model: string): string {
  const match = model.match(/^claude-([a-z]+)-(\d+)-(\d+)$/i)
  if (!match) return model
  const [, tier, major, minor] = match
  const capitalized = tier.charAt(0).toUpperCase() + tier.slice(1)
  return `${capitalized} ${major}.${minor}`
}

const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'ko', label: '한국어' },
]

interface SettingsPanelProps {
  onSettingsSaved?: (settings: AppSettings) => void
}

export function SettingsPanel({ onSettingsSaved }: SettingsPanelProps = {}) {
  const { t, i18n } = useTranslation()
  const [tab, setTab] = useState<SettingsTab>('general')
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [newTrigger, setNewTrigger] = useState('')
  const [newExpansion, setNewExpansion] = useState('')
  const [shortcutError, setShortcutError] = useState<string | null>(null)
  const [versionInfo, setVersionInfo] = useState<{
    version: string
    electron: string
    node: string
  } | null>(null)
  const [updateStatus, setUpdateStatus] = useState<
    'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'up-to-date' | 'error'
  >('idle')
  const [updateError, setUpdateError] = useState<string | null>(null)
  const [downloadProgress, setDownloadProgress] = useState<number>(0)
  // Newest explicit Opus model name (e.g. `claude-opus-4-7`) detected on this
  // machine, or `null` while the probe is still running / no premium model.
  const [bestOpusModel, setBestOpusModel] = useState<string | null>(null)

  const TABS: { id: SettingsTab; label: string; icon: typeof Settings }[] = [
    { id: 'general', label: t('settings.tabs.general'), icon: Settings },
    { id: 'agents', label: t('settings.tabs.agents'), icon: Users },
    { id: 'appearance', label: t('settings.tabs.appearance'), icon: Palette },
    { id: 'shortcuts', label: t('settings.tabs.shortcuts'), icon: Keyboard },
    { id: 'advanced', label: t('settings.tabs.advanced'), icon: Wrench },
    { id: 'about', label: t('settings.tabs.about'), icon: Info },
  ]

  const SHORTCUTS = [
    { label: t('settings.shortcuts.sendMessage'), keys: ['Enter'] },
    { label: t('settings.shortcuts.newLine'), keys: ['Shift', 'Enter'] },
    { label: t('settings.shortcuts.mentionAgent'), keys: ['@'] },
    { label: t('settings.shortcuts.stopAllAgents'), keys: ['Esc'] },
  ]

  useEffect(() => {
    window.api.loadSettings().then(setSettings)
    window.api.getVersion().then(setVersionInfo)
    // Query the best available Opus variant. The backend probes on startup,
    // but the result may not be ready yet — poll briefly to pick it up once
    // the probe finishes. Gracefully skipped under Electron where this API
    // isn't implemented.
    const probeFn = window.api.getBestOpusModel
    if (probeFn) {
      let cancelled = false
      let attempts = 0
      const tick = () => {
        if (cancelled) return
        probeFn()
          .then((m) => {
            if (cancelled) return
            if (m) {
              setBestOpusModel(m)
            } else if (attempts < 30) {
              // probe hasn't finished yet — retry up to ~30s
              attempts += 1
              setTimeout(tick, 1000)
            }
          })
          .catch(() => {
            // non-Tauri or command missing — ignore silently
          })
      }
      tick()
      return () => {
        cancelled = true
      }
    }
  }, [])

  const update = <K extends keyof AppSettings>(
    section: K,
    patch: Partial<AppSettings[K]>
  ) => {
    if (!settings) return
    const updated = {
      ...settings,
      [section]: { ...settings[section], ...patch },
    }
    setSettings(updated)
    setDirty(true)
  }

  const updateNested = (
    section: 'agents',
    key: 'defaultPermissions',
    patch: Partial<AppSettings['agents']['defaultPermissions']>
  ) => {
    if (!settings) return
    const updated = {
      ...settings,
      agents: {
        ...settings.agents,
        defaultPermissions: { ...settings.agents.defaultPermissions, ...patch },
      },
    }
    setSettings(updated)
    setDirty(true)
  }

  const changeLanguage = async (lang: string) => {
    if (!settings) return
    i18n.changeLanguage(lang)
    const updated = {
      ...settings,
      general: { ...settings.general, language: lang },
    }
    setSettings(updated)
    await window.api.saveSettings(updated)
  }

  const addTextShortcut = () => {
    if (!settings) return
    const trigger = newTrigger.trim()
    const expansion = newExpansion.trim()

    // Validate
    if (!trigger) { setShortcutError(t('settings.shortcuts.triggerEmpty')); return }
    if (!trigger.startsWith('/')) { setShortcutError(t('settings.shortcuts.triggerPrefix')); return }
    if (trigger.length < 2) { setShortcutError(t('settings.shortcuts.triggerMinLength')); return }
    if (/\s/.test(trigger)) { setShortcutError(t('settings.shortcuts.triggerNoSpaces')); return }
    if (!expansion) { setShortcutError(t('settings.shortcuts.expansionEmpty')); return }

    const existing = settings.shortcuts?.textExpansions || []
    if (existing.some((s) => s.trigger.toLowerCase() === trigger.toLowerCase())) {
      setShortcutError(t('settings.shortcuts.triggerDuplicate'))
      return
    }

    const updated = {
      ...settings,
      shortcuts: {
        ...settings.shortcuts,
        textExpansions: [...existing, { trigger, expansion }],
      },
    }
    setSettings(updated)
    setDirty(true)
    setNewTrigger('')
    setNewExpansion('')
    setShortcutError(null)
  }

  const checkForUpdates = async () => {
    try {
      setUpdateStatus('checking')
      setUpdateError(null)
      const { check } = await import('@tauri-apps/plugin-updater')
      const update = await check()
      if (update) {
        setUpdateStatus('downloading')
        let totalBytes = 0
        let downloadedBytes = 0
        await update.downloadAndInstall((event) => {
          if (event.event === 'Started' && event.data.contentLength) {
            totalBytes = event.data.contentLength
          } else if (event.event === 'Progress') {
            downloadedBytes += event.data.chunkLength
            if (totalBytes > 0) {
              setDownloadProgress(Math.round((downloadedBytes / totalBytes) * 100))
            }
          } else if (event.event === 'Finished') {
            setUpdateStatus('ready')
          }
        })
        setUpdateStatus('ready')
      } else {
        setUpdateStatus('up-to-date')
        setTimeout(() => setUpdateStatus('idle'), 3000)
      }
    } catch (err: any) {
      console.error('[Updater] Update check failed:', err)
      setUpdateStatus('error')
      const message = err?.message || 'Update check failed'
      setUpdateError(message)
      // Don't auto-dismiss error — let user see and click to retry
    }
  }

  const relaunchApp = async () => {
    try {
      const { relaunch } = await import('@tauri-apps/plugin-process')
      await relaunch()
    } catch {
      // fallback
    }
  }

  const save = async () => {
    if (!settings || !dirty) return
    setSaving(true)
    await window.api.saveSettings(settings)

    // Apply font size to document
    document.documentElement.style.setProperty(
      '--chat-font-size',
      `${settings.appearance.chatFontSize}px`
    )

    setSaving(false)
    setDirty(false)
    onSettingsSaved?.(settings)
  }

  if (!settings) {
    return (
      <div className="settings-panel">
        <div className="settings-loading">{t('common.loading')}</div>
      </div>
    )
  }

  return (
    <div className="settings-panel">
      {/* Top drag strip — spans full width so users can drag the window
          from above either column on the settings page. */}
      <div className="settings-drag-strip drag" data-tauri-drag-region />
      <div className="settings-sidebar">
        <h2 className="settings-title drag" data-tauri-drag-region>{t('settings.title')}</h2>
        <nav className="settings-nav">
          {TABS.map((tb) => (
            <button
              key={tb.id}
              className={`settings-nav-item ${tab === tb.id ? 'active' : ''}`}
              onClick={() => setTab(tb.id)}
            >
              <tb.icon size={16} />
              <span>{tb.label}</span>
            </button>
          ))}
        </nav>
      </div>

      <div className="settings-content">
        {tab === 'general' && (
          <div className="settings-section">
            <h3 className="settings-section-title">{t('settings.general.title')}</h3>

            <div className="settings-field">
              <span className="settings-toggle-info">
                <span className="settings-label">
                  <Globe size={16} style={{ marginRight: 6, verticalAlign: 'text-bottom' }} />
                  {t('settings.language.title')}
                </span>
                <span className="settings-desc">{t('settings.language.desc')}</span>
              </span>
              <select
                className="settings-select"
                value={settings.general.language || 'en'}
                onChange={(e) => changeLanguage(e.target.value)}
              >
                {LANGUAGES.map((lang) => (
                  <option key={lang.code} value={lang.code}>
                    {lang.label}
                  </option>
                ))}
              </select>
            </div>

            <label className="settings-toggle">
              <span className="settings-toggle-info">
                <span className="settings-label">{t('settings.general.restoreWorkspace')}</span>
                <span className="settings-desc">
                  {t('settings.general.restoreWorkspaceDesc')}
                </span>
              </span>
              <input
                type="checkbox"
                checked={settings.general.restoreLastWorkspace}
                onChange={(e) =>
                  update('general', { restoreLastWorkspace: e.target.checked })
                }
              />
              <span className="toggle-slider" />
            </label>

            <label className="settings-toggle">
              <span className="settings-toggle-info">
                <span className="settings-label">{t('settings.general.launchAtLogin')}</span>
                <span className="settings-desc">
                  {t('settings.general.launchAtLoginDesc')}
                </span>
              </span>
              <input
                type="checkbox"
                checked={settings.general.launchAtLogin}
                onChange={(e) =>
                  update('general', { launchAtLogin: e.target.checked })
                }
              />
              <span className="toggle-slider" />
            </label>

          </div>
        )}

        {tab === 'agents' && (
          <div className="settings-section">
            <h3 className="settings-section-title">{t('settings.agents.title')}</h3>
            <p className="settings-section-desc">
              {t('settings.agents.desc')}
            </p>

            <label className="settings-toggle">
              <span className="settings-toggle-info">
                <span className="settings-label">{t('settings.agents.fileWrite')}</span>
                <span className="settings-desc">
                  {t('settings.agents.fileWriteDesc')}
                </span>
              </span>
              <input
                type="checkbox"
                checked={settings.agents.defaultPermissions.fileWrite}
                onChange={(e) =>
                  updateNested('agents', 'defaultPermissions', {
                    fileWrite: e.target.checked,
                  })
                }
              />
              <span className="toggle-slider" />
            </label>

            <label className="settings-toggle">
              <span className="settings-toggle-info">
                <span className="settings-label">{t('settings.agents.shell')}</span>
                <span className="settings-desc">
                  {t('settings.agents.shellDesc')}
                </span>
              </span>
              <input
                type="checkbox"
                checked={settings.agents.defaultPermissions.bash}
                onChange={(e) =>
                  updateNested('agents', 'defaultPermissions', {
                    bash: e.target.checked,
                  })
                }
              />
              <span className="toggle-slider" />
            </label>

            <label className="settings-toggle">
              <span className="settings-toggle-info">
                <span className="settings-label">{t('settings.agents.network')}</span>
                <span className="settings-desc">
                  {t('settings.agents.networkDesc')}
                </span>
              </span>
              <input
                type="checkbox"
                checked={settings.agents.defaultPermissions.network}
                onChange={(e) =>
                  updateNested('agents', 'defaultPermissions', {
                    network: e.target.checked,
                  })
                }
              />
              <span className="toggle-slider" />
            </label>
          </div>
        )}

        {tab === 'appearance' && (
          <div className="settings-section">
            <h3 className="settings-section-title">{t('settings.appearance.title')}</h3>

            <div className="settings-field">
              <span className="settings-label">{t('settings.appearance.theme')}</span>
              <div className="settings-theme-badge">{t('settings.appearance.themeDark')}</div>
              <span className="settings-desc">
                {t('settings.appearance.themeComingSoon')}
              </span>
            </div>

            <div className="settings-field">
              <span className="settings-label">{t('settings.appearance.chatFontSize')}</span>
              <div className="settings-slider-row">
                <span className="settings-slider-label">A</span>
                <input
                  type="range"
                  min={13}
                  max={18}
                  step={1}
                  value={settings.appearance.chatFontSize}
                  onChange={(e) =>
                    update('appearance', {
                      chatFontSize: Number(e.target.value),
                    })
                  }
                />
                <span className="settings-slider-label settings-slider-label--lg">A</span>
                <span className="settings-slider-value">
                  {settings.appearance.chatFontSize}px
                </span>
              </div>
            </div>
          </div>
        )}

        {tab === 'shortcuts' && (
          <div className="settings-section">
            {/* Keyboard Shortcuts (read-only) */}
            <h3 className="settings-section-title">{t('settings.shortcuts.keyboardTitle')}</h3>
            <div className="settings-shortcut-list">
              {SHORTCUTS.map((s) => (
                <div key={s.label} className="settings-shortcut-row">
                  <span className="settings-shortcut-action">{s.label}</span>
                  <span className="settings-shortcut-keys">
                    {s.keys.map((k) => (
                      <kbd key={k}>{k}</kbd>
                    ))}
                  </span>
                </div>
              ))}
            </div>

            {/* Text Shortcuts (CRUD) */}
            <h3 className="settings-section-title" style={{ marginTop: 24 }}>
              <Zap size={16} style={{ marginRight: 6, verticalAlign: 'text-bottom' }} />
              {t('settings.shortcuts.textExpansionsTitle')}
            </h3>
            <p className="settings-section-desc">
              {t('settings.shortcuts.textExpansionsDesc')}
            </p>

            {/* Existing shortcuts list */}
            {(settings.shortcuts?.textExpansions || []).length === 0 ? (
              <p className="settings-section-desc" style={{ fontStyle: 'italic', opacity: 0.6 }}>
                {t('settings.shortcuts.noShortcuts')}
              </p>
            ) : (
              <div className="text-shortcut-list">
                {(settings.shortcuts?.textExpansions || []).map((sc, idx) => (
                  <div key={idx} className="text-shortcut-row">
                    <div className="text-shortcut-trigger">
                      <kbd>{sc.trigger}</kbd>
                    </div>
                    <div className="text-shortcut-arrow">→</div>
                    <div className="text-shortcut-expansion">{sc.expansion}</div>
                    {sc.description && (
                      <div className="text-shortcut-desc">{sc.description}</div>
                    )}
                    <button
                      className="text-shortcut-delete"
                      title={t('common.delete')}
                      onClick={() => {
                        if (!confirm(t('settings.shortcuts.deleteConfirm', { trigger: sc.trigger }))) return
                        const updated = {
                          ...settings,
                          shortcuts: {
                            ...settings.shortcuts,
                            textExpansions: (settings.shortcuts?.textExpansions || []).filter((_, i) => i !== idx),
                          },
                        }
                        setSettings(updated)
                        setDirty(true)
                      }}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Add new shortcut form */}
            <div className="text-shortcut-add">
              <div className="text-shortcut-add-row">
                <input
                  className="text-shortcut-input trigger-input"
                  placeholder={t('settings.shortcuts.triggerPlaceholder')}
                  value={newTrigger}
                  onChange={(e) => {
                    setNewTrigger(e.target.value)
                    setShortcutError(null)
                  }}
                  onKeyDown={(e) => { if (e.key === 'Enter') addTextShortcut() }}
                />
                <input
                  className="text-shortcut-input expansion-input"
                  placeholder={t('settings.shortcuts.expansionPlaceholder')}
                  value={newExpansion}
                  onChange={(e) => {
                    setNewExpansion(e.target.value)
                    setShortcutError(null)
                  }}
                  onKeyDown={(e) => { if (e.key === 'Enter') addTextShortcut() }}
                />
                <button
                  className="text-shortcut-add-btn"
                  onClick={addTextShortcut}
                  title={t('settings.shortcuts.addShortcut')}
                >
                  <Plus size={16} />
                </button>
              </div>
              {shortcutError && (
                <div className="text-shortcut-error">{shortcutError}</div>
              )}
            </div>
          </div>
        )}

        {tab === 'advanced' && (
          <div className="settings-section">
            <h3 className="settings-section-title">{t('settings.advanced.title')}</h3>

            {/* Auto Model Selection Toggle */}
            <label className="settings-toggle">
              <span className="settings-toggle-info">
                <span className="settings-label">
                  <Zap size={16} style={{ marginRight: 6, verticalAlign: 'text-bottom' }} />
                  {t('settings.advanced.autoModelSelection')}
                </span>
                <span className="settings-desc">{t('settings.advanced.autoModelSelectionDesc')}</span>
              </span>
              <input
                type="checkbox"
                checked={settings.advanced?.autoModelSelection === true}
                onChange={(e) =>
                  update('advanced', { autoModelSelection: e.target.checked })
                }
                aria-label="Toggle auto model selection"
              />
              <span className="toggle-slider" />
            </label>

            {/* Default Agent Model Selector (shown when auto is off) */}
            {settings.advanced?.autoModelSelection !== true && (
              <div className="settings-field" style={{ marginLeft: 16, opacity: 0.9 }}>
                <span className="settings-toggle-info">
                  <span className="settings-label">
                    {t('settings.advanced.defaultAgentModel')}
                  </span>
                  <span className="settings-desc">{t('settings.advanced.defaultAgentModelDesc')}</span>
                </span>
                <select
                  className="settings-select"
                  value={settings.advanced?.defaultAgentModel || 'opus'}
                  onChange={(e) =>
                    update('advanced', { defaultAgentModel: e.target.value as 'haiku' | 'sonnet' | 'opus' })
                  }
                >
                  <option value="haiku">{t('settings.advanced.modelHaiku')}</option>
                  <option value="sonnet">{t('settings.advanced.modelSonnet')}</option>
                  <option value="opus">
                    {t('settings.advanced.modelOpus')}
                    {bestOpusModel ? ` — ${prettyOpusLabel(bestOpusModel)}` : ''}
                  </option>
                </select>
                {bestOpusModel && (
                  <span
                    className="settings-desc"
                    style={{ marginLeft: 16, display: 'block', marginTop: 4 }}
                  >
                    {t('settings.advanced.opusDetected', { model: prettyOpusLabel(bestOpusModel) })}
                  </span>
                )}
              </div>
            )}

            {/* Backup Retention */}
            <h3 className="settings-section-title" style={{ marginTop: 24 }}>
              <RotateCw size={16} style={{ marginRight: 6, verticalAlign: 'text-bottom' }} />
              {t('settings.advanced.backupTitle')}
            </h3>
            <p className="settings-section-desc">{t('settings.advanced.backupDesc')}</p>

            <div className="settings-field">
              <span className="settings-toggle-info">
                <span className="settings-label">{t('settings.advanced.backupMaxCount')}</span>
                <span className="settings-desc">{t('settings.advanced.backupMaxCountDesc')}</span>
              </span>
              <input
                type="number"
                className="settings-input"
                min={1}
                max={1000}
                value={settings.backup?.maxBackupsPerWorkspace ?? 50}
                onChange={(e) => {
                  const n = Math.max(1, Math.min(1000, Number(e.target.value) || 50))
                  update('backup', {
                    maxBackupsPerWorkspace: n,
                    maxAgeDays: settings.backup?.maxAgeDays ?? 7,
                  })
                }}
                style={{ width: 80 }}
              />
            </div>

            <div className="settings-field">
              <span className="settings-toggle-info">
                <span className="settings-label">{t('settings.advanced.backupMaxAge')}</span>
                <span className="settings-desc">{t('settings.advanced.backupMaxAgeDesc')}</span>
              </span>
              <input
                type="number"
                className="settings-input"
                min={1}
                max={365}
                value={settings.backup?.maxAgeDays ?? 7}
                onChange={(e) => {
                  const n = Math.max(1, Math.min(365, Number(e.target.value) || 7))
                  update('backup', {
                    maxBackupsPerWorkspace: settings.backup?.maxBackupsPerWorkspace ?? 50,
                    maxAgeDays: n,
                  })
                }}
                style={{ width: 80 }}
              />
            </div>

            {/* Runtime (Goose ACP vs legacy Claude CLI) */}
            <h3 className="settings-section-title" style={{ marginTop: 24 }}>
              <FlaskConical size={16} style={{ marginRight: 6, verticalAlign: 'text-bottom' }} />
              {t('settings.advanced.runtimeTitle')}
            </h3>
            <p className="settings-section-desc">{t('settings.advanced.runtimeDesc')}</p>

            <label className="settings-toggle">
              <span className="settings-toggle-info">
                <span className="settings-label">{t('settings.advanced.useLegacyCli')}</span>
                <span className="settings-desc">{t('settings.advanced.useLegacyCliDesc')}</span>
              </span>
              <input
                type="checkbox"
                checked={settings.providers?.useLegacyClaudeCli !== false}
                onChange={(e) =>
                  update('providers', { useLegacyClaudeCli: e.target.checked })
                }
                aria-label="Toggle legacy Claude CLI runtime"
              />
              <span className="toggle-slider" />
            </label>

          </div>
        )}

        {tab === 'about' && (
          <div className="settings-section">
            <h3 className="settings-section-title">{t('settings.about.title')}</h3>

            <div className="settings-about-logo">
              <span className="settings-about-emoji">🐙</span>
              <span className="settings-about-name">Octopal</span>
            </div>

            <div className="settings-about-info">
              <div className="settings-about-row">
                <span>{t('settings.about.version')}</span>
                <span>{versionInfo?.version || '...'}</span>
              </div>
              <div className="settings-about-row">
                <span>{t('settings.about.electron')}</span>
                <span>{versionInfo?.electron || '...'}</span>
              </div>
              <div className="settings-about-row">
                <span>{t('settings.about.node')}</span>
                <span>{versionInfo?.node || '...'}</span>
              </div>
            </div>

            <div className="settings-about-links">
              <button
                className="settings-about-link"
                onClick={() => {
                  window.open('https://github.com/gilhyun/Octopal', '_blank');
                }}
              >
                <ExternalLink size={14} />
                <span>{t('settings.about.github')}</span>
              </button>
              {updateStatus === 'ready' ? (
                <button
                  className="settings-about-link settings-update-ready"
                  onClick={relaunchApp}
                >
                  <Download size={14} />
                  <span>{t('settings.about.restartToUpdate')}</span>
                </button>
              ) : (
                <button
                  className="settings-about-link"
                  disabled={updateStatus === 'checking' || updateStatus === 'downloading'}
                  onClick={checkForUpdates}
                >
                  {updateStatus === 'checking' ? (
                    <RotateCw size={14} className="spin" />
                  ) : updateStatus === 'downloading' ? (
                    <Download size={14} />
                  ) : updateStatus === 'up-to-date' ? (
                    <Check size={14} />
                  ) : (
                    <RotateCw size={14} />
                  )}
                  <span>
                    {updateStatus === 'checking'
                      ? t('settings.about.checking')
                      : updateStatus === 'downloading'
                        ? `${t('settings.about.downloading')} ${downloadProgress}%`
                        : updateStatus === 'up-to-date'
                          ? t('settings.about.upToDate')
                          : updateStatus === 'error'
                            ? updateError || 'Error'
                            : t('settings.about.checkUpdates')}
                  </span>
                </button>
              )}
            </div>

            <p className="settings-about-copyright">
              {t('settings.about.copyright')}
            </p>
          </div>
        )}

        {dirty && (
          <div className="settings-save-bar">
            <span>{t('settings.unsavedChanges')}</span>
            <button
              className="settings-save-btn"
              onClick={save}
              disabled={saving}
            >
              {saving ? t('common.saving') : t('common.save')}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
