import { pipelineLogger } from '@/lib/logger'

const USER_AGENT = 'Cinemagraphs/1.0 (https://cinemagraphs.ca; sentiment pipeline)'

/**
 * Clean wikitext markup into plain text.
 */
function cleanWikitext(raw: string): string {
  return raw
    .replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, '$2')  // [[link|text]] → text
    .replace(/{{[^}]*}}/g, '')                          // strip templates
    .replace(/'{2,3}/g, '')                             // strip bold/italic
    .replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, '')         // strip <ref>...</ref>
    .replace(/<ref[^/]*\/>/gi, '')                       // strip <ref ... />
    .replace(/<[^>]+>/g, '')                             // strip remaining HTML
    .replace(/\n+/g, ' ')
    .trim()
}

/**
 * Fetch the plot section from a film's Wikipedia article.
 * Uses the MediaWiki API with wikitext revision content and redirects.
 * Tries {title} ({year} film), then {title} (film), then {title}.
 * Returns the plot text or null if not found / unreachable.
 */
export async function fetchWikipediaPlot(filmTitle: string, year: number): Promise<string | null> {
  const cleanTitle = filmTitle.replace(/\*/g, '')
  const slugs = [
    `${cleanTitle} (${year} film)`,
    `${cleanTitle} (film)`,
    cleanTitle,
  ]

  for (const slug of slugs) {
    try {
      const title = slug.replace(/ /g, '_')
      const url = `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(title)}&prop=revisions&rvprop=content&rvslots=main&format=json&redirects=true`

      const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(15000),
      })
      if (!res.ok) continue

      const data = await res.json()
      const pages = data?.query?.pages
      if (!pages) continue

      const page = Object.values(pages)[0] as any
      if (page?.missing !== undefined) continue

      const wikitext: string = page?.revisions?.[0]?.slots?.main?.['*'] || ''
      if (!wikitext || wikitext.startsWith('#REDIRECT')) continue

      // Extract the == Plot == section from wikitext
      const plotMatch = wikitext.match(/==\s*Plot\s*==\s*\n([\s\S]*?)(?:\n==\s*[^=]|$)/)
      if (!plotMatch?.[1]) continue

      const plotText = cleanWikitext(plotMatch[1])
      if (plotText.length < 100) continue

      pipelineLogger.info(
        { filmTitle, slug, plotLength: plotText.length },
        'Wikipedia plot fetched'
      )
      return plotText
    } catch (err) {
      pipelineLogger.warn(
        { filmTitle, slug, error: err instanceof Error ? err.message : String(err) },
        'Wikipedia fetch failed for slug'
      )
      continue
    }
  }

  pipelineLogger.info({ filmTitle }, 'No Wikipedia plot found')
  return null
}
