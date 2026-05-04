import { describe, expect, it } from 'vitest'
import { parseAgentRecommendations, sanitizeDisplayText } from './chat-protocol'

describe('agent recommendation protocol', () => {
  it('parses valid hidden recommendation JSON', () => {
    const text = [
      'Recommended teammates:',
      '<!--AGENT_RECOMMENDATIONS:[{"name":"reviewer","role":"Reviews risky changes.","prompt":"Focus on bugs.","icon":"🔎"}]-->',
    ].join('\n')

    expect(parseAgentRecommendations(text)).toEqual([
      {
        name: 'reviewer',
        role: 'Reviews risky changes.',
        prompt: 'Focus on bugs.',
        icon: '🔎',
      },
    ])
  })

  it('strips hidden recommendation markup from display text', () => {
    const text = 'Hello\n<!--AGENT_RECOMMENDATIONS:[{"name":"builder","role":"Builds features."}]-->'
    expect(sanitizeDisplayText(text)).toBe('Hello')
  })

  it('ignores invalid recommendation payloads', () => {
    expect(parseAgentRecommendations('<!--AGENT_RECOMMENDATIONS:not json-->')).toEqual([])
  })
})
