import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '../i18n'
import type { Attachment } from '../types'
import { ChatPanel } from './ChatPanel'

vi.mock('border-beam', () => ({
  BorderBeam: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: vi.fn().mockResolvedValue(vi.fn()),
  }),
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

function installApi(api: Partial<typeof window.api>) {
  Object.defineProperty(window, 'api', { configurable: true, value: api })
}

function renderChat(options: {
  input?: string
  send?: (attachments?: Attachment[]) => void | Promise<void>
} = {}) {
  const send = options.send ?? vi.fn().mockResolvedValue(undefined)
  const result = render(
    <ChatPanel
      activeFolder="/workspace"
      activeWorkspace={{ id: 'workspace-1', name: 'Workspace', folders: ['/workspace'] }}
      octos={[]}
      folderMessages={[]}
      input={options.input ?? ''}
      setInput={vi.fn()}
      mentionOpen={false}
      setMentionOpen={vi.fn()}
      mentionQuery=""
      setMentionQuery={vi.fn()}
      send={send}
      onApproveHandoff={vi.fn()}
      onDismissHandoff={vi.fn()}
      onApproveAgentProposal={vi.fn()}
      onDismissAgentProposal={vi.fn()}
      onConfirmInterrupt={vi.fn()}
      onCancelInterrupt={vi.fn()}
      onGrantPermission={vi.fn()}
      onDismissPermission={vi.fn()}
      hasMoreMessages={false}
      loadingMore={false}
      onLoadMore={vi.fn().mockResolvedValue(undefined)}
      hasPendingAgents={false}
      leftSidebarOpen
      rightSidebarOpen
      onToggleLeftSidebar={vi.fn()}
      onToggleRightSidebar={vi.fn()}
      onStopAll={vi.fn()}
    />,
  )
  const sendButton = result.container.querySelector<HTMLButtonElement>('button.send:not(.stop-btn)')!
  return { ...result, send, sendButton }
}

function imageFile(name = 'image.png') {
  const file = new File([new Uint8Array([1, 2, 3])], name, { type: 'image/png' })
  Object.defineProperty(file, 'arrayBuffer', {
    value: async () => new Uint8Array([1, 2, 3]).buffer,
  })
  return file
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ChatPanel send safety', () => {
  it('coalesces rapid submit attempts while one send is in flight', async () => {
    const pending = deferred<void>()
    const send = vi.fn(() => pending.promise)
    installApi({})
    const { sendButton } = renderChat({ input: 'hello', send })

    fireEvent.click(sendButton)
    fireEvent.click(sendButton)
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1))

    await act(async () => pending.resolve())
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('keeps failed attachments selected and shows an actionable error', async () => {
    const createObjectURL = vi.fn(() => 'blob:preview')
    const revokeObjectURL = vi.fn()
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL })
    installApi({
      saveFile: vi.fn().mockResolvedValue({ ok: false, error: 'disk full' }),
    })
    const { container, sendButton } = renderChat()
    const picker = container.querySelector<HTMLInputElement>('input[type="file"]')!
    fireEvent.change(picker, { target: { files: [imageFile()] } })
    expect(await screen.findByAltText('image.png')).toBeInTheDocument()

    fireEvent.click(sendButton)

    expect(await screen.findByText(/could not be saved/)).toBeInTheDocument()
    expect(screen.getByAltText('image.png')).toBeInTheDocument()
    expect(revokeObjectURL).not.toHaveBeenCalled()
  })

  it('revokes the latest pending preview URLs on unmount', async () => {
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:latest') })
    const revokeObjectURL = vi.fn()
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL })
    installApi({})
    const { container, unmount } = renderChat()
    const picker = container.querySelector<HTMLInputElement>('input[type="file"]')!
    fireEvent.change(picker, { target: { files: [imageFile('latest.png')] } })
    expect(await screen.findByAltText('latest.png')).toBeInTheDocument()

    unmount()

    expect(revokeObjectURL).toHaveBeenCalledWith('blob:latest')
  })
})
