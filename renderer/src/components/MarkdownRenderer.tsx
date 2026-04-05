import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Components } from 'react-markdown'

const components: Components = {
  // 링크를 새 탭에서 열기
  a: ({ href, children, ...props }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
      {children}
    </a>
  ),
  // 코드 블록 vs 인라인 코드 구분
  code: ({ className, children, ...props }) => {
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
  // 이미지 제한 (보안)
  img: ({ src, alt }) => (
    <span className="md-img-placeholder">[image: {alt || src}]</span>
  ),
}

interface MarkdownRendererProps {
  content: string
}

export function MarkdownRenderer({ content }: MarkdownRendererProps) {
  return (
    <div className="markdown-body">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  )
}
