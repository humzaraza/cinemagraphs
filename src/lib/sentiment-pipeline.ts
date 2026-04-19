import { prisma } from './prisma'
import { fetchAnchorScores } from './omdb'
import { fetchAllReviews, computeReviewHash } from './review-fetcher'
import {
  analyzeSentiment,
  buildAnalysisPromptParts,
  type PlotContext,
  type AnalysisPromptParts,
} from './claude'
import type { AnchorScores } from './omdb'
import type { SentimentDataPoint, SentimentGraphData } from '@/lib/types'
import type { Film, Review } from '@/generated/prisma/client'
import { pipelineLogger } from './logger'
import { fetchWikipediaPlot } from './sources/wikipedia'
import {
  safeWriteSentimentGraph,
  forceOverwriteSentimentGraph,
  type BeatLockCallerPath,
} from './sentiment-beat-lock'
import {
  generateHybridSentimentGraph,
  buildAnchorString,
  type HybridResult,
} from './hybrid-sentiment'

const TMDB_API_KEY = process.env.TMDB_API_KEY!
const TMDB_BASE_URL = process.env.TMDB_BASE_URL || 'https://api.themoviedb.org/3'

// ── Review quality filter ──

const ENGLISH_REGEX = /^[\x00-\x7F\u00C0-\u024F\u2018-\u201D\u2014\u2013\u2026\s.,;:!?'"()\-[\]{}@#$%^&*+=/<>~`|\\]+$/
const MIN_WORD_COUNT = 50

// Minimum quality reviews required to generate a sentiment graph. Kept in sync
// with MIN_REVIEWS_TO_DISPLAY_GRAPH in film-display-state.ts so generation and
// display agree on the same floor.
export const MIN_QUALITY_REVIEWS_FOR_GENERATION = 3

export function isQualityReview(text: string): boolean {
  const words = text.trim().split(/\s+/)
  if (words.length < MIN_WORD_COUNT) return false
  // Check if predominantly English/Latin characters
  if (!ENGLISH_REGEX.test(text.slice(0, 500))) return false
  return true
}

/**
 * Check if a film needs re-analysis based on review growth threshold.
 * Returns true if:
 * - No existing graph (never analyzed)
 * - Filtered review count grew by ≥10% over lastReviewCount
 *
 * This is the cheap pre-filter used by the cron — it does not fetch reviews
 * from external sources and does not compute any hashes. The deeper "did
 * anything actually change" check happens inside `prepareSentimentGraphInput`.
 */
export async function filmNeedsReanalysis(filmId: string): Promise<{ needsAnalysis: boolean; filteredCount: number; reason: string }> {
  const film = await prisma.film.findUnique({
    where: { id: filmId },
    include: { sentimentGraph: { select: { id: true } } },
  })
  if (!film) return { needsAnalysis: false, filteredCount: 0, reason: 'Film not found' }

  // Never analyzed — always analyze
  if (!film.sentimentGraph) {
    return { needsAnalysis: true, filteredCount: 0, reason: 'No existing graph' }
  }

  // Count filtered reviews
  const reviews = await prisma.review.findMany({
    where: { filmId },
    select: { reviewText: true },
  })
  const filteredCount = reviews.filter((r) => isQualityReview(r.reviewText)).length

  const lastCount = film.lastReviewCount || 0
  if (lastCount === 0) {
    // Had a graph but lastReviewCount wasn't set (legacy) — re-analyze if ≥3 quality reviews
    return {
      needsAnalysis: filteredCount >= 3,
      filteredCount,
      reason: lastCount === 0 ? 'Legacy film, no lastReviewCount' : 'No previous reviews',
    }
  }

  const threshold = Math.max(1, Math.ceil(lastCount * 0.10))
  const newReviews = filteredCount - lastCount

  if (newReviews >= threshold) {
    return {
      needsAnalysis: true,
      filteredCount,
      reason: `${newReviews} new quality reviews (threshold: ${threshold})`,
    }
  }

  return {
    needsAnalysis: false,
    filteredCount,
    reason: `Only ${newReviews} new reviews (need ${threshold})`,
  }
}

/**
 * Fetch plot context using fallback chain:
 * Wikipedia → TMDB overview+tagline → OMDB plot → reviews only
 */
export async function fetchPlotContext(
  film: { title: string; tmdbId: number; imdbId: string | null; synopsis: string | null; releaseDate: Date | null }
): Promise<PlotContext> {
  const year = film.releaseDate ? new Date(film.releaseDate).getFullYear() : new Date().getFullYear()

  // 1. Try Wikipedia
  const wikiPlot = await fetchWikipediaPlot(film.title, year)
  if (wikiPlot) {
    return { text: wikiPlot, source: 'wikipedia' }
  }

  // 2. Try TMDB overview + tagline
  try {
    const tmdbRes = await fetch(`${TMDB_BASE_URL}/movie/${film.tmdbId}`, {
      headers: { Authorization: `Bearer ${TMDB_API_KEY}` },
    })
    if (tmdbRes.ok) {
      const tmdbData = await tmdbRes.json()
      const overview = tmdbData.overview || ''
      const tagline = tmdbData.tagline || ''
      const combined = [tagline, overview].filter(Boolean).join(' — ')
      if (combined.length >= 100) {
        pipelineLogger.info({ filmTitle: film.title, source: 'tmdb', length: combined.length }, 'Plot context from TMDB')
        return { text: combined, source: 'tmdb' }
      }
    }
  } catch {
    // Fall through
  }

  // 3. Try OMDB plot field
  if (film.imdbId) {
    try {
      const omdbKey = process.env.OMDB_API_KEY
      if (omdbKey) {
        const omdbRes = await fetch(`https://www.omdbapi.com/?i=${encodeURIComponent(film.imdbId)}&plot=full&apikey=${omdbKey}`)
        if (omdbRes.ok) {
          const omdbData = await omdbRes.json()
          if (omdbData.Response === 'True' && omdbData.Plot && omdbData.Plot !== 'N/A' && omdbData.Plot.length >= 100) {
            pipelineLogger.info({ filmTitle: film.title, source: 'omdb', length: omdbData.Plot.length }, 'Plot context from OMDB')
            return { text: omdbData.Plot, source: 'omdb' }
          }
        }
      }
    } catch {
      // Fall through
    }
  }

  // 4. Use film synopsis if available
  if (film.synopsis && film.synopsis.length >= 100) {
    pipelineLogger.info({ filmTitle: film.title, source: 'tmdb' }, 'Plot context from stored synopsis')
    return { text: film.synopsis, source: 'tmdb' }
  }

  // 5. Final fallback — reviews only
  pipelineLogger.info({ filmTitle: film.title }, 'No plot context found, using reviews only')
  return { text: '', source: 'reviews_only' }
}

async function lookupImdbId(tmdbId: number): Promise<string | null> {
  try {
    const res = await fetch(`${TMDB_BASE_URL}/movie/${tmdbId}/external_ids`, {
      headers: { Authorization: `Bearer ${TMDB_API_KEY}` },
    })
    if (!res.ok) return null
    const data = await res.json()
    return data.imdb_id || null
  } catch {
    return null
  }
}

/**
 * Fetch reviews from all sources and check if quality threshold is met.
 * Does NOT call Claude API — safe to run without cost concerns.
 * Stores fetched reviews in DB (deduplicates automatically).
 */
export async function fetchReviewsAndCheckThreshold(filmId: string): Promise<{
  qualityCount: number
  minRequired: number
  meetsThreshold: boolean
}> {
  const film = await prisma.film.findUnique({ where: { id: filmId } })
  if (!film) throw new Error(`Film not found: ${filmId}`)

  // Ensure IMDb ID for review sources that need it
  if (!film.imdbId) {
    const imdbId = await lookupImdbId(film.tmdbId)
    if (imdbId) {
      await prisma.film.update({ where: { id: filmId }, data: { imdbId } })
      film.imdbId = imdbId
    }
  }

  // Fetch and store reviews from all sources (deduplicates on store)
  await fetchAllReviews(film)

  // Count quality reviews
  const allReviews = await prisma.review.findMany({
    where: { filmId },
    select: { reviewText: true },
  })
  const qualityCount = allReviews.filter((r) => isQualityReview(r.reviewText)).length

  return {
    qualityCount,
    minRequired: MIN_QUALITY_REVIEWS_FOR_GENERATION,
    meetsThreshold: qualityCount >= MIN_QUALITY_REVIEWS_FOR_GENERATION,
  }
}

// ── Stage 1: prepare (no Claude call) ──────────────────────────────────────

export interface SentimentGraphInput {
  film: Film
  reviews: Review[]
  filteredReviewCount: number
  anchorScores: AnchorScores
  plotContext: PlotContext
  reviewHash: string
  promptParts: AnalysisPromptParts
}

export type PrepareSentimentInputResult =
  | { status: 'ready'; input: SentimentGraphInput }
  | { status: 'skipped_unchanged'; reviewHash: string; filteredCount: number }
  | { status: 'skipped_insufficient_reviews'; qualityCount: number; minRequired: number }
  | { status: 'skipped_film_not_found' }
  | { status: 'skipped_pre_release'; releaseDate: Date }

/**
 * Prepare everything needed to send a single film to Claude — fetches reviews,
 * resolves anchor scores, pulls plot context, computes the review hash, and
 * builds the prompt parts. The expensive Claude call has NOT happened yet.
 *
 * Skips early — saving the cost of a Claude call — when:
 *  - the film doesn't exist
 *  - quality reviews are below threshold
 *  - the review set hasn't changed since the last graph (hash match), unless
 *    `force` is set
 */
export async function prepareSentimentGraphInput(
  filmId: string,
  options: { force?: boolean } = {}
): Promise<PrepareSentimentInputResult> {
  const filmRecord = await prisma.film.findUnique({
    where: { id: filmId },
    include: { sentimentGraph: { select: { id: true, reviewHash: true } } },
  })
  if (!filmRecord) {
    pipelineLogger.warn({ filmId }, 'Film not found during prep')
    return { status: 'skipped_film_not_found' }
  }

  if (filmRecord.releaseDate && filmRecord.releaseDate > new Date()) {
    pipelineLogger.info(
      { filmId, releaseDate: filmRecord.releaseDate, reason: 'skipped_pre_release' },
      'Skipping — film has not been released yet'
    )
    return { status: 'skipped_pre_release', releaseDate: filmRecord.releaseDate }
  }

  // Strip the included relation off so we can pass a clean Film to claude.ts
  const { sentimentGraph: existingGraph, ...film } = filmRecord
  const filmForAnalysis = film as Film

  pipelineLogger.info({ filmId: film.id, filmTitle: film.title }, 'Preparing sentiment input')

  // Ensure IMDb ID for review sources that need it
  if (!filmForAnalysis.imdbId) {
    const imdbId = await lookupImdbId(film.tmdbId)
    if (imdbId) {
      await prisma.film.update({ where: { id: filmId }, data: { imdbId } })
      filmForAnalysis.imdbId = imdbId
    }
  }

  // Fetch anchor scores from OMDB (and update the film row with new values)
  let anchorScores: AnchorScores = {
    imdbRating: filmForAnalysis.imdbRating,
    rtCriticsScore: filmForAnalysis.rtCriticsScore,
    rtAudienceScore: filmForAnalysis.rtAudienceScore,
    metacriticScore: filmForAnalysis.metacriticScore,
  }
  if (filmForAnalysis.imdbId) {
    const omdbScores = await fetchAnchorScores(filmForAnalysis.imdbId)
    const updates: Record<string, number | null> = {}
    if (omdbScores.imdbRating && !filmForAnalysis.imdbRating) updates.imdbRating = omdbScores.imdbRating
    if (omdbScores.rtCriticsScore) updates.rtCriticsScore = omdbScores.rtCriticsScore
    if (omdbScores.rtAudienceScore) updates.rtAudienceScore = omdbScores.rtAudienceScore
    if (omdbScores.metacriticScore) updates.metacriticScore = omdbScores.metacriticScore
    if (Object.keys(updates).length > 0) {
      await prisma.film.update({ where: { id: filmId }, data: updates })
    }
    anchorScores = {
      imdbRating: omdbScores.imdbRating || filmForAnalysis.imdbRating,
      rtCriticsScore: omdbScores.rtCriticsScore || filmForAnalysis.rtCriticsScore,
      rtAudienceScore: omdbScores.rtAudienceScore || filmForAnalysis.rtAudienceScore,
      metacriticScore: omdbScores.metacriticScore || filmForAnalysis.metacriticScore,
    }
  }

  pipelineLogger.info(
    {
      filmId: film.id,
      filmTitle: film.title,
      imdbRating: anchorScores.imdbRating,
      rtCriticsScore: anchorScores.rtCriticsScore,
      metacriticScore: anchorScores.metacriticScore,
    },
    'Anchor scores fetched'
  )

  // Fetch reviews from all sources (stores new ones, dedupes existing)
  await fetchAllReviews(filmForAnalysis)

  // Pull all stored reviews — order by fetchedAt so the slice(0, 40) inside
  // the prompt builder sends the freshest reviews first.
  const allReviews = await prisma.review.findMany({
    where: { filmId: film.id },
    orderBy: { fetchedAt: 'desc' },
  })
  const reviews = allReviews.filter((r) => isQualityReview(r.reviewText))
  const filteredReviewCount = reviews.length

  if (reviews.length < MIN_QUALITY_REVIEWS_FOR_GENERATION) {
    pipelineLogger.info(
      { filmId: film.id, filmTitle: film.title, qualityCount: reviews.length, minRequired: MIN_QUALITY_REVIEWS_FOR_GENERATION },
      'Skipping — insufficient quality reviews'
    )
    return {
      status: 'skipped_insufficient_reviews',
      qualityCount: reviews.length,
      minRequired: MIN_QUALITY_REVIEWS_FOR_GENERATION,
    }
  }

  // Hash check — bail out if the review set is identical to the last analysis
  const reviewHash = computeReviewHash(reviews)
  const existingHash = existingGraph?.reviewHash
  if (!options.force && existingHash && existingHash === reviewHash) {
    pipelineLogger.info(
      { filmId: film.id, filmTitle: film.title, reviewHash },
      'Skipping — review set unchanged (hash match)'
    )
    return { status: 'skipped_unchanged', reviewHash, filteredCount: filteredReviewCount }
  }

  // Fetch plot context (Wikipedia → TMDB → OMDB → reviews_only)
  const plotContext = await fetchPlotContext(filmForAnalysis)
  pipelineLogger.info(
    { filmId: film.id, filmTitle: film.title, plotSource: plotContext.source },
    'Plot context resolved'
  )

  const promptParts = buildAnalysisPromptParts(filmForAnalysis, reviews, anchorScores, plotContext)

  return {
    status: 'ready',
    input: {
      film: filmForAnalysis,
      reviews,
      filteredReviewCount,
      anchorScores,
      plotContext,
      reviewHash,
      promptParts,
    },
  }
}

// ── Stage 3: store result ──────────────────────────────────────────────────

/**
 * Persist a Claude analysis result as a SentimentGraph row, and update the
 * film's lastReviewCount so the cheap pre-filter still works.
 */
export async function storeSentimentGraphResult(
  input: SentimentGraphInput,
  graphData: SentimentGraphData,
  callerPath: BeatLockCallerPath,
  options: { forceOverwrite?: boolean } = {}
): Promise<void> {
  const { film, filteredReviewCount, reviewHash } = input
  const existing = await prisma.sentimentGraph.findUnique({ where: { filmId: film.id } })

  const otherFields = {
    previousScore: existing ? existing.overallScore : undefined,
    overallScore: graphData.overallSentiment,
    anchoredFrom: graphData.anchoredFrom,
    peakMoment: graphData.peakMoment,
    lowestMoment: graphData.lowestMoment,
    biggestSwing: graphData.biggestSentimentSwing,
    summary: graphData.summary,
    reviewCount: graphData.reviewCount,
    sourcesUsed: graphData.sources,
    generatedAt: new Date(),
    version: existing ? existing.version + 1 : undefined,
    reviewHash,
  }

  if (options.forceOverwrite) {
    await forceOverwriteSentimentGraph({
      filmId: film.id,
      dataPoints: graphData.dataPoints as unknown as SentimentDataPoint[],
      otherFields,
      callerPath,
    })
  } else {
    await safeWriteSentimentGraph({
      filmId: film.id,
      incomingDataPoints: graphData.dataPoints as unknown as SentimentDataPoint[],
      otherFields,
      callerPath,
    })
  }

  if (existing) {
    pipelineLogger.info(
      { filmId: film.id, filmTitle: film.title, version: existing.version + 1 },
      'Updated sentiment graph'
    )
  } else {
    pipelineLogger.info({ filmId: film.id, filmTitle: film.title }, 'Created sentiment graph')
  }

  // Update lastReviewCount so the cheap pre-filter still works
  await prisma.film.update({
    where: { id: film.id },
    data: { lastReviewCount: filteredReviewCount },
  })
}

// ── Convenience: per-film analysis (used by admin endpoints + scripts) ─────

/**
 * One-shot analysis of a single film. Used by admin "Analyze" buttons and
 * scripts that want a sequential, synchronous-feeling API. The cron uses the
 * Batch API path (prepareSentimentGraphInput → analyzeSentimentBatch →
 * storeSentimentGraphResult) instead.
 *
 * `force` defaults to `false` — meaning hash-match skip is honored. Admin
 * "regenerate" buttons should pass `force: true` to bypass the hash skip.
 *
 * `forceOverwrite` defaults to `false` — the write goes through the safe,
 * label-preserving path. Pass `forceOverwrite: true` when the caller's intent
 * is a clean relabel (e.g. admin "Analyze" button).
 */
export async function generateSentimentGraph(
  filmId: string,
  options: { force?: boolean; forceOverwrite?: boolean; callerPath: BeatLockCallerPath }
): Promise<void> {
  const prep = await prepareSentimentGraphInput(filmId, { force: options.force })

  if (prep.status === 'skipped_film_not_found') {
    throw new Error(`Film not found: ${filmId}`)
  }
  if (prep.status === 'skipped_pre_release') {
    pipelineLogger.info(
      { filmId, releaseDate: prep.releaseDate, reason: 'skipped_pre_release' },
      'generateSentimentGraph: skipped (pre-release)'
    )
    return
  }
  if (prep.status === 'skipped_insufficient_reviews') {
    throw new Error(
      `Insufficient quality reviews: only ${prep.qualityCount} found (minimum ${prep.minRequired} required)`
    )
  }
  if (prep.status === 'skipped_unchanged') {
    pipelineLogger.info(
      { filmId, reviewHash: prep.reviewHash },
      'generateSentimentGraph: skipped (review set unchanged)'
    )
    return
  }

  const { input } = prep
  const graphData = await analyzeSentiment(
    input.film,
    input.reviews,
    input.anchorScores,
    input.plotContext
  )
  await storeSentimentGraphResult(input, graphData, options.callerPath, {
    forceOverwrite: options.forceOverwrite,
  })
}

export async function generateBatchSentimentGraphs(
  filmIds: string[],
  options: { force?: boolean; forceOverwrite?: boolean; callerPath: BeatLockCallerPath }
): Promise<{
  succeeded: string[]
  failed: { id: string; error: string }[]
}> {
  const succeeded: string[] = []
  const failed: { id: string; error: string }[] = []

  for (const filmId of filmIds) {
    try {
      await generateSentimentGraph(filmId, options)
      succeeded.push(filmId)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      pipelineLogger.error({ filmId, error: message }, 'Film analysis failed')
      failed.push({ id: filmId, error: message })
    }

    // Brief pause between films to avoid rate limits
    if (filmIds.indexOf(filmId) < filmIds.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 2000))
    }
  }

  pipelineLogger.info({ succeeded: succeeded.length, failed: failed.length }, 'Batch complete')
  return { succeeded, failed }
}

