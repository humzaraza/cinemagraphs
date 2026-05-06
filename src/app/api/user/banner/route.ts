import { NextRequest, NextResponse } from 'next/server'
import { getMobileOrServerSession } from '@/lib/mobile-auth'
import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { buildProfileResponse } from '@/lib/profile-response'
import { deleteUserBannerBlob, validateBannerBlobPath } from '@/lib/banner-blob'
import { parseBackdropBannerValue, encodeBackdropBannerValue } from '@/lib/banner-validation'

const VALID_GRADIENT_KEYS = [
  'midnight',
  'ember',
  'ocean',
  'dusk',
  'forest',
  'gold',
  'rose',
  'steel',
] as const

const VALID_BANNER_TYPES = ['GRADIENT', 'PHOTO', 'BACKDROP'] as const
type BannerTypeLiteral = (typeof VALID_BANNER_TYPES)[number]

export async function PATCH(request: NextRequest) {
  try {
    const session = await getMobileOrServerSession()
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
    }

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const { bannerType, bannerValue } = body as { bannerType?: unknown; bannerValue?: unknown }

    if (typeof bannerType !== 'string' || !VALID_BANNER_TYPES.includes(bannerType as BannerTypeLiteral)) {
      return NextResponse.json(
        { error: 'bannerType must be one of GRADIENT, PHOTO, BACKDROP' },
        { status: 400 }
      )
    }

    // GRADIENT and PHOTO require a non-empty string bannerValue (unchanged
    // contract). BACKDROP accepts string OR object so we skip the type
    // assertion for it and validate inside the BACKDROP branch.
    if (bannerType !== 'BACKDROP') {
      if (typeof bannerValue !== 'string' || bannerValue.length === 0) {
        return NextResponse.json({ error: 'bannerValue must be a non-empty string' }, { status: 400 })
      }
    }

    let persistedBannerValue: string

    if (bannerType === 'GRADIENT') {
      const value = bannerValue as string
      if (!VALID_GRADIENT_KEYS.includes(value as (typeof VALID_GRADIENT_KEYS)[number])) {
        return NextResponse.json(
          {
            error: 'Invalid GRADIENT bannerValue.',
            validKeys: VALID_GRADIENT_KEYS,
          },
          { status: 400 }
        )
      }
      persistedBannerValue = value
    } else if (bannerType === 'BACKDROP') {
      const parsed = parseBackdropBannerValue(bannerValue)
      if (!parsed.ok) {
        return NextResponse.json({ error: parsed.error }, { status: 400 })
      }
      const film = await prisma.film.findUnique({
        where: { id: parsed.value.filmId },
        select: { id: true },
      })
      if (!film) {
        return NextResponse.json(
          {
            error: `BACKDROP bannerValue must be the id of an existing film. '${parsed.value.filmId}' was not found.`,
          },
          { status: 400 }
        )
      }
      persistedBannerValue = encodeBackdropBannerValue(parsed.value)
    } else {
      // PHOTO
      const value = bannerValue as string
      if (!validateBannerBlobPath(value)) {
        return NextResponse.json(
          { error: "PHOTO bannerValue must be a blob path under the 'banners/' namespace." },
          { status: 400 }
        )
      }
      persistedBannerValue = value
    }

    const previous = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { bannerType: true, bannerValue: true },
    })

    await prisma.user.update({
      where: { id: session.user.id },
      data: {
        bannerType: bannerType as BannerTypeLiteral,
        bannerValue: persistedBannerValue,
      },
    })

    if (previous?.bannerType === 'PHOTO') {
      try {
        await deleteUserBannerBlob({
          id: session.user.id,
          bannerType: previous.bannerType,
          bannerValue: previous.bannerValue,
        })
      } catch (cleanupErr) {
        apiLogger.warn(
          { err: cleanupErr, userId: session.user.id },
          'Banner blob cleanup raised after update'
        )
      }
    }

    const payload = await buildProfileResponse(session.user.id)
    if (!payload) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }
    return NextResponse.json(payload)
  } catch (err) {
    apiLogger.error({ err }, 'Failed to update user banner')
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}
