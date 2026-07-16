import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { MarkdownRenderer } from './MarkdownRenderer'

describe('MarkdownRenderer security boundaries', () => {
  it('strips global class, id, and style from raw HTML', () => {
    const { container } = render(
      <MarkdownRenderer content={'<div class="modal-backdrop" id="root" style="position:fixed;inset:0">cover</div>'} />,
    )

    const rawDiv = screen.getByText('cover')
    expect(rawDiv).not.toHaveAttribute('class')
    expect(rawDiv).not.toHaveAttribute('id')
    expect(rawDiv).not.toHaveAttribute('style')
    expect(container.querySelector('.modal-backdrop')).toBeNull()
  })

  it('forces safe link target and rel after sanitized raw props', () => {
    render(
      <MarkdownRenderer content={'<a href="https://example.com" target="_self" rel="opener">external</a>'} />,
    )

    const link = screen.getByRole('link', { name: 'external' })
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
    expect(link).not.toHaveAttribute('node')
  })

  it('removes file URLs from links and images', () => {
    const { container } = render(
      <MarkdownRenderer content={'<a href="file:///etc/passwd">local</a><img src="file:///etc/passwd" alt="secret">'} />,
    )

    expect(screen.getByText('local').closest('a')).not.toHaveAttribute('href')
    expect(container.querySelector('img')).toBeNull()
    expect(screen.getByText(/image: secret/)).toBeInTheDocument()
  })

  it('preserves language classes needed by fenced code blocks', () => {
    const { container } = render(
      <MarkdownRenderer content={'```ts\nconst safe = true\n```'} />,
    )

    expect(container.querySelector('code.language-ts')).not.toBeNull()
  })
})
