import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '../../i18n'
import { EditAgentModal, validateAgentName } from './EditAgentModal'

const agent: OctoFile = {
  path: '/workspace/octopal-agents/reviewer/config.json',
  name: 'reviewer',
  role: 'Reviews code',
  icon: '🔍',
  permissions: {
    fileWrite: false,
    bash: false,
    network: false,
    denyPaths: ['.env'],
  },
}

function installApi(api: Partial<typeof window.api>) {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: api,
  })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('validateAgentName', () => {
  it('rejects empty names and path-like values', () => {
    expect(validateAgentName('  ')).toBe('required')
    expect(validateAgentName('../../moved')).toBe('invalid')
    expect(validateAgentName('/tmp/moved')).toBe('invalid')
    expect(validateAgentName('agent/name')).toBe('invalid')
    expect(validateAgentName('a'.repeat(81))).toBe('tooLong')
  })

  it('accepts safe localized names', () => {
    expect(validateAgentName('reviewer-2')).toBeNull()
    expect(validateAgentName('리뷰 에이전트_2')).toBeNull()
  })
})

describe('EditAgentModal prompt loading', () => {
  it('omits prompt from an update while the existing prompt is still loading', async () => {
    const updateOcto = vi.fn().mockResolvedValue({ ok: true, path: agent.path })
    installApi({
      readAgentPrompt: vi.fn(() => new Promise<
        { ok: true; path: string } | { ok: false; error: string }
      >(() => {})),
      updateOcto,
    })

    render(
      <EditAgentModal
        agent={agent}
        folderPath="/workspace"
        onClose={vi.fn()}
        onSaved={vi.fn()}
        onDeleted={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(updateOcto).toHaveBeenCalledTimes(1))
    expect(updateOcto.mock.calls[0][0].prompt).toBeUndefined()
  })

  it('shows a load error and still omits prompt from unrelated updates', async () => {
    const updateOcto = vi.fn().mockResolvedValue({ ok: true, path: agent.path })
    installApi({
      readAgentPrompt: vi.fn().mockRejectedValue(new Error('permission denied')),
      updateOcto,
    })

    render(
      <EditAgentModal
        agent={agent}
        folderPath="/workspace"
        onClose={vi.fn()}
        onSaved={vi.fn()}
        onDeleted={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Prompt' }))
    expect(await screen.findByText(/permission denied/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(updateOcto).toHaveBeenCalledTimes(1))
    expect(updateOcto.mock.calls[0][0].prompt).toBeUndefined()
  })
})
