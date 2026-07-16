import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '../i18n'
import { WikiPanel } from './WikiPanel'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

function installApi(api: Partial<typeof window.api>) {
  Object.defineProperty(window, 'api', { configurable: true, value: api })
}

const pages: WikiPage[] = [
  { name: 'a.md', path: '/wiki/a.md', size: 1, mtime: 1 },
  { name: 'b.md', path: '/wiki/b.md', size: 1, mtime: 1 },
]

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('WikiPanel async consistency', () => {
  it('ignores a stale page read that resolves after the newly selected page', async () => {
    const reads = {
      'a.md': deferred<{ ok: true; content: string }>(),
      'b.md': deferred<{ ok: true; content: string }>(),
    }
    const wikiRead = vi.fn(({ name }: { name: string }) => reads[name as keyof typeof reads].promise)
    installApi({
      wikiList: vi.fn().mockResolvedValue(pages),
      wikiRead,
    })

    render(<WikiPanel workspaceId="workspace-1" />)
    await waitFor(() => expect(wikiRead).toHaveBeenCalledWith({ workspaceId: 'workspace-1', name: 'a.md' }))
    fireEvent.click(screen.getByRole('button', { name: 'b' }))
    await waitFor(() => expect(wikiRead).toHaveBeenCalledWith({ workspaceId: 'workspace-1', name: 'b.md' }))

    await act(async () => reads['b.md'].resolve({ ok: true, content: '# New page' }))
    expect(await screen.findByRole('heading', { name: 'New page' })).toBeInTheDocument()
    await act(async () => reads['a.md'].resolve({ ok: true, content: '# Stale page' }))

    expect(screen.getByRole('heading', { name: 'New page' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Stale page' })).toBeNull()
  })

  it('keeps newer edits dirty when an older save finishes', async () => {
    const write = deferred<{ ok: true; name: string }>()
    const wikiWrite = vi.fn(() => write.promise)
    installApi({
      wikiList: vi.fn().mockResolvedValue([pages[0]]),
      wikiRead: vi.fn().mockResolvedValue({ ok: true, content: 'initial' }),
      wikiWrite,
    })

    const { container } = render(<WikiPanel workspaceId="workspace-1" />)
    expect(await screen.findByText('initial')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    const editor = container.querySelector<HTMLTextAreaElement>('.wiki-editor')!
    fireEvent.change(editor, { target: { value: 'first revision' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    fireEvent.change(editor, { target: { value: 'newer revision' } })

    await act(async () => write.resolve({ ok: true, name: 'a.md' }))

    expect(editor.value).toBe('newer revision')
    expect(wikiWrite).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      name: 'a.md',
      content: 'first revision',
    })
    expect(await screen.findByRole('button', { name: 'Save' })).toBeInTheDocument()
  })

  it('reloads the selected clean page when polling observes a newer mtime', async () => {
    vi.useFakeTimers()
    const wikiList = vi.fn()
      .mockResolvedValueOnce([{ ...pages[0], mtime: 1 }])
      .mockResolvedValue([{ ...pages[0], mtime: 2 }])
    const wikiRead = vi.fn()
      .mockResolvedValueOnce({ ok: true, content: 'initial content' })
      .mockResolvedValueOnce({ ok: true, content: 'agent update' })
    installApi({ wikiList, wikiRead })

    render(<WikiPanel workspaceId="workspace-1" />)
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(screen.getByText('initial content')).toBeInTheDocument()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000)
      await Promise.resolve()
    })

    expect(screen.getByText('agent update')).toBeInTheDocument()
    expect(wikiRead).toHaveBeenCalledTimes(2)
  })
})
