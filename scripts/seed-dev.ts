import './_load-env'
import './_neon-ws'

/**
 * Local dev seed: two logins, six films with sentiment graphs, and six user
 * reviews (R1-R6) that together cover the review-rendering edge cases.
 *
 * THE FIXTURE SET
 *   R1  seed-film-1  approved  all 8 beats rated       the ordinary full-shape case
 *   R2  seed-film-2  approved  2 beats rated           sparse ratings, gaps in the overlay
 *   R3  seed-film-3  approved  beatRatings SQL NULL    prose-only review, no overlay at all
 *   R4  seed-film-4  flagged   3 beats rated           moderation UI with a real flagReason
 *   R5  seed-film-5  rejected  4 beats rated           rejected state, flagReason null
 *   R6  seed-film-6  approved  1 beat rated            degenerate single-point overlay
 *
 * BEAT LABELS ARE THE JOIN KEY. src/app/reviews/[id]/page.tsx matches a
 * review's beatRatings keys against the film's SentimentGraph dataPoints by
 * exact label string (`beatRatings[dp.label]`), and a key that matches nothing
 * is dropped with no error and no visible trace. The same is true on the write
 * path: POST /api/films/[id]/reviews filters submitted keys down to the labels
 * the graph actually offers. So if the labels below and the seeded dataPoints
 * ever drift apart, these fixtures keep loading and silently stop testing
 * anything. Keep BEAT_LABELS as the single source for both.
 *
 * Usage:
 *   SEED_USER_PASSWORD must be set in .env.local first.
 *   npm run seed:dev
 */

import bcrypt from 'bcrypt'
import { assertDevDatabase } from './seed-dev-guard'
import { Prisma } from '../src/generated/prisma/client'
import type { SentimentDataPoint } from '../src/lib/types'

// The eight beat labels, shared by every seeded film's graph and quoted
// verbatim by every seeded review's beatRatings keys.
const BEAT_LABELS = [
  'How did it start?',
  'Getting going',
  'The first turn',
  'Settling in',
  'The big moment',
  'It falls apart',
  'The turn home',
  'How it ends',
] as const

const RUNTIME_MINUTES = 120
const BEAT_MINUTES = RUNTIME_MINUTES / BEAT_LABELS.length // 15

const PRIMARY_USER_ID = 'seed-user-primary'
const SECONDARY_USER_ID = 'seed-user-secondary'
const PRIMARY_EMAIL = 'seed.primary@cinemagraphs.test'
const SECONDARY_EMAIL = 'seed.secondary@cinemagraphs.test'

interface SeedFilm {
  id: string
  tmdbId: number
  title: string
  /** Human name for the arc, for the log line only. */
  shape: string
  /** One score per BEAT_LABELS entry. Multiples of 0.5, within 1-10. */
  scores: number[]
}

// Six visibly different arcs. A flat line would make the overlay bugs these
// fixtures exist to expose much harder to see.
const FILMS: SeedFilm[] = [
  {
    id: 'seed-film-1',
    tmdbId: -900001,
    title: 'Seed Film One',
    shape: 'steady climb',
    scores: [4, 4.5, 5.5, 6, 7, 7.5, 8.5, 9],
  },
  {
    id: 'seed-film-2',
    tmdbId: -900002,
    title: 'Seed Film Two',
    shape: 'nosedive',
    scores: [8.5, 8, 7.5, 7, 5.5, 4, 3, 2.5],
  },
  {
    id: 'seed-film-3',
    tmdbId: -900003,
    title: 'Seed Film Three',
    shape: 'dip and recover',
    scores: [7, 6, 4.5, 3, 3.5, 5.5, 7.5, 8.5],
  },
  {
    id: 'seed-film-4',
    tmdbId: -900004,
    title: 'Seed Film Four',
    shape: 'hidden peak at the midpoint',
    scores: [3.5, 5, 6.5, 8.5, 9.5, 7, 5, 4],
  },
  {
    id: 'seed-film-5',
    tmdbId: -900005,
    title: 'Seed Film Five',
    shape: 'slow burn, late spike',
    scores: [2, 2.5, 3, 3.5, 4.5, 6, 8, 9.5],
  },
  {
    id: 'seed-film-6',
    tmdbId: -900006,
    title: 'Seed Film Six',
    shape: 'jagged',
    scores: [6, 8.5, 5, 9, 4.5, 8, 5.5, 7],
  },
]

