import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const repoRoot = path.resolve(__dirname, '../..')

function read(file: string): string {
  return fs.readFileSync(path.join(repoRoot, 'content/legal', file), 'utf-8')
}

describe('legal markdown content safety', () => {
  describe('privacy-policy.md', () => {
    const content = read('privacy-policy.md')

    it('exists and starts with the privacy policy heading', () => {
      expect(content.length).toBeGreaterThan(0)
      expect(content.split('\n')[0]).toBe('# PRIVACY POLICY')
    })

    it('does not contain the internal NOTES section', () => {
      expect(content).not.toContain('# NOTES BEFORE PUBLISHING')
      expect(content).not.toContain('DO NOT INCLUDE IN PUBLIC VERSION')
    })

    it('does not contain the home address', () => {
      expect(content).not.toContain('72 Goldbrook Crescent')
      expect(content).not.toContain('Richmond Hill')
      expect(content).not.toContain('L4S1V3')
    })

    it('does not contain placeholder markers', () => {
      expect(content).not.toContain('[BUSINESS ADDRESS')
      expect(content).not.toContain('[TODO')
    })

    it('does not contain em dashes', () => {
      expect(content).not.toContain('—')
    })
  })

  describe('terms-of-service.md', () => {
    const content = read('terms-of-service.md')

    it('exists and starts with the terms heading', () => {
      expect(content.length).toBeGreaterThan(0)
      expect(content.split('\n')[0]).toBe('# TERMS OF SERVICE')
    })

    it('does not contain the internal NOTES section', () => {
      expect(content).not.toContain('# NOTES BEFORE PUBLISHING')
      expect(content).not.toContain('DO NOT INCLUDE IN PUBLIC VERSION')
    })

    it('does not contain the home address outside the DMCA Designated Agent block', () => {
      // The DMCA Designated Agent block publishes the registered agent's
      // physical address as required by the U.S. Copyright Office filing
      // (DMCA-1072856). The guard below strips that block and ensures the
      // address does not leak into any other section.
      expect(content).toContain('### Designated Agent')
      expect(content).toContain('### Filing a DMCA Notice')
      const withoutAgentBlock = content.replace(
        /### Designated Agent[\s\S]*?(?=### Filing a DMCA Notice)/,
        ''
      )
      expect(withoutAgentBlock).not.toContain('72 Goldbrook Crescent')
      expect(withoutAgentBlock).not.toContain('Richmond Hill')
      expect(withoutAgentBlock).not.toContain('L4S1V3')
    })

    it('does not contain placeholder markers', () => {
      expect(content).not.toContain('[BUSINESS ADDRESS')
      expect(content).not.toContain('[TODO')
    })

    it('does not contain em dashes', () => {
      expect(content).not.toContain('—')
    })
  })
})
