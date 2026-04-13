import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAdmin } from '@/lib/middleware'

export async function GET(request: NextRequest) {
  const auth = await requireAdmin()
  if (!auth.authorized) return auth.errorResponse!

  const url = request.nextUrl
  const search = url.searchParams.get('search') || ''
  const role = url.searchParams.get('role') || ''
  const sort = url.searchParams.get('sort') || 'createdAt'
  const order = url.searchParams.get('order') === 'asc' ? 'asc' : 'desc'
  const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10))
  const perPage = 25

  const where: Record<string, unknown> = {}

  if (search) {
    where.OR = [
      { name: { contains: search, mode: 'insensitive' } },
      { email: { contains: search, mode: 'insensitive' } },
    ]
  }

  if (role && role !== 'ALL') {
    where.role = role
  }

  let orderBy: Record<string, string>
  if (sort === 'name') {
    orderBy = { name: order }
  } else {
    orderBy = { createdAt: order }
  }

  const userSelect = {
    id: true,
    name: true,
    email: true,
    image: true,
    role: true,
    suspendedUntil: true,
    createdAt: true,
    _count: {
      select: {
        userReviews: true,
        liveReactionSessions: true,
        addedFilms: true,
      },
    },
  } as const

  const mapUser = (u: Awaited<ReturnType<typeof prisma.user.findMany<{ select: typeof userSelect }>>>[number]) => ({
    id: u.id,
    name: u.name,
    email: u.email,
    image: u.image,
    role: u.role,
    suspendedUntil: u.suspendedUntil,
    createdAt: u.createdAt,
    reviewCount: u._count.userReviews,
    reactionCount: u._count.liveReactionSessions,
    filmsAdded: u._count.addedFilms,
  })

  // When searching, sort by match quality (exact > starts-with > contains) then paginate in JS
  if (search) {
    const allUsers = await prisma.user.findMany({
      where,
      orderBy,
      take: 500,
      select: userSelect,
    })

    const qLower = search.toLowerCase()
    allUsers.sort((a, b) => {
      const tier = (u: (typeof allUsers)[number]) => {
        const fields = [u.name ?? '', u.email ?? ''].map((f) => f.toLowerCase())
        if (fields.some((f) => f === qLower)) return 0
        if (fields.some((f) => f.startsWith(qLower))) return 1
        return 2
      }
      return tier(a) - tier(b)
    })

    const total = allUsers.length
    let result = allUsers.slice((page - 1) * perPage, (page - 1) * perPage + perPage).map(mapUser)

    if (sort === 'reviewCount') {
      result.sort((a, b) => order === 'desc' ? b.reviewCount - a.reviewCount : a.reviewCount - b.reviewCount)
    }

    return Response.json({
      users: result,
      total,
      page,
      totalPages: Math.ceil(total / perPage),
    })
  }

  const [users, total] = await Promise.all([
    prisma.user.findMany({
      where,
      orderBy,
      skip: (page - 1) * perPage,
      take: perPage,
      select: userSelect,
    }),
    prisma.user.count({ where }),
  ])

  // If sorting by reviewCount, do it in memory (Prisma doesn't support orderBy on _count in findMany with select)
  let result = users.map(mapUser)

  if (sort === 'reviewCount') {
    result.sort((a, b) => order === 'desc' ? b.reviewCount - a.reviewCount : a.reviewCount - b.reviewCount)
  }

  return Response.json({
    users: result,
    total,
    page,
    totalPages: Math.ceil(total / perPage),
  })
}
