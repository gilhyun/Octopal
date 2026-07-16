import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '../i18n'
import { SettingsPanel } from './SettingsPanel'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

function installApi(api: Partial<typeof window.api>) {
  Object.defineProperty(window, 'api', { configurable: true, value: api })
}

const settings: AppSettings = {
  general: {
    restoreLastWorkspace: false,
    launchAtLogin: false,
    language: 'en',
  },
  agents: {
    defaultPermissions: { fileWrite: false, bash: false, network: false },
  },
  appearance: { chatFontSize: 14 },
  shortcuts: { textExpansions: [] },
  advanced: { defaultAgentModel: 'sonnet', autoModelSelection: false },
  providers: { useLegacyClaudeCli: false, configuredProviders: {} },
}

afterEach(() => vi.restoreAllMocks())

describe('SettingsPanel save revisions', () => {
  it('keeps newer edits dirty when an older settings snapshot finishes saving', async () => {
    const firstSave = deferred<{ ok: true }>()
    const saveSettings = vi.fn((_settings: AppSettings) => firstSave.promise)
    installApi({
      loadSettings: vi.fn().mockResolvedValue(settings),
      getVersion: vi.fn().mockResolvedValue({ version: '1', tauri: '2', rust: '1' }),
      saveSettings,
    })
    const onSettingsSaved = vi.fn()
    render(<SettingsPanel onSettingsSaved={onSettingsSaved} />)

    const restore = await screen.findByRole('checkbox', { name: /Restore last workspace/ })
    fireEvent.click(restore)
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    const launch = screen.getByRole('checkbox', { name: /Launch at login/ })
    fireEvent.click(launch)

    await act(async () => firstSave.resolve({ ok: true }))

    await waitFor(() => expect(onSettingsSaved).toHaveBeenCalledTimes(1))
    expect(saveSettings.mock.calls[0][0].general).toEqual({
      restoreLastWorkspace: true,
      launchAtLogin: false,
      language: 'en',
    })
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument()
  })
})
