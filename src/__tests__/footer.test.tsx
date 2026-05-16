/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import Footer from '@/components/Footer'

describe('Footer', () => {
  it('renders with the contentinfo role', () => {
    render(<Footer />)
    expect(screen.getByRole('contentinfo')).toBeInTheDocument()
  })

  it('links to the privacy policy', () => {
    render(<Footer />)
    const link = screen.getByRole('link', { name: /privacy policy/i })
    expect(link).toHaveAttribute('href', '/privacy')
  })

  it('links to the terms of service', () => {
    render(<Footer />)
    const link = screen.getByRole('link', { name: /terms of service/i })
    expect(link).toHaveAttribute('href', '/terms')
  })

  it('exposes a mailto contact link', () => {
    render(<Footer />)
    const link = screen.getByRole('link', { name: /contact/i })
    expect(link).toHaveAttribute('href', 'mailto:cinemagraphscorp@gmail.com')
  })

  it('renders the copyright row', () => {
    render(<Footer />)
    expect(screen.getByText(/© 2026 Cinemagraphs Corp/)).toBeInTheDocument()
  })

  it('preserves the existing socials', () => {
    render(<Footer />)
    expect(screen.getByRole('link', { name: /twitter/i })).toHaveAttribute(
      'href',
      'https://x.com/cinemagraphsco'
    )
    expect(screen.getByRole('link', { name: /instagram/i })).toHaveAttribute(
      'href',
      'https://www.instagram.com/cinemagraphsco/'
    )
  })
})
