import { describe, it, expect, vi, beforeEach } from 'vitest'

interface FilmRow {
  id: string
  keywords: string[]
  genres: string[]
  director: string | null
  releaseDate: Date | null
  originalLanguage: string | null
}

const mocks = vi.hoisted(() => ({
  prisma: {
    film: { findMany: vi.fn() },
    similarFilm: {
      deleteMany: vi.fn(),
      createMany: vi.fn(),
    },
    $transaction: vi.fn(),
  },
  invalidateFilmSimilarCache: vi.fn(),
  loggerChildWarn: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({ prisma: mocks.prisma }))
vi.mock('@/lib/cache', () => ({
  invalidateFilmSimilarCache: mocks.invalidateFilmSimilarCache,
}))
vi.mock('@/lib/logger', () => ({
  logger: {
    child: () => ({ warn: mocks.loggerChildWarn, info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}))

// Catalog used across most tests. Source S is constructed so its top-N matches A, B, C
// (each shares director + keywords + era). D and E are deliberately weaker matches.
const SOURCE_KEYWORDS = ['heist', 'dream', 'mind-bending']
const baseDate = (year: number) => new Date(`${year}-07-16T12:00:00Z`)

const CATALOG_DEFAULT: FilmRow[] = [
  {
    id: 'S',
    keywords: SOURCE_KEYWORDS,
    genres: ['Action', 'Sci-Fi'],
    director: 'Nolan',
    releaseDate: baseDate(2010),
    originalLanguage: null,
  },
  {
    id: 'A',
    keywords: ['heist', 'dream'],
    genres: ['Action', 'Sci-Fi'],
    director: 'Nolan',
    releaseDate: baseDate(2010),
    originalLanguage: null,
  },
  {
    id: 'B',
    keywords: ['heist'],
    genres: ['Action'],
    director: 'Nolan',
    releaseDate: baseDate(2012),
    originalLanguage: null,
  },
  {
    id: 'C',
    keywords: ['mind-bending'],
    genres: ['Sci-Fi'],
    director: 'Nolan',
    releaseDate: baseDate(2014),
    originalLanguage: null,
  },
  {
    // Era is the trickiest sink: ≤30 years from S (2010) still yields era=0.3
    // and therefore a non-zero total via the era weight. Push D to 1970 so the
    // year distance (40) lands beyond the 30-year cutoff and the total is 0.
    id: 'D',
    keywords: ['romance'],
    genres: ['Romance'],
    director: 'Ephron',
    releaseDate: baseDate(1970),
    originalLanguage: null,
  },
  {
    id: 'E',
    keywords: [],
    genres: [],
    director: null,
    releaseDate: null,
    originalLanguage: null,
  },
]

function makeTransactionRunner() {
  // Captures the operations sent to $transaction so tests can introspect the write sequence.
  const calls: Array<{ kind: 'delete' | 'create'; filmId: string; rowFilmIds?: string[] }> = []
  const transaction = vi.fn(async (ops: unknown[]) => {
    for (const op of ops) {
      const tagged = op as { __op: 'delete' | 'create'; filmId: string; rowFilmIds?: string[] }
      calls.push({ kind: tagged.__op, filmId: tagged.filmId, rowFilmIds: tagged.rowFilmIds })
    }
    return []
  })
  return { transaction, calls }
}

function primePrismaMock(catalog: FilmRow[] = CATALOG_DEFAULT) {
  mocks.prisma.film.findMany.mockResolvedValue(catalog)
  // deleteMany/createMany return "promise-like" markers we can identify inside $transaction.
  mocks.prisma.similarFilm.deleteMany.mockImplementation(({ where }: { where: { filmId: string } }) => ({
    __op: 'delete',
    filmId: where.filmId,
  }))
  mocks.prisma.similarFilm.createMany.mockImplementation(({ data }: { data: Array<{ filmId: string; similarFilmId: string }> }) => ({
    __op: 'create',
    filmId: data[0]?.filmId,
    rowFilmIds: data.map((d) => d.similarFilmId),
  }))
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.resetModules()
  primePrismaMock()
})

describe('recomputeSimilarFilmsForFilm — bidirectional', () => {
  it("recomputes each of the source's top-N neighbors after the source itself", async () => {
    const { transaction, calls } = makeTransactionRunner()
    mocks.prisma.$transaction.mockImplementation(transaction)

    const { recomputeSimilarFilmsForFilm } = await import('@/lib/similar-films')
    await recomputeSimilarFilmsForFilm('S')

    // Source (S) is committed first, then each neighbor in score-desc order.
    // A, B, C are the only candidates with non-zero score against S (D differs in
    // director/genre/era; E has zero info). A beats B beats C by keyword overlap.
    const deletedInOrder = calls.filter((c) => c.kind === 'delete').map((c) => c.filmId)
    expect(deletedInOrder[0]).toBe('S')
    expect(deletedInOrder.slice(1).sort()).toEqual(['A', 'B', 'C'])

    // Each affected film also got a createMany with its own top.
    const createdFor = calls.filter((c) => c.kind === 'create').map((c) => c.filmId)
    expect(createdFor.sort()).toEqual(['A', 'B', 'C', 'S'])
  })

  it('invalidates the filmSimilar cache for each neighbor (not for the source)', async () => {
    mocks.prisma.$transaction.mockResolvedValue([])
    const { recomputeSimilarFilmsForFilm } = await import('@/lib/similar-films')
    await recomputeSimilarFilmsForFilm('S')

    const invalidatedIds = mocks.invalidateFilmSimilarCache.mock.calls.map((c) => c[0]).sort()
    expect(invalidatedIds).toEqual(['A', 'B', 'C'])
    expect(invalidatedIds).not.toContain('S')
  })

  it('is idempotent across two consecutive calls (same write sequence)', async () => {
    const run1 = makeTransactionRunner()
    mocks.prisma.$transaction.mockImplementation(run1.transaction)
    const { recomputeSimilarFilmsForFilm } = await import('@/lib/similar-films')
    await recomputeSimilarFilmsForFilm('S')

    // Second pass uses a fresh runner but the same prisma findMany return value.
    mocks.prisma.film.findMany.mockResolvedValue(CATALOG_DEFAULT)
    const run2 = makeTransactionRunner()
    mocks.prisma.$transaction.mockImplementation(run2.transaction)
    await recomputeSimilarFilmsForFilm('S')

    expect(run2.calls).toEqual(run1.calls)
  })

  it('does no bidirectional work when the source has zero scoring matches', async () => {
    // Catalog where the source has no overlap with anyone: every signal returns 0.
    primePrismaMock([
      { id: 'S', keywords: [], genres: [], director: null, releaseDate: null, originalLanguage: null },
      { id: 'X', keywords: ['unrelated'], genres: ['Romance'], director: 'OtherDir', releaseDate: baseDate(1900), originalLanguage: null },
    ])
    const { transaction, calls } = makeTransactionRunner()
    mocks.prisma.$transaction.mockImplementation(transaction)

    const { recomputeSimilarFilmsForFilm } = await import('@/lib/similar-films')
    const written = await recomputeSimilarFilmsForFilm('S')

    expect(written).toBe(0)
    // Exactly one transaction: S's own delete (and no createMany since top is empty).
    expect(calls).toEqual([{ kind: 'delete', filmId: 'S' }])
    expect(mocks.invalidateFilmSimilarCache).not.toHaveBeenCalled()
  })

  it("returns 0 and does no writes when the source filmId is not in the catalog", async () => {
    primePrismaMock(CATALOG_DEFAULT.filter((f) => f.id !== 'S'))
    const { recomputeSimilarFilmsForFilm } = await import('@/lib/similar-films')
    const result = await recomputeSimilarFilmsForFilm('S')
    expect(result).toBe(0)
    expect(mocks.prisma.$transaction).not.toHaveBeenCalled()
    expect(mocks.invalidateFilmSimilarCache).not.toHaveBeenCalled()
  })

  it("continues processing remaining neighbors when one neighbor's recompute throws", async () => {
    let callCount = 0
    // First call is S's own commit (succeeds). Second call (the FIRST neighbor) throws.
    // Subsequent calls (the other neighbors) must still run.
    mocks.prisma.$transaction.mockImplementation(async () => {
      callCount++
      if (callCount === 2) throw new Error('simulated neighbor failure')
      return []
    })
    const { recomputeSimilarFilmsForFilm } = await import('@/lib/similar-films')
    const written = await recomputeSimilarFilmsForFilm('S')

    // S's own commit succeeded → returns the source's top count (3 here).
    expect(written).toBe(3)
    // 1 (S) + 3 (each neighbor attempted, even though one threw) = 4 transactions.
    expect(mocks.prisma.$transaction).toHaveBeenCalledTimes(4)
    // The failing neighbor (first one attempted in sort order) gets a warn log.
    expect(mocks.loggerChildWarn).toHaveBeenCalledTimes(1)
    // The two surviving neighbors still got cache invalidation; the failed one did not.
    expect(mocks.invalidateFilmSimilarCache).toHaveBeenCalledTimes(2)
  })
})
