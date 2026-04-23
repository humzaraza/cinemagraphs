import { buildSlideFilename } from './zip-export-naming'

export interface ZipExportSlide {
  slideNumber: number
  pngBase64: string
}

export interface ZipExportSlot {
  position: number
  kind: string
}

export interface ZipExportInput {
  slides: ZipExportSlide[]
  slotSelections: ZipExportSlot[]
  filmTitle: string
  format: '4x5' | '9x16'
  now?: Date
}

// Bundles the provided slides into a single ZIP and returns the resulting Blob.
// Missing slot kinds fall back to "slide" so a filename like `04-slide.png`
// surfaces the drop visibly instead of silently mislabelling the archive.
export async function buildCarouselZip(input: ZipExportInput): Promise<Blob> {
  const JSZip = (await import('jszip')).default
  const zip = new JSZip()
  const seen = new Set<number>()
  for (const slide of input.slides) {
    if (seen.has(slide.slideNumber)) {
      console.warn(
        `[carousel-zip] duplicate slide ${slide.slideNumber} — later entry overwrites earlier`,
      )
    }
    seen.add(slide.slideNumber)
    const slot = input.slotSelections.find((s) => s.position === slide.slideNumber)
    const kind = slot?.kind?.trim() ? slot.kind : 'slide'
    const filename = buildSlideFilename({ slideNumber: slide.slideNumber, slotKind: kind })
    zip.file(filename, slide.pngBase64, { base64: true })
  }
  return zip.generateAsync({ type: 'blob' })
}
