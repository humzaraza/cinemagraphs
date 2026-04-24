// Pure helpers for constructing the ZIP export filename and per-slide filenames
// inside the archive. Kept pure so the admin page can call them directly and
// tests can pin the clock via the optional `now` argument.

const SLUG_MAX = 50

export function slugify(raw: string): string {
  let s = raw.toLowerCase()
  s = s.replace(/[^a-z0-9]/g, '-')
  s = s.replace(/-+/g, '-')
  s = s.replace(/^-+|-+$/g, '')
  if (s.length > SLUG_MAX) {
    s = s.slice(0, SLUG_MAX).replace(/-+$/, '')
  }
  return s
}

function yyyymmdd(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}${m}${d}`
}

export function buildZipFilename(input: {
  filmTitle: string
  format: '4x5' | '9x16'
  now?: Date
}): string {
  const slug = slugify(input.filmTitle)
  const date = yyyymmdd(input.now ?? new Date())
  return `cinemagraphs-${slug}-${input.format}-${date}.zip`
}

export function buildSlideFilename(input: {
  slideNumber: number
  slotKind: string
}): string {
  const nn = String(input.slideNumber).padStart(2, '0')
  const kind = slugify(input.slotKind)
  return `${nn}-${kind}.png`
}
