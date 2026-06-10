/**
 * TMDB company IDs for common studios. Single source of truth, shared by the
 * admin Bulk Film Import dropdown (src/components/AdminBulkImport.tsx) and
 * the studio bulk-import script (scripts/bulk-import-studios.ts).
 *
 * Pure data module: safe to import from client components and scripts alike.
 */
export const COMPANY_PRESETS: Array<{ label: string; id: number }> = [
  { label: 'Pixar', id: 3 },
  { label: 'Walt Disney Animation Studios', id: 6125 },
  { label: 'Walt Disney Pictures', id: 2 },
  { label: 'A24', id: 41077 },
  { label: 'Studio Ghibli', id: 10342 },
  { label: 'Marvel Studios', id: 420 },
  { label: 'Warner Bros.', id: 174 },
  { label: 'Universal Pictures', id: 33 },
  { label: 'Paramount', id: 4 },
  { label: '20th Century', id: 25 },
  { label: 'Columbia Pictures', id: 5 },
  { label: 'New Line Cinema', id: 12 },
  { label: 'Lionsgate', id: 1632 },
  { label: 'Miramax', id: 14 },
  { label: 'Blumhouse', id: 3172 },
  { label: 'Neon', id: 90733 },
]
