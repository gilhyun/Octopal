export interface RequestLease {
  isCurrent: () => boolean
  cancel: () => void
}

/**
 * Issues monotonically newer request leases. Starting a new lease invalidates
 * every older one, allowing async effects to discard late responses safely.
 */
export function createLatestRequestGate() {
  let latestId = 0

  return {
    begin(): RequestLease {
      const id = ++latestId
      let cancelled = false
      return {
        isCurrent: () => !cancelled && id === latestId,
        cancel: () => {
          cancelled = true
        },
      }
    },
  }
}
