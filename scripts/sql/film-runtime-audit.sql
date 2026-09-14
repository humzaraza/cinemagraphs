-- Step 2 / step 3 SQL for the runtime integrity fix. Paste each block into the
-- Neon console on its own. Confirm the host first (production contains
-- `plain-shadow`); every block below is written against the Prisma schema in
-- prisma/schema.prisma, where Film.runtime is a nullable Int that is stored as
-- 0 (not NULL) for most missing values, hence `runtime IS NULL OR runtime <= 0`.

-- ── STEP 2a: audit (read-only) ───────────────────────────────────────────────
-- Every Film row with a missing or non-positive runtime. Expected 56 rows.
-- has_graph = true rows are the step 3 candidates (expected 13).
-- Export this result (CSV or JSON) and feed it to scripts/tmdb-runtime-sql.ts,
-- which looks each tmdbId up on TMDB and prints the STEP 2b statement filled in.
SELECT
  f.id,
  f."tmdbId",
  f.title,
  f."releaseDate"::date                                   AS release_date,
  f.runtime,
  f.status,
  (sg.id IS NOT NULL)                                     AS has_graph,
  (f."releaseDate" IS NULL OR f."releaseDate" > now())    AS unreleased_by_release_date
FROM "Film" f
LEFT JOIN "SentimentGraph" sg ON sg."filmId" = f.id
WHERE f.runtime IS NULL OR f.runtime <= 0
ORDER BY has_graph DESC, f."releaseDate" NULLS FIRST, f.title;

-- ── STEP 2b: apply (write) ───────────────────────────────────────────────────
-- Replace the placeholder VALUES row with the (tmdbId, runtime) pairs printed
-- by scripts/tmdb-runtime-sql.ts. Guards: only rows still at NULL/<=0 are
-- touched and only positive values are written, so a stale or duplicated paste
-- can never overwrite a good runtime. RETURNING shows exactly what changed.
UPDATE "Film" AS f
SET runtime     = v.runtime,
    "updatedAt" = now()
FROM (VALUES
  (0, 0)   -- placeholder; replace with (tmdbId, runtime) pairs
) AS v("tmdbId", runtime)
WHERE f."tmdbId" = v."tmdbId"
  AND (f.runtime IS NULL OR f.runtime <= 0)
  AND v.runtime > 0
RETURNING f."tmdbId", f.title, f.runtime;

-- ── STEP 2c: verify (read-only) ──────────────────────────────────────────────
-- What is left should be exactly the unreleased list from the helper script.
SELECT
  f."tmdbId",
  f.title,
  f."releaseDate"::date                                   AS release_date,
  f.runtime,
  (f."releaseDate" IS NULL OR f."releaseDate" > now())    AS unreleased_by_release_date
FROM "Film" f
WHERE f.runtime IS NULL OR f.runtime <= 0
ORDER BY f."releaseDate" NULLS FIRST, f.title;

-- ── STEP 3: listing only (read-only; deletion waits for approval) ────────────
-- Sentiment graphs attached to films that still have no runtime after 2b.
SELECT
  f.id                        AS film_id,
  f."tmdbId",
  f.title,
  f."releaseDate"::date       AS release_date,
  f.status,
  sg.id                       AS graph_id,
  sg."generatedAt",
  sg."reviewCount",
  sg.version
FROM "SentimentGraph" sg
JOIN "Film" f ON f.id = sg."filmId"
WHERE f.runtime IS NULL OR f.runtime <= 0
ORDER BY f."releaseDate" NULLS FIRST, f.title;
