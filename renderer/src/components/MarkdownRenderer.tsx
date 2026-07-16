import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import type { Components } from 'react-markdown'

const safeGlobalAttributes = (defaultSchema.attributes?.['*'] || []).filter((attribute) => {
  const name = Array.isArray(attribute) ? attribute[0] : attribute
  return name !== 'className' && name !== 'id' && name !== 'style'
})

// Extended sanitize schema — permits raw HTML blocks wiki pages commonly use
// (tables with alignment, centered <p>, <img>, <br>, <sub>/<sup>) while still
// stripping dangerous tags (<script>, <iframe>, event handlers, etc.). Global
// class/id/style attributes are deliberately removed: otherwise untrusted chat
// or wiki HTML can reuse app classes such as `modal-backdrop`, or inject fixed
// positioning, to cover and impersonate the application UI.
const schema = {
  ...defaultSchema,
  tagNames: [
    ...(defaultSchema.tagNames || []),
    'img',
    'video',
    'source',
    'figure',
    'figcaption',
    'details',
    'summary',
    'sub',
    'sup',
    'mark',
    'kbd',
  ],
  attributes: {
    ...(defaultSchema.attributes || {}),
    img: ['src', 'alt', 'title', 'width', 'height', 'loading', 'align'],
    video: ['src', 'controls', 'width', 'height', 'poster', 'loop', 'muted'],
    source: ['src', 'type'],
    a: [
      ...((defaultSchema.attributes && (defaultSchema.attributes as any).a) || []),
      'target',
      'rel',
    ],
    p: [...(((defaultSchema.attributes as any).p) || []), 'align'],
    div: [...(((defaultSchema.attributes as any).div) || []), 'align'],
    td: [...(((defaultSchema.attributes as any).td) || []), 'align', 'valign', 'width'],
    th: [...(((defaultSchema.attributes as any).th) || []), 'align', 'valign', 'width'],
    table: [...(((defaultSchema.attributes as any).table) || []), 'align', 'width'],
    tr: [...(((defaultSchema.attributes as any).tr) || []), 'align'],
    '*': safeGlobalAttributes,
  },
  protocols: {
    ...(defaultSchema.protocols || {}),
    src: ['http', 'https', 'data'],
    href: ['http', 'https', 'mailto', 'tel'],
  },
}

/** Only allow safe URL schemes for <img src>. Blocks javascript:, etc. */
function safeImgSrc(src?: string): string | undefined {
  if (!src) return undefined
  const trimmed = src.trim()
  if (/^(https?:|data:image\/|\.{0,2}\/)/i.test(trimmed)) return trimmed
  return undefined
}

const components: Components = {
  // 링크를 새 탭에서 열기
  a: ({ href, children, node: _node, ...props }) => (
    <a {...props} href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
  // 코드 블록 vs 인라인 코드 구분
  code: ({ className, children, node: _node, ...props }) => {
    const isBlock = className?.startsWith('language-')
    if (isBlock) {
      return (
        <code className={className} {...props}>
          {children}
        </code>
      )
    }
    return (
      <code className="inline-code" {...props}>
        {children}
      </code>
    )
  },
  // 이미지: 안전한 스킴만 렌더, 깨지면 placeholder로 폴백
  img: ({ src, alt, title, width, height }) => {
    const safe = safeImgSrc(typeof src === 'string' ? src : undefined)
    if (!safe) {
      return (
        <span className="md-img-placeholder">[image: {alt || src || 'blocked'}]</span>
      )
    }
    return (
      <img
        className="md-img"
        src={safe}
        alt={alt || ''}
        title={title}
        width={width}
        height={height}
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={(e) => {
          const img = e.currentTarget
          const fallback = document.createElement('span')
          fallback.className = 'md-img-placeholder'
          fallback.textContent = `[image failed: ${alt || safe}]`
          img.replaceWith(fallback)
        }}
      />
    )
  },
}

interface MarkdownRendererProps {
  content: string
}

export function MarkdownRenderer({ content }: MarkdownRendererProps) {
  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeRaw, [rehypeSanitize, schema]]}
        components={components}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}