// ── Hybrid pipeline wrapper ────────────────────────────────────────────────
//
// The admin per-row Regenerate and Generate All buttons route through here.
// Unlike generateSentimentGraph (classic), this wrapper:
//  - calls generateHybridSentimentGraph, which emits beats with labelFull
//  - persists through safeWriteSentimentGraph (lock-preserving) only — there
//    is no forceOverwrite option. Admin UI must not be able to orphan user
//    beat ratings through a regeneration click.

export type GenerateHybridAndStoreResult =
  | { status: 'generated'; beatCount: number; generationMode: HybridResult['generationMode'] }
  | { status: 'skipped_pre_release'; releaseDate: Date }
  | { status: 'skipped_unchanged'; reviewHash: string; filteredCount: number }

/**
 * Generate a hybrid (Wikipedia-grounded) sentiment graph for one film and
 * persist it via the beat-lock-preserving safe write.
 *
 * Behaviour mirrors generateSentimentGraph's skip logic (film-not-found,
 * pre-release, insufficient reviews, review-hash unchanged) so admin routes
 * can swap call sites with no response-shape changes. Throws on
 * film-not-found and insufficient-reviews to match existing admin error
 * flows.
 */
export async function generateHybridAndStore(
  filmId: string,
  options: { force?: boolean; callerPath: BeatLockCallerPath }
): Promise<GenerateHybridAndStoreResult> {
  const filmRecord = await prisma.film.findUnique({
    where: { id: filmId },
    include: { sentimentGraph: { select: { id: true, reviewHash: true, overallScore: true, version: true } } },
  })
  if (!filmRecord) {
    throw new Error(`Film not found: ${filmId}`)
  }

  if (filmRecord.releaseDate && filmRecord.releaseDate > new Date()) {
    pipelineLogger.info(
      { filmId, releaseDate: filmRecord.releaseDate, reason: 'skipped_pre_release' },
      'generateHybridAndStore: skipped (pre-release)'
    )
    return { status: 'skipped_pre_release', releaseDate: filmRecord.releaseDate }
  }

  const { sentimentGraph: existingGraph, ...film } = filmRecord
  const filmForAnalysis = film as Film

  if (!filmForAnalysis.imdbId) {
    const imdbId = await lookupImdbId(film.tmdbId)
    if (imdbId) {
      await prisma.film.update({ where: { id: filmId }, data: { imdbId } })
      filmForAnalysis.imdbId = imdbId
    }
  }

  // Refresh anchor scores from OMDB so the hybrid prompt uses current values.
  // Matches prepareSentimentGraphInput's behaviour for the classic path.
  if (filmForAnalysis.imdbId) {
    const omdbScores = await fetchAnchorScores(filmForAnalysis.imdbId)
    const updates: Record<string, number | null> = {}
    if (omdbScores.imdbRating && !filmForAnalysis.imdbRating) updates.imdbRating = omdbScores.imdbRating
    if (omdbScores.rtCriticsScore) updates.rtCriticsScore = omdbScores.rtCriticsScore
    if (omdbScores.rtAudienceScore) updates.rtAudienceScore = omdbScores.rtAudienceScore
    if (omdbScores.metacriticScore) updates.metacriticScore = omdbScores.metacriticScore
    if (Object.keys(updates).length > 0) {
      await prisma.film.update({ where: { id: filmId }, data: updates })
      if (omdbScores.imdbRating && !filmForAnalysis.imdbRating) filmForAnalysis.imdbRating = omdbScores.imdbRating
      if (omdbScores.rtCriticsScore) filmForAnalysis.rtCriticsScore = omdbScores.rtCriticsScore
      if (omdbScores.rtAudienceScore) filmForAnalysis.rtAudienceScore = omdbScores.rtAudienceScore
      if (omdbScores.metacriticScore) filmForAnalysis.metacriticScore = omdbScores.metacriticScore
    }
  }

  // Fetch reviews (stores new, dedupes) and compute quality count + hash.
  await fetchAllReviews(filmForAnalysis)
  const allReviews = await prisma.review.findMany({
    where: { filmId: film.id },
    orderBy: { fetchedAt: 'desc' },
  })
  const qualityReviews = allReviews.filter((r) => isQualityReview(r.reviewText))
  const filteredReviewCount = qualityReviews.length

  if (filteredReviewCount < MIN_QUALITY_REVIEWS_FOR_GENERATION) {
    throw new Error(
      `Insufficient quality reviews: only ${filteredReviewCount} found (minimum ${MIN_QUALITY_REVIEWS_FOR_GENERATION} required)`
    )
  }

  const reviewHash = computeReviewHash(qualityReviews)
  const existingHash = existingGraph?.reviewHash
  if (!options.force && existingHash && existingHash === reviewHash) {
    pipelineLogger.info(
      { filmId, reviewHash },
      'generateHybridAndStore: skipped (review set unchanged)'
    )
    return { status: 'skipped_unchanged', reviewHash, filteredCount: filteredReviewCount }
  }

  const hybrid = await generateHybridSentimentGraph(filmId)

  const { anchorString } = buildAnchorString(filmForAnalysis)
  const sourcesUsed = [...new Set(qualityReviews.map((r) => r.sourcePlatform.toLowerCase()))]

  await safeWriteSentimentGraph({
    filmId,
    incomingDataPoints: hybrid.beats,
    otherFields: {
      previousScore: existingGraph?.overallScore ?? null,
      overallScore: hybrid.overallScore,
      anchoredFrom: anchorString,
      varianceSource: 'external_only',
      peakMoment: hybrid.peakMoment,
      lowestMoment: hybrid.lowestMoment,
      biggestSwing: hybrid.biggestSentimentSwing,
      summary: hybrid.summary,
      reviewCount: hybrid.reviewCount,
      sourcesUsed,
      generatedAt: new Date(),
      version: (existingGraph?.version ?? 0) + 1,
      reviewHash,
    },
    callerPath: options.callerPath,
  })

  await prisma.film.update({
    where: { id: filmId },
    data: { lastReviewCount: filteredReviewCount },
  })

  pipelineLogger.info(
    {
      filmId,
      filmTitle: film.title,
      beatCount: hybrid.beats.length,
      generationMode: hybrid.generationMode,
    },
    'generateHybridAndStore: written'
  )

  return {
    status: 'generated',
    beatCount: hybrid.beats.length,
    generationMode: hybrid.generationMode,
  }
}

export async function generateBatchHybridAndStore(
  filmIds: string[],
  options: { force?: boolean; callerPath: BeatLockCallerPath }
): Promise<{
  succeeded: string[]
  failed: { id: string; error: string }[]
}> {
  const succeeded: string[] = []
  const failed: { id: string; error: string }[] = []

  for (const filmId of filmIds) {
    try {
      await generateHybridAndStore(filmId, options)
      succeeded.push(filmId)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      pipelineLogger.error({ filmId, error: message }, 'Hybrid film analysis failed')
      failed.push({ id: filmId, error: message })
    }

    if (filmIds.indexOf(filmId) < filmIds.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 2000))
    }
  }

  pipelineLogger.info({ succeeded: succeeded.length, failed: failed.length }, 'Hybrid batch complete')
  return { succeeded, failed }
}
