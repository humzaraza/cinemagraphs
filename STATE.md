# STATE

Snapshot of how the backend currently works. Plain English only — read the
files when you need exact behavior.

## Overview

Cinemagraphs is a Next.js web app that maps how audience sentiment shifts
across a film's runtime. For each film we pull reviews from several sources,
send the text to Claude with a target score derived from IMDb/RT/Metacritic,
and get back a series of time-bucketed sentiment data points plus a
per-film overall score. A cron loop keeps the pool fresh: new films are
imported from TMDB, anchor scores are refreshed, and reviews/graphs are
regenerated when the review set changes enough to matter.

The mobile app lives in a separate repo (`cinemagraphs-mobile`). This repo is
web-only.

## Database schema (plain English)

The Prisma schema revolves around films and the work done on them.

- **Film** is the root record — one per TMDB title. Holds TMDB/IMDb IDs,
  poster/backdrop, cast (JSON), genres, director, runtime, release date, and
  the cached aggregate scores (IMDb rating/votes, RT critics, RT audience,
  Metacritic). `lastReviewCount` is a cached integer used by the cron's cheap
  pre-filter to decide whether a film has enough new reviews to rerun. The
  `nowPlaying` boolean is managed by the import cron; `nowPlayingOverride`
  and `tickerOverride` let admins force-show or force-hide. `status` can hide
  or pend a film without deleting it.
- **SentimentGraph** is the per-film output of the Claude pipeline: the
  overall 1–10 score, the previous score (for ticker deltas), the anchor
  string, the data-point JSON (the curve), peak/lowest/biggest-swing, the
  summary, review count, sources used, a generation timestamp, a version
  counter, and a `reviewHash` used to skip re-analysis when the review set
  hasn't changed.
- **FilmBeats** is a separate "plain Wikipedia beats" payload used so users
  can rate the film even when there's no sentiment graph yet.
- **Review** is a single raw review fetched from an external source. It
  stores source platform (enum: TMDB, IMDB, REDDIT, CRITIC_BLOG, LETTERBOXD,
  GUARDIAN), URL, author, review text, optional source rating, and a
  `contentHash` used to dedupe on insert.
- **UserReview** is a site-native review (our own users rating a film with
  beginning/middle/ending sections, an overall rating, optional per-beat
  ratings, and an extracted sentiment score). Rows have a moderation status.
- **LiveReaction / LiveReactionSession** store watch-along reactions with
  timestamps inside the film. Tables exist and the API reads from them (see
  `audience-data`), but the UI that writes to them is currently disabled —
  see "Known gotchas."
- **User / Account / Session / VerificationToken / PasswordResetToken** are
  the NextAuth schema plus password/OTP tokens. Users have a role
  (USER/MODERATOR/ADMIN/BANNED), visibility flags, points, watchlist,
  lists/collections, and follows.
- **FeaturedFilm / Announcement / Feedback / SiteSettings** are admin-edited
  site chrome. `SiteSettings` doubles as a key/value JSON store — the
  analyze cron persists its pending-batch state there under
  `pending_sentiment_batch`.
- **Person / FilmPerson** store cast and crew in a normalized shape with a
  role enum, character name, and order — used by the person pages.
- **List / ListFilm / Collection / Watchlist / Follow** power the social
  side of the app.

## Sentiment pipeline (Wikipedia vs NLP beats, handoff logic)

There are **two** independent beat paths; they do not share data.

**NLP beats (SentimentGraph)** — the main pipeline. For a given film we:

1. Make sure we have an IMDb ID (look it up from TMDB if missing).
2. Pull fresh anchor scores from OMDB and patch any new values back onto
   the Film row.
3. Fetch reviews from every source (see below), dedupe on content hash,
   and store new ones.
4. Filter the stored reviews to English-looking ≥ 50-word entries. Films
   released within the last six months need ≥ 1 quality review; older
   films need ≥ 2. If the threshold isn't met we skip.
5. Compute a stable `reviewHash` over the filtered set. If it matches the
   hash stored on the existing SentimentGraph, bail out — nothing has
   changed. The admin "regenerate" paths pass `force: true` to bypass this.
6. Resolve a plot context with a fallback chain:
   Wikipedia plot → TMDB overview+tagline → OMDB plot field → stored
   synopsis → "reviews only" (no plot). Whichever wins becomes the
   `source` tag the model sees.
