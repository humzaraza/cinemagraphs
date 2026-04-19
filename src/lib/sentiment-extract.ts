import Anthropic from '@anthropic-ai/sdk'

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY || process.env.CINEMA_ANTHROPIC_KEY || '',
})

/**
 * Extract a sentiment score (1-10) from user review text using Claude.
 * Returns null if text is empty or extraction fails.
 */
export async function extractSentiment(text: string): Promise<number | null> {
  if (!text || text.trim().length < 10) return null

  try {
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 50,
      temperature: 0,
      messages: [
        {
          role: 'user',
          content: `Rate the sentiment of this movie review on a scale of 1-10 (1=extremely negative, 5=neutral, 10=extremely positive). Respond with ONLY a number, nothing else.\n\nReview: ${text.slice(0, 2000)}`,
        },
      ],
    })

    const responseText = message.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('')
      .trim()

    const score = parseFloat(responseText)
    if (isNaN(score) || score < 1 || score > 10) return null
    return Math.round(score * 10) / 10
  } catch {
    return null
  }
}
