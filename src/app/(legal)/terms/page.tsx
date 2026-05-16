import fs from 'node:fs'
import path from 'node:path'
import type { Metadata } from 'next'
import LegalMarkdown from '../LegalMarkdown'

export const metadata: Metadata = {
  title: 'Terms of Service | Cinemagraphs',
  description: 'The terms governing your use of Cinemagraphs.',
}

export default function TermsPage() {
  const content = fs.readFileSync(
    path.join(process.cwd(), 'content/legal/terms-of-service.md'),
    'utf-8'
  )

  return (
    <article className="max-w-3xl mx-auto px-6 py-16">
      <LegalMarkdown content={content} />
    </article>
  )
}
