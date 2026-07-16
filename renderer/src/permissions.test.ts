import { describe, expect, it } from 'vitest'
import { mergeGrantedPermissions } from './permissions'

describe('mergeGrantedPermissions', () => {
  it('grants requested capabilities while preserving existing policy', () => {
    const existing: OctoPermissions = {
      fileWrite: true,
      bash: false,
      network: true,
      allowPaths: ['src/**'],
      denyPaths: ['.env', 'secrets/**'],
    }

    expect(mergeGrantedPermissions(existing, ['bash'])).toEqual({
      fileWrite: true,
      bash: true,
      network: true,
      allowPaths: ['src/**'],
      denyPaths: ['.env', 'secrets/**'],
    })
  })

  it('creates a complete least-privilege policy when none exists', () => {
    expect(mergeGrantedPermissions(undefined, ['fileWrite'])).toEqual({
      fileWrite: true,
      bash: false,
      network: false,
    })
  })

  it('does not mutate the original path arrays', () => {
    const existing: OctoPermissions = {
      allowPaths: ['src/**'],
      denyPaths: ['private/**'],
    }
    const merged = mergeGrantedPermissions(existing, ['network'])

    expect(merged.allowPaths).not.toBe(existing.allowPaths)
    expect(merged.denyPaths).not.toBe(existing.denyPaths)
    expect(existing).toEqual({ allowPaths: ['src/**'], denyPaths: ['private/**'] })
  })
})