7. Build prompt parts — a stable cached system prompt plus a per-film user
   prompt that includes the anchor scores, plot section, segment count
   (14–18 based on runtime), and up to the 40 freshest reviews (ordered by
   `fetchedAt` desc, truncated to 1500 chars each).
8. Call Claude (`claude-sonnet-4-20250514`, 4000 max tokens) either
   synchronously (`analyzeSentiment`, retried once on bad JSON) or via the
   Message Batches API (`analyzeSentimentBatch`, used by the cron).
9. Parse the response, force trusted server-controlled fields
   (`sources`, `reviewCount`, `generatedAt`, `varianceSource`), and persist
   to SentimentGraph, rolling `overallScore` → `previousScore` and bumping
   `version`. Set `Film.lastReviewCount` to the new filtered count.

The system prompt requires every segment score in 1–10, the overall to land
within ±0.2 of the IMDb-derived target, conversational labels (no
screenwriting jargon), and a strict JSON-only response. The Batch API path
reuses the identical cached system prompt so the first request in a batch
writes the cache and the rest read it (5-minute TTL), on top of the Batch
API's own ~50% discount.

**Wikipedia beats (FilmBeats)** — a lighter, no-Claude path. Generated for
every newly imported film via `generateAndStoreWikiBeats` so users have
*something* to rate even before enough reviews exist for a sentiment graph.
It does not overwrite an existing SentimentGraph or FilmBeats row. The
frontend reads whichever beat payload is available.

**Handoff:** the two paths don't hand off to each other. A film can have
Wikipedia beats, a sentiment graph, or both. User reviews blend into
audience-level aggregates separately (see `review-blender`).

## Review fetching (sources, cadence, skip conditions)

`fetchAllReviews` runs six source fetchers in parallel via `Promise.allSettled`:

- **TMDB** — up to 3 pages of the `/movie/{id}/reviews` endpoint; skips
  reviews shorter than 50 chars.
- **IMDb** (via RapidAPI, host configurable) — user reviews sorted by
  helpfulness, up to 15, plus up to 10 Metacritic-sourced critic quotes as
  a bonus. 403 and 429 are surfaced explicitly in logs ("subscription
  required" / "quota exceeded") because both were previously silent.
- **Roger Ebert** (CRITIC_BLOG) — slugified title scrape of rogerebert.com,
  5 sec timeout, strips HTML down to article text. Commonly 403s; if every
  URL blocks and we got nothing, the source reports "403 blocked."
- **Letterboxd** — scrape of the reviews page. In practice Cloudflare
  blocks every server-side fetch; the fetcher detects the challenge page
  and returns `Cloudflare blocked`. Kept as a hook for future headless
  browser support.
- **Reddit** — official OAuth API first (needs `REDDIT_CLIENT_ID` +
  `REDDIT_CLIENT_SECRET`), falls back to Apify if `APIFY_API_TOKEN` is set.
  Searches r/movies, r/TrueFilm, r/flicks for `"{title} {year}"` and
  pulls top-level comments ≥ 100 chars from the first couple of threads.
  With no credentials configured, it reports "no credentials."
- **Guardian** — Open Platform search with an API key. Falls back to the
  shared `test` key when `GUARDIAN_API_KEY` isn't set; in that case the
  source is marked ✗ with reason "no API key" even if it returned rows, so
  the "you need to set this" signal stays visible.

Each source returns a `{ reviews, ok, reason }` shape. The end-of-run log
summarizes each source as ✓ or ✗ with a count or reason. New reviews are
deduped per-film on `contentHash` (sha-256 of the trimmed, lowercased text)
before insert.

**Cadence:** Reviews are only pulled as part of the sentiment pipeline —
`prepareSentimentGraphInput` and `fetchReviewsAndCheckThreshold` both call
`fetchAllReviews` as their first real step. There is no standalone
review-fetching cron.

**Skip conditions on the pipeline level:**

- Film not found → `skipped_film_not_found`.
- Fewer quality reviews than required (1 for <6-month-old, 2 otherwise) →
  `skipped_insufficient_reviews`.
- `reviewHash` matches the hash stored on the existing graph, unless
  `force` is true → `skipped_unchanged`.

Before any of that, the cron runs `filmNeedsReanalysis`: if a film has
never been analyzed it qualifies; otherwise it needs ≥ 10% growth in
filtered review count over `lastReviewCount` (rounded up, minimum of 1).
Legacy rows with `lastReviewCount = 0` requalify once they have ≥ 3
quality reviews.

## Cron jobs (what, when, why)

All three require a `Bearer ${CRON_SECRET}` auth header when `CRON_SECRET`
is set. Schedules are in `vercel.json`:

- **`/api/cron/import-new-films`** — daily at **02:00 UTC**.
  Fetches pages 1–3 of TMDB `now_playing` and pages 1–3 of `upcoming`.
  Refreshes the `nowPlaying` flag on films without an override (admin
  `force_show` / `force_hide` is always honored). Imports any TMDB IDs we
  don't already have, running each through the quality gates (votes,
  popularity, excluded genres, poster, runtime, overview). For each new
  film it syncs cast/crew via `syncFilmCredits`. Now-playing imports
  synchronously call `generateSentimentGraph`; every newly imported film
  also gets Wikipedia beats generated. Invalidates the homepage cache
  (and per-film caches on successful graph gen).
