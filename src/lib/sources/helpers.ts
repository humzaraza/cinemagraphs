export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/['']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

export function extractArticleText(html: string): string {
  let clean = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<aside[\s\S]*?<\/aside>/gi, '')

  const articleMatch = clean.match(/<article[^>]*>([\s\S]*?)<\/article>/i)
  if (articleMatch) clean = articleMatch[1]

  clean = clean.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  return clean
}
