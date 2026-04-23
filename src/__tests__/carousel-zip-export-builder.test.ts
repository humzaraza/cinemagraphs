import { describe, it, expect, vi } from 'vitest'
import JSZip from 'jszip'
import { buildCarouselZip } from '@/lib/carousel/zip-export-builder'

// 1x1 transparent PNG encoded as base64. Small enough to keep fixtures readable
// but real binary so JSZip's base64 decode exercises the same path as prod.
const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

function makeSlide(n: number) {
  return { slideNumber: n, pngBase64: TINY_PNG_B64 }
}

const FULL_SLOTS = [
  { position: 1, kind: 'hook' },
  { position: 2, kind: 'opening' },
  { position: 3, kind: 'setup' },
  { position: 4, kind: 'drop' },
  { position: 5, kind: 'first-contact' },
  { position: 6, kind: 'peak' },
  { position: 7, kind: 'ending' },
  { position: 8, kind: 'takeaway' },
]

describe('buildCarouselZip', () => {
  it('builds a Blob with 8 files for a full carousel', async () => {
    const slides = [1, 2, 3, 4, 5, 6, 7, 8].map(makeSlide)
    const blob = await buildCarouselZip({
      slides,
      slotSelections: FULL_SLOTS,
      filmTitle: 'Test Film',
      format: '4x5',
    })
    expect(blob).toBeInstanceOf(Blob)
    const unzipped = await JSZip.loadAsync(await blob.arrayBuffer())
    expect(Object.keys(unzipped.files).length).toBe(8)
  })

  it('names files using {NN}-{slot-kind}.png', async () => {
    const slides = [makeSlide(1), makeSlide(4), makeSlide(8)]
    const slots = [
      { position: 1, kind: 'hook' },
      { position: 4, kind: 'drop' },
      { position: 8, kind: 'takeaway' },
    ]
    const blob = await buildCarouselZip({
      slides,
      slotSelections: slots,
      filmTitle: 'Test',
      format: '9x16',
    })
    const unzipped = await JSZip.loadAsync(await blob.arrayBuffer())
    expect(Object.keys(unzipped.files).sort()).toEqual([
      '01-hook.png',
      '04-drop.png',
      '08-takeaway.png',
    ])
  })

  it('preserves the PNG bytes verbatim', async () => {
    const slides = [makeSlide(1)]
    const blob = await buildCarouselZip({
      slides,
      slotSelections: [{ position: 1, kind: 'hook' }],
      filmTitle: 'Test',
      format: '4x5',
    })
    const unzipped = await JSZip.loadAsync(await blob.arrayBuffer())
    const roundTripped = await unzipped.file('01-hook.png')!.async('base64')
    expect(roundTripped).toBe(TINY_PNG_B64)
  })

  it('falls back to "slide" when a slot kind is missing', async () => {
    const slides = [makeSlide(4)]
    const slots = [{ position: 1, kind: 'hook' }]
    const blob = await buildCarouselZip({
      slides,
      slotSelections: slots,
      filmTitle: 'Test',
      format: '4x5',
    })
    const unzipped = await JSZip.loadAsync(await blob.arrayBuffer())
    expect(Object.keys(unzipped.files)).toEqual(['04-slide.png'])
  })

  it('zips fewer than 8 slides without padding', async () => {
    const slides = [makeSlide(1), makeSlide(2), makeSlide(3)]
    const blob = await buildCarouselZip({
      slides,
      slotSelections: FULL_SLOTS,
      filmTitle: 'Test',
      format: '4x5',
    })
    const unzipped = await JSZip.loadAsync(await blob.arrayBuffer())
    expect(Object.keys(unzipped.files).length).toBe(3)
  })

  it('warns and overwrites on duplicate slideNumbers', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const slides = [makeSlide(4), makeSlide(4)]
    const blob = await buildCarouselZip({
      slides,
      slotSelections: FULL_SLOTS,
      filmTitle: 'Test',
      format: '4x5',
    })
    const unzipped = await JSZip.loadAsync(await blob.arrayBuffer())
    expect(Object.keys(unzipped.files)).toEqual(['04-drop.png'])
    expect(warnSpy).toHaveBeenCalledTimes(1)
    warnSpy.mockRestore()
  })
})
