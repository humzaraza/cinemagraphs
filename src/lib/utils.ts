export function formatRuntime(minutes: number): string {
  const hours = Math.floor(minutes / 60)
  const mins = minutes % 60
  return `${hours}h ${mins}m`
}

export function formatDate(date: Date | string): string {
  return new Date(date).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  })
}

export function formatYear(date: Date | string): string {
  return new Date(date).getFullYear().toString()
}

export function truncate(str: string, length: number): string {
  if (str.length <= length) return str
  return str.slice(0, length) + '...'
}

export function tmdbImageUrl(path: string | null, size: string = 'w500'): string {
  if (!path) return '/placeholder-poster.png'
  return `https://image.tmdb.org/t/p/${size}${path}`
}
