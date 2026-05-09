import { NextRequest, NextResponse } from 'next/server'
import { apiLogger } from '@/lib/logger'
import { checkRateLimit } from '@/lib/rate-limit'
import { getMobileOrServerSession } from '@/lib/mobile-auth'

const MAX_EVENT_NAME_LENGTH = 50
const MAX_PROPERTY_KEYS = 10
const MAX_PROPERTY_VALUE_LENGTH = 200

interface EventPayload {
  event: string
  properties?: Record<string, string | number | boolean>
  timestamp?: number
}

/**
 * Lightweight funnel event ingestion. Pino-logs each event with userId
 * (or null for anonymous), event name, properties, and timestamp.
 *
 * Accepts both authenticated and anonymous events: pre-signup onboarding
 * events fire without a Bearer token and land with userId: null.
 *
 * Not stored in the database. Query Vercel logs for analysis. If
 * funnel analysis becomes a real workflow, migrate to PostHog/Mixpanel.
 */
export async function POST(request: NextRequest) {
  try {
    const ip =
      request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
      request.headers.get('x-real-ip') ||
      'unknown'

    const session = await getMobileOrServerSession()
    const userId = session?.user?.id ?? null

    // Rate limit per-user when authenticated, per-IP when not.
    // 100 events per minute is generous for normal usage and stops abuse.
    const rateLimitKey = userId ?? ip
    const { limited } = await checkRateLimit('events', rateLimitKey, 100, 60 * 1000)
    if (limited) {
      return NextResponse.json({ error: 'Too many events' }, { status: 429 })
    }

    let body: EventPayload
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    if (!body.event || typeof body.event !== 'string') {
      return NextResponse.json({ error: 'event field is required' }, { status: 400 })
    }

    if (body.event.length > MAX_EVENT_NAME_LENGTH) {
      return NextResponse.json(
        { error: `event name must be ${MAX_EVENT_NAME_LENGTH} characters or fewer` },
        { status: 400 }
      )
    }

    // Sanitize properties: keep primitives only, bound the count and
    // value length. Anything else gets dropped silently.
    const properties: Record<string, string | number | boolean> = {}
    if (body.properties && typeof body.properties === 'object') {
      const entries = Object.entries(body.properties).slice(0, MAX_PROPERTY_KEYS)
      for (const [key, value] of entries) {
        if (typeof value === 'string') {
          properties[key] = value.slice(0, MAX_PROPERTY_VALUE_LENGTH)
        } else if (typeof value === 'number' || typeof value === 'boolean') {
          properties[key] = value
        }
        // Objects, arrays, null, undefined: dropped.
      }
    }

    const timestamp =
      typeof body.timestamp === 'number' && Number.isFinite(body.timestamp)
        ? body.timestamp
        : Date.now()

    apiLogger.info(
      {
        type: 'funnel_event',
        event: body.event,
        userId,
        properties,
        timestamp,
      },
      'Funnel event'
    )

    return NextResponse.json({ ok: true }, { status: 202 })
  } catch (err) {
    apiLogger.error({ err }, 'Failed to log funnel event')
    return NextResponse.json({ error: 'Something went wrong' }, { status: 500 })
  }
}
