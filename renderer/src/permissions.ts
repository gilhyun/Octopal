export type GrantablePermission = 'fileWrite' | 'bash' | 'network'

/**
 * Grant requested capabilities without replacing the agent's existing policy.
 * In particular, allowPaths/denyPaths are security boundaries and must survive
 * a one-click permission grant from a chat response.
 */
export function mergeGrantedPermissions(
  existing: OctoPermissions | null | undefined,
  requested: readonly GrantablePermission[],
): OctoPermissions {
  const merged: OctoPermissions = {
    fileWrite: existing?.fileWrite ?? false,
    bash: existing?.bash ?? false,
    network: existing?.network ?? false,
    ...(existing?.allowPaths ? { allowPaths: [...existing.allowPaths] } : {}),
    ...(existing?.denyPaths ? { denyPaths: [...existing.denyPaths] } : {}),
  }

  for (const permission of requested) merged[permission] = true
  return merged
}
