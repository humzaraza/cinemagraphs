import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockFilmFindUnique = vi.fn()
const mockFilmBeatsUpsert = vi.fn()
const mockFetchWikipediaPlot = vi.fn()
const mockGenerateBeatsFromPlot = vi.fn()

vi.mock('@/lib/prisma', () => ({
  prisma: {
    film: { findUnique: (...args: unknown[]) => mockFilmFindUnique(...args) },
    filmBeats: { upsert: (...args: unknown[]) => mockFilmBeatsUpsert(...args) },
  },
}))

vi.mock('@/lib/sources/wikipedia', () => ({
  fetchWikipediaPlot: (...args: unknown[]) => mockFetchWikipediaPlot(...args),
}))

vi.mock('@/lib/beat-generator', () => ({
  generateBeatsFromPlot: (...args: unknown[]) => mockGenerateBeatsFromPlot(...args),
}))

vi.mock('@/lib/logger', () => ({
  pipelineLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

describe('wiki-beat-fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('skips when sentiment graph already exists', async () => {
    mockFilmFindUnique.mockResolvedValueOnce({
      id: 'film1',
      title: 'Test',
      releaseDate: new Date('2024-01-01'),
      runtime: 120,
      sentimentGraph: { id: 'graph1' },
      filmBeats: null,
    })

    const { generateAndStoreWikiBeats } = await import('@/lib/wiki-beat-fallback')
    const result = await generateAndStoreWikiBeats('film1')

    expect(result).toEqual({ status: 'skipped_has_graph' })
    expect(mockFetchWikipediaPlot).not.toHaveBeenCalled()
    expect(mockFilmBeatsUpsert).not.toHaveBeenCalled()
  })

  it('skips when beats already exist and force is not set', async () => {
    mockFilmFindUnique.mockResolvedValueOnce({
      id: 'film1',
      title: 'Test',
      releaseDate: new Date('2024-01-01'),
      runtime: 120,
      sentimentGraph: null,
      filmBeats: { id: 'beats1' },
    })

    const { generateAndStoreWikiBeats } = await import('@/lib/wiki-beat-fallback')
    const result = await generateAndStoreWikiBeats('film1')

    expect(result).toEqual({ status: 'skipped_has_beats' })
    expect(mockFetchWikipediaPlot).not.toHaveBeenCalled()
    expect(mockFilmBeatsUpsert).not.toHaveBeenCalled()
  })

  it('regenerates when beats exist but force is true', async () => {
    mockFilmFindUnique.mockResolvedValueOnce({
      id: 'film1',
      title: 'Test',
      releaseDate: new Date('2024-01-01'),
      runtime: 120,
      sentimentGraph: null,
      filmBeats: { id: 'beats1' },
    })
    mockFetchWikipediaPlot.mockResolvedValueOnce('Plot text'.repeat(50))
    mockGenerateBeatsFromPlot.mockResolvedValueOnce([
      { label: 'A', timeStart: 0, timeEnd: 10, timeMidpoint: 5 },
      { label: 'B', timeStart: 20, timeEnd: 30, timeMidpoint: 25 },
      { label: 'C', timeStart: 40, timeEnd: 50, timeMidpoint: 45 },
      { label: 'D', timeStart: 60, timeEnd: 70, timeMidpoint: 65 },
    ])
    mockFilmBeatsUpsert.mockResolvedValueOnce({})

    const { generateAndStoreWikiBeats } = await import('@/lib/wiki-beat-fallback')
    const result = await generateAndStoreWikiBeats('film1', { force: true })

    expect(result).toEqual({ status: 'generated', beatCount: 4 })
    expect(mockFilmBeatsUpsert).toHaveBeenCalledTimes(1)
  })

  it('still skips force=true when sentiment graph exists', async () => {
    mockFilmFindUnique.mockResolvedValueOnce({
      id: 'film1',
      title: 'Test',
      releaseDate: new Date('2024-01-01'),
      runtime: 120,
      sentimentGraph: { id: 'graph1' },
      filmBeats: { id: 'beats1' },
    })

    const { generateAndStoreWikiBeats } = await import('@/lib/wiki-beat-fallback')
    const result = await generateAndStoreWikiBeats('film1', { force: true })

    expect(result).toEqual({ status: 'skipped_has_graph' })
    expect(mockFilmBeatsUpsert).not.toHaveBeenCalled()
  })

  it('returns skipped_no_year when film has no release date', async () => {
    mockFilmFindUnique.mockResolvedValueOnce({
      id: 'film1',
      title: 'Test',
      releaseDate: null,
      runtime: 120,
      sentimentGraph: null,
      filmBeats: null,
    })

    const { generateAndStoreWikiBeats } = await import('@/lib/wiki-beat-fallback')
    const result = await generateAndStoreWikiBeats('film1')

    expect(result).toEqual({ status: 'skipped_no_year' })
    expect(mockFetchWikipediaPlot).not.toHaveBeenCalled()
  })

  it('returns skipped_no_plot when Wikipedia has no plot', async () => {
    mockFilmFindUnique.mockResolvedValueOnce({
      id: 'film1',
      title: 'Test',
      releaseDate: new Date('2024-01-01'),
      runtime: 120,
      sentimentGraph: null,
      filmBeats: null,
    })
    mockFetchWikipediaPlot.mockResolvedValueOnce(null)

    const { generateAndStoreWikiBeats } = await import('@/lib/wiki-beat-fallback')
    const result = await generateAndStoreWikiBeats('film1')

    expect(result).toEqual({ status: 'skipped_no_plot' })
    expect(mockFilmBeatsUpsert).not.toHaveBeenCalled()
  })

  it('returns skipped_generation_failed when beat generator returns empty', async () => {
    mockFilmFindUnique.mockResolvedValueOnce({
      id: 'film1',
      title: 'Test',
      releaseDate: new Date('2024-01-01'),
      runtime: 120,
      sentimentGraph: null,
      filmBeats: null,
    })
    mockFetchWikipediaPlot.mockResolvedValueOnce('Plot text'.repeat(50))
    mockGenerateBeatsFromPlot.mockResolvedValueOnce([])

    const { generateAndStoreWikiBeats } = await import('@/lib/wiki-beat-fallback')
    const result = await generateAndStoreWikiBeats('film1')

    expect(result).toEqual({ status: 'skipped_generation_failed' })
    expect(mockFilmBeatsUpsert).not.toHaveBeenCalled()
  })

  it('stores beats successfully when all preconditions are met', async () => {
    mockFilmFindUnique.mockResolvedValueOnce({
      id: 'film1',
      title: 'Test',
      releaseDate: new Date('2024-01-01'),
      runtime: 120,
      sentimentGraph: null,
      filmBeats: null,
    })
    mockFetchWikipediaPlot.mockResolvedValueOnce('Plot text'.repeat(50))
    mockGenerateBeatsFromPlot.mockResolvedValueOnce([
      { label: 'Opening', timeStart: 0, timeEnd: 10, timeMidpoint: 5 },
      { label: 'Conflict', timeStart: 30, timeEnd: 50, timeMidpoint: 40 },
      { label: 'Climax', timeStart: 80, timeEnd: 100, timeMidpoint: 90 },
      { label: 'Ending', timeStart: 100, timeEnd: 120, timeMidpoint: 110 },
    ])
    mockFilmBeatsUpsert.mockResolvedValueOnce({})

    const { generateAndStoreWikiBeats } = await import('@/lib/wiki-beat-fallback')
    const result = await generateAndStoreWikiBeats('film1')

    expect(result).toEqual({ status: 'generated', beatCount: 4 })
    expect(mockFilmBeatsUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { filmId: 'film1' },
        create: expect.objectContaining({
          filmId: 'film1',
          source: 'wikipedia',
        }),
      })
    )
  })

  it('returns film_not_found when film does not exist', async () => {
    mockFilmFindUnique.mockResolvedValueOnce(null)

    const { generateAndStoreWikiBeats } = await import('@/lib/wiki-beat-fallback')
    const result = await generateAndStoreWikiBeats('nonexistent')

    expect(result).toEqual({ status: 'film_not_found' })
  })
})