- **`/api/cron/refresh-scores`** — daily at **00:00 UTC**.
  For every `nowPlaying` film that already has a sentiment graph, pulls a
  fresh IMDb rating from OMDB (falls back to TMDB `vote_average`). If the
  rating actually moved, rolls the graph's `overallScore` into
  `previousScore` so the ticker delta reads correctly.
- **`/api/cron/analyze`** — weekly, **Mondays at 03:00 UTC**.
  The batch-driven sentiment-graph runner. On each invocation:
  1. Looks for a pending batch persisted in `SiteSettings`
     (`pending_sentiment_batch`). If one exists, polls Anthropic until it
     ends (or until the 280-second time budget is spent), processes
     results, clears state, and returns — never submits a new batch in
     the same run.
  2. Otherwise picks up to 50 candidate films ordered by oldest
     `sentimentGraph.generatedAt` then oldest `createdAt`, runs the cheap
     `filmNeedsReanalysis` filter until 10 queueable films are found.
  3. Runs `prepareSentimentGraphInput` on each (which fetches reviews,
     runs the hash/threshold skips, and builds prompt parts). Anything
     that survives is submitted as a single Batch API job.
  4. Persists `{ batchId, submittedAt, jobs[] }` to SiteSettings, then
     polls inline within the time budget. If the batch finishes, results
     are processed and state is cleared; otherwise state is left for the
     next run to pick up.
  Cost totals (input/output/cache tokens) are logged after each run
  using the Batch API price scale (half of the synchronous price).

## API routes (grouped by purpose)

**Films — public**
- `GET /api/films` — list with filters.
- `GET /api/films/[id]` — single film (cached, includes SentimentGraph and
  FilmBeats).
- `GET /api/films/[id]/graph` — just the SentimentGraph (cached).
- `GET /api/films/[id]/audience-data` — aggregated beat averages from
  approved UserReviews and — if there are 20+ quality LiveReactionSessions
  — a time-bucketed reaction score curve.
- `GET /api/films/[id]/reviews`, `POST /api/films/[id]/reviews` — list
  approved UserReviews + your own (any status); submit or edit your
  review. An auto-moderation path exists but is currently bypassed via the
  `AUTO_MODERATION_ENABLED = false` constant; edits and new reviews go
  straight to `approved`.
- `GET /api/films/[id]/watchlist`, etc. — watchlist mutations.
- `GET /api/films/[id]/reactions`, `GET /api/films/[id]/reaction-sessions`
  — live-reaction reads (see "Known gotchas").
- `GET /api/films/search`, `GET /api/films/tmdb-search` — search / TMDB
  lookup.
- `POST /api/films/submit` — user-submitted film request.

**Users / social**
- `GET /api/users/search`, `GET /api/users/[id]`,
  `GET /api/users/[id]/followers`, `GET /api/users/[id]/following`,
  `POST /api/users/[id]/follow` — user directory and follow graph.
- `GET /api/users/[id]/lists` — a user's public lists.
- `GET/POST/PATCH /api/user/profile`, `/api/user/settings`,
  `/api/user/avatar` — the current user's own records.
- `GET/POST /api/user/films`, `/api/user/watchlist`,
  `/api/user/lists`, `/api/user/lists/[id]`,
  `/api/user/lists/[id]/films`, `/api/user/lists/[id]/films/[filmId]`,
  `/api/user/lists/check/[filmId]` — the "add-to-list" / watchlist /
  custom-lists plumbing.
- `GET /api/lists/[id]` — public list view.
- `GET /api/reviews/[id]`, `GET /api/share/review/[reviewId]` — single
  review fetch / share page.

