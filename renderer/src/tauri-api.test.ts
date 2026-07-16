import { describe, expect, it, vi } from 'vitest'
import { subscribeAsync } from './tauri-api'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('subscribeAsync', () => {
  it('unlistens when cleanup runs before registration resolves', async () => {
    const registration = deferred<() => void>()
    const unlisten = vi.fn()

    const cleanup = subscribeAsync(() => registration.promise)
    cleanup()
    registration.resolve(unlisten)
    await registration.promise
    await Promise.resolve()

    expect(unlisten).toHaveBeenCalledTimes(1)
  })

  it('unlistens exactly once when registration resolves first', async () => {
    const unlisten = vi.fn()
    const cleanup = subscribeAsync(() => Promise.resolve(unlisten))
    await Promise.resolve()

    cleanup()
    cleanup()

    expect(unlisten).toHaveBeenCalledTimes(1)
  })

  it('handles registration failures without an unhandled rejection', async () => {
    const error = new Error('listen failed')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const cleanup = subscribeAsync(() => Promise.reject(error), 'test:event')

    await Promise.resolve()
    await Promise.resolve()

    expect(consoleError).toHaveBeenCalledWith(
      '[Octopal] Failed to subscribe to test:event:',
      error,
    )
    cleanup()
    consoleError.mockRestore()
  })
})
