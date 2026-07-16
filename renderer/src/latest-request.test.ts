import { describe, expect, it } from 'vitest'
import { createLatestRequestGate } from './latest-request'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

describe('createLatestRequestGate', () => {
  it('discards an older folder response that resolves after a newer one', async () => {
    const gate = createLatestRequestGate()
    const folderA = deferred<string>()
    const folderB = deferred<string>()
    const applied: string[] = []

    const load = async (request: Promise<string>) => {
      const lease = gate.begin()
      const value = await request
      if (lease.isCurrent()) applied.push(value)
    }

    const loadA = load(folderA.promise)
    const loadB = load(folderB.promise)
    folderB.resolve('folder-b')
    await loadB
    folderA.resolve('folder-a')
    await loadA

    expect(applied).toEqual(['folder-b'])
  })

  it('invalidates a lease when its effect cleanup runs', () => {
    const lease = createLatestRequestGate().begin()
    expect(lease.isCurrent()).toBe(true)
    lease.cancel()
    expect(lease.isCurrent()).toBe(false)
  })
})