interface SeedReview {
  id: string
  userId: string
  filmId: string
  overallRating: number
  /** Multiples of 0.5 within 1-10, because the real slider is step 0.5. */
  beatRatings: Record<string, number> | null
  beginning: string
  status: 'approved' | 'flagged' | 'rejected'
  flagReason: string | null
}

// EXACTLY ONE REVIEW PER FILM, DELIBERATELY.
// src/lib/review-blender.ts (maybeBlendAndUpdate) blends user beat ratings
// back into a film's SentimentGraph once that film has enough approved
// reviews carrying a non-null sentiment, and the blend rewrites the graph's
// dataPoints in place. A seed script whose graphs get rewritten by its own
// reviews is a fixture that lies: you would read the seeded scores here and
// see different scores in the app. One review per film makes that impossible
// at any threshold the blender might use now or later. (The seeded sentiment
// of null keeps them out of the blend's query too, but that is a second lock,
// not the reason.)
//
// R6 IS THE SINGLE-BEAT FIXTURE, ALSO DELIBERATELY.
// src/app/reviews/[id]/page.tsx builds the dashed teal overlay by mapping the
// film's dataPoints to whichever beats the review actually rated, then joining
// them into an SVG path. With one matched beat the path is just "M<x>,<y>",
// a moveto and nothing else, which draws no ink, while the legend beneath it
// still announces "This review's beats" with a dashed teal swatch. R6 is the
// reproduction case for that mismatch.
const REVIEWS: SeedReview[] = [
  {
    id: 'seed-review-1',
    userId: PRIMARY_USER_ID,
    filmId: 'seed-film-1',
    overallRating: 8,
    beatRatings: {
      'How did it start?': 5,
      'Getting going': 5.5,
      'The first turn': 6.5,
      'Settling in': 6,
      'The big moment': 9,
      'It falls apart': 7.5,
      'The turn home': 8,
      'How it ends': 9.5,
    },
    beginning:
      'The opening is patient in a way that pays off later, and by the halfway mark I had stopped noticing the runtime at all. Every beat lands harder than the one before it, which is rare.',
    status: 'approved',
    flagReason: null,
  },
  {
    id: 'seed-review-2',
    userId: PRIMARY_USER_ID,
    filmId: 'seed-film-2',
    overallRating: 5.5,
    // Two beats only: the overlay has to cope with gaps between the points it
    // can plot, not a continuous line across all eight.
    beatRatings: {
      'How did it start?': 7.5,
      'The big moment': 9.5,
    },
    beginning:
      'It starts strong and the centrepiece sequence is genuinely great, but I could not tell you a single thing about the last forty minutes. The energy drains out of it completely.',
    status: 'approved',
    flagReason: null,
  },
  {
    id: 'seed-review-3',
    userId: PRIMARY_USER_ID,
    filmId: 'seed-film-3',
    overallRating: 6.5,
    // SQL NULL, not an empty object. Written below as Prisma.DbNull, matching
    // POST /api/films/[id]/reviews, which stores DbNull when the reviewer
    // rated no beats. The detail page reads null here and hides the graph
    // block entirely, which is the case this fixture covers.
    beatRatings: null,
    beginning:
      'I did not rate the individual beats on this one because the film works as a single unbroken mood rather than a sequence of moments. Worth seeing, hard to chart.',
    status: 'approved',
    flagReason: null,
  },
  {
    id: 'seed-review-4',
    userId: PRIMARY_USER_ID,
    filmId: 'seed-film-4',
    overallRating: 7,
    // All three values identical on purpose: that is what earns the first
    // clause of the flagReason below.
    beatRatings: {
      'How did it start?': 7,
      'The big moment': 7,
      'How it ends': 7,
    },
    beginning:
      'Solid throughout without ever really surprising me, which is why the ratings came out looking the way they did. I would watch it again on a plane but not seek it out.',
    status: 'flagged',
    // Format and wording copied from autoModerate() in
    // src/app/api/films/[id]/reviews/route.ts: the reasons it collects are
    // joined with '; ' in the order it checks them (identical beat ratings,
    // then short text, then new account). This review's beats are all 7 and
    // its author was just created, so those are exactly the two clauses a
    // real run would produce. Note that autoModerate is currently bypassed
    // (AUTO_MODERATION_ENABLED = false), so no new review gets flagged today;
    // this fixture is how a flagged row looks when the flag is flipped back.
    flagReason: 'All beat ratings are identical; Account created less than 24 hours ago',
  },
  {
    id: 'seed-review-5',
    userId: PRIMARY_USER_ID,
    filmId: 'seed-film-5',
    overallRating: 3.5,
    beatRatings: {
      'How did it start?': 4,
      'Settling in': 3,
      'It falls apart': 2.5,
      'How it ends': 5.5,
    },
    beginning:
      'The premise deserved a much better film than this one, and the longer it went on the more obvious that became. The ending tries for profound and lands on unfinished.',
    status: 'rejected',
    // null matches what PATCH /api/admin/reviews/[id] actually leaves behind
    // on a rejection. That route only clears flagReason on approval; for
    // status 'rejected' it passes `flagReason: undefined`, which Prisma reads
    // as "leave this column alone". Since reviews are created with flagReason
    // null under the current auto-moderation bypass, null is what a rejected
    // row ends up holding. It is not the admin route writing null.
    flagReason: null,
  },
  {
    id: 'seed-review-6',
    userId: SECONDARY_USER_ID,
    filmId: 'seed-film-6',
    overallRating: 9,
    // One rated beat. See the R6 note above: this is the moveto-only SVG path.
    beatRatings: {
      'The big moment': 9,
    },
    beginning:
      'One sequence in this is the best thing I have seen all year and I am rating the whole film on the strength of it. Everything around that moment is merely fine.',
    status: 'approved',
    flagReason: null,
  },
]

