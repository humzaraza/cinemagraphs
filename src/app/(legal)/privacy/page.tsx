import fs from 'node:fs'
import path from 'node:path'
import type { Metadata } from 'next'
import LegalMarkdown from '../LegalMarkdown'

export const metadata: Metadata = {
  title: 'Privacy Policy | Cinemagraphs',
  description:
    'How Cinemagraphs collects, uses, and protects your information.',
}

export default function PrivacyPage() {
  const content = fs.readFileSync(
    path.join(process.cwd(), 'content/legal/privacy-policy.md'),
    'utf-8'
  )

  return (
    <article className="max-w-3xl mx-auto px-6 py-16">
      <LegalMarkdown content={content} />
    </article>
  )
}
