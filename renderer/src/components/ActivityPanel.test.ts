import { describe, expect, it } from 'vitest'
import {
  diffLimitReason,
  MAX_DIFF_CHARS_PER_VERSION,
  MAX_DIFF_TOTAL_LINES,
} from './ActivityPanel'

describe('activity diff render limits', () => {
  it('allows normal diffs', () => {
    expect(diffLimitReason('one\ntwo', 'one\nchanged')).toBeNull()
  })

  it('rejects oversized file versions before diffing', () => {
    expect(diffLimitReason('a'.repeat(MAX_DIFF_CHARS_PER_VERSION + 1), '')).toBe('size')
  })

  it('rejects inputs that would create too many line nodes', () => {
    expect(diffLimitReason('line\n'.repeat(MAX_DIFF_TOTAL_LINES), '')).toBe('lines')
  })
})
