import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '../../i18n'
import { McpValidationModal } from './McpValidationModal'

function installApi(api: Partial<typeof window.api>) {
  Object.defineProperty(window, 'api', { configurable: true, value: api })
}

afterEach(() => vi.restoreAllMocks())

describe('McpValidationModal', () => {
  it('health-checks and renders every configured server', async () => {
    const mcpServers = {
      alpha: { command: 'alpha-mcp' },
      beta: { command: 'beta-mcp' },
    }
    const mcpHealthCheck = vi.fn().mockResolvedValue({
      ok: true,
      results: {
        alpha: { status: 'ok' },
        beta: { status: 'spawn_error', error: 'beta failed' },
      },
    })
    installApi({ mcpHealthCheck })

    render(
      <McpValidationModal
        mcpServers={mcpServers}
        onClose={vi.fn()}
        onDone={vi.fn()}
      />,
    )

    expect(await screen.findByText('alpha')).toBeInTheDocument()
    expect(screen.getByText('beta')).toBeInTheDocument()
    expect(await screen.findByText('beta failed')).toBeInTheDocument()
    expect(mcpHealthCheck).toHaveBeenCalledWith({ mcpServers })
  })

  it('keeps a server in error when post-install verification throws', async () => {
    const mcpServers = { alpha: { command: 'alpha-mcp' } }
    const mcpHealthCheck = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        results: { alpha: { status: 'package_missing', packageName: 'alpha-pkg' } },
      })
      .mockRejectedValueOnce(new Error('verification unavailable'))
    installApi({
      mcpHealthCheck,
      mcpInstallPackage: vi.fn().mockResolvedValue({ ok: true }),
    })

    render(
      <McpValidationModal
        mcpServers={mcpServers}
        onClose={vi.fn()}
        onDone={vi.fn()}
      />,
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Install' }))

    expect(await screen.findByText('verification unavailable')).toBeInTheDocument()
    await waitFor(() => expect(mcpHealthCheck).toHaveBeenCalledTimes(2))
    expect(screen.queryByText('Connected')).toBeNull()
  })
})
