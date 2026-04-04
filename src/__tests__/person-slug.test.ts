import { describe, it, expect } from 'vitest'
import { generatePersonSlug } from '@/lib/person-sync'

describe('generatePersonSlug', () => {
  it('generates slug for standard name', () => {
    expect(generatePersonSlug('Christopher Nolan', 525)).toBe('christopher-nolan-525')
  })

  it('handles special characters and accented letters', () => {
    const slug = generatePersonSlug('Timothée Chalamet', 1190668)
    // Should not contain accented characters, should be a valid URL slug
    expect(slug).toMatch(/^[a-z0-9-]+-1190668$/)
    expect(slug).not.toContain('é')
    expect(slug).toContain('1190668')
  })

  it('handles apostrophes', () => {
    const slug = generatePersonSlug("Frances O'Connor", 5530)
    expect(slug).toMatch(/^frances-o-connor-5530$/)
  })

  it('handles single name', () => {
    expect(generatePersonSlug('Zendaya', 505710)).toBe('zendaya-505710')
  })

  it('collapses multiple spaces and special chars', () => {
    const slug = generatePersonSlug('Robert  Downey Jr.', 3223)
    expect(slug).toBe('robert-downey-jr-3223')
  })

  it('trims leading/trailing dashes', () => {
    const slug = generatePersonSlug(' - Test Name - ', 999)
    expect(slug).not.toMatch(/^-/)
    expect(slug).toMatch(/-999$/)
  })

  it('handles empty-ish name', () => {
    const slug = generatePersonSlug('---', 100)
    // After replacing non-alphanum and trimming dashes, name part is empty
    expect(slug).toMatch(/-100$/)
  })
})
