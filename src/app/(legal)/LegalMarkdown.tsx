import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

const serif = 'font-[family-name:var(--font-libre)]'

const components: Components = {
  h1: ({ node: _node, ...props }) => (
    <h1
      className={`${serif} font-bold text-3xl text-cinema-cream mb-8 mt-0`}
      {...props}
    />
  ),
  h2: ({ node: _node, ...props }) => (
    <h2
      className={`${serif} font-bold text-2xl text-cinema-cream mb-4 mt-12`}
      {...props}
    />
  ),
  h3: ({ node: _node, ...props }) => (
    <h3
      className={`${serif} font-bold text-xl text-cinema-cream mb-3 mt-8`}
      {...props}
    />
  ),
  p: ({ node: _node, ...props }) => (
    <p
      className="text-base leading-relaxed text-cinema-cream/80 mb-4"
      {...props}
    />
  ),
  ul: ({ node: _node, ...props }) => (
    <ul
      className="list-disc ml-6 mb-4 space-y-2 text-cinema-cream/80"
      {...props}
    />
  ),
  ol: ({ node: _node, ...props }) => (
    <ol
      className="list-decimal ml-6 mb-4 space-y-2 text-cinema-cream/80"
      {...props}
    />
  ),
  li: ({ node: _node, ...props }) => (
    <li className="text-cinema-cream/80" {...props} />
  ),
  a: ({ node: _node, ...props }) => (
    <a
      className="text-cinema-gold hover:text-cinema-teal underline transition-colors"
      {...props}
    />
  ),
  strong: ({ node: _node, ...props }) => (
    <strong className="text-cinema-cream font-medium" {...props} />
  ),
  em: ({ node: _node, ...props }) => (
    <em className="text-cinema-gold italic" {...props} />
  ),
  table: ({ node: _node, ...props }) => (
    <table className="w-full border-collapse mb-6" {...props} />
  ),
  th: ({ node: _node, ...props }) => (
    <th
      className="text-cinema-gold border-b border-cinema-gold/30 text-left py-2 px-3"
      {...props}
    />
  ),
  td: ({ node: _node, ...props }) => (
    <td
      className="text-cinema-cream/80 border-b border-cinema-gold/10 py-2 px-3 align-top"
      {...props}
    />
  ),
  hr: ({ node: _node, ...props }) => (
    <hr className="border-t border-cinema-gold/20 my-12" {...props} />
  ),
  code: ({ node: _node, ...props }) => (
    <code
      className="font-mono bg-cinema-cream/5 text-cinema-gold px-1 rounded"
      {...props}
    />
  ),
  blockquote: ({ node: _node, ...props }) => (
    <blockquote
      className="border-l-4 border-cinema-gold pl-4 italic text-cinema-cream/70"
      {...props}
    />
  ),
}

export default function LegalMarkdown({ content }: { content: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
      {content}
    </ReactMarkdown>
  )
}