/** Build the eight dataPoints for a film from its eight scores. */
function buildDataPoints(scores: number[]): SentimentDataPoint[] {
  return BEAT_LABELS.map((label, i) => {
    const timeStart = i * BEAT_MINUTES
    return {
      label,
      timeStart,
      timeEnd: timeStart + BEAT_MINUTES,
      timeMidpoint: timeStart + BEAT_MINUTES / 2,
      score: scores[i],
      confidence: 'medium' as const,
      reviewEvidence: `Seeded fixture beat: ${label}`,
    }
  })
}

function averageScore(scores: number[]): number {
  const mean = scores.reduce((sum, s) => sum + s, 0) / scores.length
  return Math.round(mean * 10) / 10
}

async function main() {
  // 1. Prove the target is the dev database before anything is constructed or
  //    written. assertDevDatabase throws on every path it cannot verify.
  const host = assertDevDatabase(process.env.DIRECT_URL ?? process.env.DATABASE_URL)
  console.log(`[seed] target host: ${host}`)

  // src/lib/prisma.ts builds its adapter from DATABASE_URL specifically, so
  // that is the connection the writes below actually travel over. Check it
  // too when it differs from the URL checked above, otherwise a dev DIRECT_URL
  // paired with a production DATABASE_URL would sail through the guard.
  if (process.env.DATABASE_URL && process.env.DATABASE_URL !== process.env.DIRECT_URL) {
    assertDevDatabase(process.env.DATABASE_URL)
  }

  // 2. Password comes from the environment only. Never generated, never
  //    defaulted, never printed.
  const password = process.env.SEED_USER_PASSWORD
  if (!password || password.length === 0) {
    console.error(
      '[seed] SEED_USER_PASSWORD is not set. Add it to .env.local (any password you want to log in with) and re-run.'
    )
    process.exit(1)
  }

  // 3. Same cost factor as src/app/api/auth/register/route.ts, so these
  //    accounts hash identically to real ones and NextAuth can verify them.
  const passwordHash = await bcrypt.hash(password, 12)

  // Imported here rather than at the top of the file so the client is only
  // constructed after the guard has passed.
  const { prisma } = await import('../src/lib/prisma')

  try {
    // 4. Users. emailVerified must be non-null or the credentials login
    //    rejects them. Everything below upserts by its deterministic id, so a
    //    second run updates in place instead of colliding on a unique key.
    const now = new Date()
    const users = [
      {
        id: PRIMARY_USER_ID,
        email: PRIMARY_EMAIL,
        name: 'Seed Primary',
        username: 'seedprimary',
      },
      {
        id: SECONDARY_USER_ID,
        email: SECONDARY_EMAIL,
        name: 'Seed Secondary',
        username: 'seedsecondary',
      },
    ]

    for (const user of users) {
      await prisma.user.upsert({
        where: { id: user.id },
        update: {
          email: user.email,
          name: user.name,
          username: user.username,
          role: 'USER',
          emailVerified: now,
          password: passwordHash,
          termsAcceptedAt: now,
        },
        create: {
          id: user.id,
          email: user.email,
          name: user.name,
          username: user.username,
          role: 'USER',
          emailVerified: now,
          password: passwordHash,
          termsAcceptedAt: now,
        },
      })
      console.log(`[seed] user ${user.id} (${user.email})`)
    }

    // 5. Films and their graphs.
    for (const film of FILMS) {
      await prisma.film.upsert({
        where: { id: film.id },
        update: {
          tmdbId: film.tmdbId,
          title: film.title,
          runtime: RUNTIME_MINUTES,
          status: 'ACTIVE',
        },
        create: {
          id: film.id,
          tmdbId: film.tmdbId,
          title: film.title,
          runtime: RUNTIME_MINUTES,
          status: 'ACTIVE',
        },
      })

      const dataPoints = buildDataPoints(film.scores)
      const graphFields = {
        overallScore: averageScore(film.scores),
        anchoredFrom: 'seed-dev',
        dataPoints: dataPoints as unknown as Prisma.InputJsonValue,
        // reviewCount on SentimentGraph counts the external reviews the graph
        // was generated from, not user reviews. Seeded films have none.
        reviewCount: 0,
        sourcesUsed: [],
      }

      await prisma.sentimentGraph.upsert({
        where: { filmId: film.id },
        update: graphFields,
        create: { filmId: film.id, ...graphFields },
      })
      console.log(`[seed] film ${film.id} "${film.title}" (${film.shape})`)
    }

    // 6. Reviews.
    for (const review of REVIEWS) {
      // combinedText is what the route derives: the non-empty text sections
      // joined by a space. The web client only ever sends `beginning`, so
      // middle, ending and otherThoughts stay null and combinedText equals
      // beginning exactly.
      const combinedText = review.beginning
      const reviewFields = {
        overallRating: review.overallRating,
        beginning: review.beginning,
        middle: null,
        ending: null,
        otherThoughts: null,
        combinedText,
        // Prisma.DbNull writes a SQL NULL into the Json column; a plain null
        // would be ambiguous with the JSON value `null`. This mirrors
        // `normalizedBeatRatings ?? Prisma.DbNull` in the reviews route.
        beatRatings: review.beatRatings ?? Prisma.DbNull,
        // sentiment stays null on every seeded review. extractSentiment() in
        // src/lib/sentiment-extract.ts is not a local computation: it calls
        // the Anthropic API over the network. A seed script must not depend
        // on a network call or spend tokens, so it is not called here and the
        // column is left null, which is also what the route stores whenever
        // extraction fails or returns nothing.
        sentiment: null,
        status: review.status,
        flagReason: review.flagReason,
      }

      await prisma.userReview.upsert({
        where: { id: review.id },
        update: reviewFields,
        create: { id: review.id, userId: review.userId, filmId: review.filmId, ...reviewFields },
      })
    }

    // 7. Summary.
    console.log('\n[seed] reviews')
    console.log(
      `  ${'id'.padEnd(16)}${'film'.padEnd(14)}${'status'.padEnd(10)}${'rated beats'}`
    )
    for (const review of REVIEWS) {
      const ratedBeats = review.beatRatings ? Object.keys(review.beatRatings).length : 0
      console.log(
        `  ${review.id.padEnd(16)}${review.filmId.padEnd(14)}${review.status.padEnd(10)}${ratedBeats}`
      )
    }

    console.log('\n[seed] log in with either account, using the password from SEED_USER_PASSWORD:')
    console.log(`  ${PRIMARY_EMAIL}`)
    console.log(`  ${SECONDARY_EMAIL}`)
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
