/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import PrivacyPage from '@/app/(legal)/privacy/page'
import TermsPage from '@/app/(legal)/terms/page'

describe('/privacy', () => {
  it('renders the Privacy Policy heading', () => {
    render(<PrivacyPage />)
    const heading = screen.getByRole('heading', {
      level: 1,
      name: /privacy policy/i,
    })
    expect(heading).toBeInTheDocument()
  })
})

describe('/terms', () => {
  it('renders the Terms of Service heading', () => {
    render(<TermsPage />)
    const heading = screen.getByRole('heading', {
      level: 1,
      name: /terms of service/i,
    })
    expect(heading).toBeInTheDocument()
  })
})