**Auth**
- `/api/auth/[...nextauth]` — NextAuth catch-all.
- `/api/auth/register`, `/api/auth/verify-otp`, `/api/auth/resend-otp`,
  `/api/auth/forgot-password`, `/api/auth/reset-password`,
  `/api/auth/change-password` — email/password and OTP flows.
- `/api/auth/mobile/{login,google,apple}` — mobile-app auth entry points.

**Admin**
- `/api/admin/films/[id]`, `/api/admin/films/import`,
  `/api/admin/films/bulk-import` — manual film management.
- `/api/admin/films/[id]/analyze`, `/api/admin/films/analyze-batch`,
  `/api/admin/films/generate-missing-graphs` — on-demand sentiment runs
  (can pass `force: true` to bypass the hash skip).
- `/api/admin/films/[id]/generate-wiki-beats`,
  `/api/admin/films/generate-wiki-beats` — on-demand Wikipedia beats.
- `/api/admin/films/backfill-reviews` — pull reviews without analyzing.
- `/api/admin/reviews`, `/api/admin/reviews/[id]` — UserReview moderation.
- `/api/admin/users`, `/api/admin/users/[id]` — user moderation.
- `/api/admin/feedback` — feedback inbox.
- `/api/admin/homepage` — FeaturedFilm ordering.

**Cron**
- `/api/cron/analyze`, `/api/cron/import-new-films`,
  `/api/cron/refresh-scores` — described above.

**Other**
- `/api/announcements`, `/api/announcements/[id]`,
  `/api/announcements/current` — site-wide banner.
- `/api/feedback` — user feedback submission.
- `/api/person/[slug]` — cast/crew pages.
- `/api/og/list` — Open Graph image for a list.

## Known gotchas

- **Live Reactions are built but disabled.** The LiveReaction and
  LiveReactionSession tables, the reaction-session API routes, and the
  `LiveReactionSection` component all exist, and `audience-data` will
  surface aggregates once a film has 20+ quality sessions. But the UI
  entry point is commented out in `FilmCommunityTabs.tsx` and in the
  profile page tabs (`// hidden — re-enable when ready`), so in practice
  no sessions are being created.
- **Auto-moderation is bypassed.** `AUTO_MODERATION_ENABLED = false` in
  `src/app/api/films/[id]/reviews/route.ts`. New reviews and edits all
  go live as `approved`. The `autoModerate` function and the
  force-flag-on-edit branch are kept intact for a single-line flip back.
- **Guardian "test" key fallback masks missing config.** If
  `GUARDIAN_API_KEY` isn't set, the fetcher still hits the API with key
  `test` and keeps the returned rows, but marks the source as failed
  ("no API key") in the summary. So the review store may be growing
  from Guardian even when logs say it's off.
- **Letterboxd is effectively offline.** Cloudflare blocks every
  server-side fetch; the fetcher always reports "Cloudflare blocked."
  The code path is kept for future headless-browser support.
- **IMDb source depends on RapidAPI subscription + quota.** 403 means the
  plan isn't subscribed, 429 means monthly quota is exhausted; both
  render zero IMDb reviews and are the most common reason the source
  shows ✗ in logs.
- **`reviewHash` skips legacy rows.** Reviews stored before `contentHash`
  existed don't contribute to the hash. They're ignored for change
  detection until they're re-stored with a hash. This is the safe
  behavior — it just means the hash match is technically over
  hash-bearing reviews only.
- **OMDB/TMDB anchor drift.** `prepareSentimentGraphInput` only writes
  back OMDB scores that are present in the OMDB response, and only
  overwrites `imdbRating` when the film's stored value is null. RT and
  Metacritic scores are always overwritten on fresh pull.
- **Admin "regenerate" must pass `force: true`.** Otherwise the hash
  skip will silently no-op once the review set hasn't moved.
- **Wikipedia plot matching is title-sensitive.** Tries
  `"{title} ({year} film)"`, `"{title} (film)"`, then `"{title}"`. Films
  with unusual titles, disambiguation needs, or missing Plot sections
  fall through to TMDB/OMDB/synopsis; the final fallback is reviews-only.
- **`analyze` cron is wall-clock sensitive.** A 280-second budget guards
  the 300-second route max. If prep runs long, it stops before
  submission; if polling runs long, state is persisted and the next
  cron tick resumes — new work is never queued in the same run as a
  resume.
- **UserReview sentiment extraction is best-effort.** `extractSentiment`
  runs on `combinedText` when any of beginning/middle/ending/other is
  filled. Users can still submit an overall rating without any text.
