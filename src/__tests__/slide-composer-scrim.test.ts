import { describe, it, expect } from 'vitest'
import {
  buildBackground,
  specFor,
} from '@/lib/carousel/slide-composer'

describe('buildBackground cover/closer scrim', () => {
  const spec = specFor('4x5')

  it('slides 1 and 8 include coverCloserScrim gradient def', () => {
    for (const slideNumber of [1, 8]) {
      const { defs } = buildBackground(slideNumber, spec, null)
      const joined = defs.join('\n')
      expect(joined).toContain('id="coverCloserScrim"')
      expect(joined).toContain('stop-opacity="0.35"')
    }
  })

  it('slides 2-7 do NOT include coverCloserScrim', () => {
    for (const slideNumber of [2, 3, 4, 5, 6, 7]) {
      const { defs, body } = buildBackground(slideNumber, spec, null)
      expect(defs.join('\n')).not.toContain('coverCloserScrim')
      expect(body.join('\n')).not.toContain('coverCloserScrim')
    }
  })

  it('scrim rect sits between image and bgOverlay in body order', () => {
    const bgDataUrl = 'data:image/png;base64,AAAA'
    const { body } = buildBackground(1, spec, bgDataUrl)
    const imageIdx = body.findIndex((s) => s.includes('<image '))
    const scrimIdx = body.findIndex((s) => s.includes('url(#coverCloserScrim)'))
    const overlayIdx = body.findIndex((s) => s.includes('url(#bgOverlay)'))
    expect(imageIdx).toBeGreaterThanOrEqual(0)
    expect(scrimIdx).toBeGreaterThanOrEqual(0)
    expect(overlayIdx).toBeGreaterThanOrEqual(0)
    expect(imageIdx).toBeLessThan(scrimIdx)
    expect(scrimIdx).toBeLessThan(overlayIdx)
  })
})
