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
  Activity,
} from 'lucide-react'

type SettingsTab = 'general' | 'agents' | 'appearance' | 'shortcuts' | 'advanced' | 'about'

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
  const [metrics, setMetrics] = useState<ObserverMetrics | null>(null)

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
  }, [])

  // Load metrics when Advanced tab is active
  useEffect(() => {
    if (tab !== 'advanced') return
    const load = () => {
      window.api.smartObserverGetMetrics().then((res) => {
        if (res.ok) setMetrics(res.metrics)
      })
    }
    load()
    const interval = setInterval(load, 5000) // refresh every 5s
    return () => clearInterval(interval)
  }, [tab])

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
      <div className="settings-sidebar">
        <h2 className="settings-title">{t('settings.title')}</h2>
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

            {/* Observer Model Selector */}
            <div className="settings-field">
              <span className="settings-toggle-info">
                <span className="settings-label">
                  <Activity size={16} style={{ marginRight: 6, verticalAlign: 'text-bottom' }} />
                  {t('settings.advanced.observerModel')}
                </span>
                <span className="settings-desc">{t('settings.advanced.observerModelDesc')}</span>
              </span>
              <select
                className="settings-select"
                value={settings.advanced?.observerModel || 'haiku'}
                onChange={(e) =>
                  update('advanced', { observerModel: e.target.value as 'haiku' | 'sonnet' | 'opus' })
                }
              >
                <option value="haiku">{t('settings.advanced.modelHaiku')}</option>
                <option value="sonnet">{t('settings.advanced.modelSonnet')}</option>
                <option value="opus">{t('settings.advanced.modelOpus')}</option>
              </select>
            </div>

            {/* Auto Model Selection Toggle */}
            <div className="settings-field">
              <span className="settings-toggle-info">
                <span className="settings-label">
                  <Zap size={16} style={{ marginRight: 6, verticalAlign: 'text-bottom' }} />
                  {t('settings.advanced.autoModelSelection')}
                </span>
                <span className="settings-desc">{t('settings.advanced.autoModelSelectionDesc')}</span>
              </span>
              <button
                className={`settings-toggle ${settings.advanced?.autoModelSelection !== false ? 'active' : ''}`}
                onClick={() =>
                  update('advanced', { autoModelSelection: settings.advanced?.autoModelSelection === false })
                }
                aria-label="Toggle auto model selection"
              />
            </div>

            {/* Default Agent Model Selector (shown when auto is off) */}
            {settings.advanced?.autoModelSelection === false && (
              <div className="settings-field" style={{ marginLeft: 16, opacity: 0.9 }}>
                <span className="settings-toggle-info">
                  <span className="settings-label">
                    {t('settings.advanced.defaultAgentModel')}
                  </span>
                  <span className="settings-desc">{t('settings.advanced.defaultAgentModelDesc')}</span>
                </span>
                <select
                  className="settings-select"
                  value={settings.advanced?.defaultAgentModel || 'haiku'}
                  onChange={(e) =>
                    update('advanced', { defaultAgentModel: e.target.value as 'haiku' | 'sonnet' | 'opus' })
                  }
                >
                  <option value="haiku">{t('settings.advanced.modelHaiku')}</option>
                  <option value="sonnet">{t('settings.advanced.modelSonnet')}</option>
                  <option value="opus">{t('settings.advanced.modelOpus')}</option>
                </select>
              </div>
            )}

            {/* Observer Metrics */}
            <h3 className="settings-section-title" style={{ marginTop: 24 }}>
              <Activity size={16} style={{ marginRight: 6, verticalAlign: 'text-bottom' }} />
              {t('settings.advanced.metricsTitle')}
            </h3>
            <p className="settings-section-desc">{t('settings.advanced.metricsDesc')}</p>

            {!metrics || metrics.totalCalls === 0 ? (
              <p className="settings-section-desc" style={{ fontStyle: 'italic', opacity: 0.6 }}>
                {t('settings.advanced.metricsNone')}
              </p>
            ) : (
              <div className="observer-metrics">
                {/* Success Rate Bar */}
                {metrics.totalCalls > 0 && (
                  <div className="metrics-success-rate">
                    <span className="settings-label">{t('settings.advanced.metricsSuccessRate')}</span>
                    <div className="metrics-bar">
                      <div
                        className="metrics-bar-fill"
                        style={{
                          width: `${Math.round((metrics.successes / metrics.totalCalls) * 100)}%`,
                        }}
                      />
                    </div>
                    <span className="metrics-bar-label">
                      {Math.round((metrics.successes / metrics.totalCalls) * 100)}%
                    </span>
                  </div>
                )}

                <div className="metrics-grid">
                  <div className="metrics-item">
                    <span className="metrics-label">{t('settings.advanced.metricsCalls')}</span>
                    <span className="metrics-value">{metrics.totalCalls}</span>
                  </div>
                  <div className="metrics-item">
                    <span className="metrics-label">{t('settings.advanced.metricsSuccesses')}</span>
                    <span className="metrics-value metrics-value--success">{metrics.successes}</span>
                  </div>
                  <div className="metrics-item">
                    <span className="metrics-label">{t('settings.advanced.metricsParseFailures')}</span>
                    <span className={`metrics-value ${metrics.parseFailures > 0 ? 'metrics-value--warn' : ''}`}>
                      {metrics.parseFailures}
                    </span>
                  </div>
                  <div className="metrics-item">
                    <span className="metrics-label">{t('settings.advanced.metricsValidationFailures')}</span>
                    <span className={`metrics-value ${metrics.validationFailures > 0 ? 'metrics-value--warn' : ''}`}>
                      {metrics.validationFailures}
                    </span>
                  </div>
                  <div className="metrics-item">
                    <span className="metrics-label">{t('settings.advanced.metricsTimeouts')}</span>
                    <span className={`metrics-value ${metrics.timeouts > 0 ? 'metrics-value--error' : ''}`}>
                      {metrics.timeouts}
                    </span>
                  </div>
                  <div className="metrics-item">
                    <span className="metrics-label">{t('settings.advanced.metricsErrors')}</span>
                    <span className={`metrics-value ${metrics.errors > 0 ? 'metrics-value--error' : ''}`}>
                      {metrics.errors}
                    </span>
                  </div>
                  <div className="metrics-item">
                    <span className="metrics-label">{t('settings.advanced.metricsAvgLatency')}</span>
                    <span className="metrics-value">
                      {metrics.avgLatencyMs > 0 ? `${(metrics.avgLatencyMs / 1000).toFixed(1)}s` : '-'}
                    </span>
                  </div>
                  <div className="metrics-item">
                    <span className="metrics-label">{t('settings.advanced.metricsLastSuccess')}</span>
                    <span className="metrics-value">
                      {metrics.lastSuccessAt
                        ? new Date(metrics.lastSuccessAt).toLocaleTimeString()
                        : t('settings.advanced.metricsNever')}
                    </span>
                  </div>
                </div>

                {metrics.lastFailureReason && (
                  <div className="metrics-failure-reason">
                    <span className="metrics-label">{t('settings.advanced.metricsLastFailure')}</span>
                    <span className="metrics-failure-text">{metrics.lastFailureReason}</span>
                  </div>
                )}
              </div>
            )}
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
              <button className="settings-about-link" disabled>
                <RotateCw size={14} />
                <span>{t('settings.about.checkUpdates')}</span>
              </button>
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
