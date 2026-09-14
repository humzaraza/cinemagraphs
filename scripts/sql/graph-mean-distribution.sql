-- Distribution of |mean(dataPoints[].score) - overallScore| across every
-- SentimentGraph row. Read-only. Paste into the Neon console against the
-- branch you intend to inspect (the production host contains `plain-shadow`).
--
-- over_tolerance is the count the step 4 backfill drives toward zero. The
-- comparison is the same 0.2 the app guard uses (MEAN_SCORE_TOLERANCE in
-- src/lib/claude.ts). Nothing here is rounded; gaps print as raw doubles.

WITH scored AS (
  SELECT
    sg."filmId",
    sg."overallScore",
    (
      SELECT avg((p->>'score')::double precision)
      FROM jsonb_array_elements(sg."dataPoints") AS p
    ) AS mean_score
  FROM "SentimentGraph" sg
),
gaps AS (
  SELECT
    "filmId",
    "overallScore",
    mean_score,
    abs(mean_score - "overallScore") AS gap
  FROM scored
  WHERE mean_score IS NOT NULL
)
SELECT
  count(*)                                              AS graphs,
  min(gap)                                              AS smallest,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY gap)      AS median,
  percentile_cont(0.9) WITHIN GROUP (ORDER BY gap)      AS p90,
  max(gap)                                              AS largest,
  count(*) FILTER (WHERE gap > 0.2)                     AS over_tolerance,
  count(*) FILTER (WHERE gap > 0.5)                     AS over_half,
  count(*) FILTER (WHERE gap > 1.0)                     AS over_one
FROM gaps;

-- Per-film rows over tolerance, largest gap first. The first block of rows
-- (gap > 1.0) is the tier the backfill runs first.
WITH scored AS (
  SELECT
    sg."filmId",
    sg."overallScore",
    (
      SELECT avg((p->>'score')::double precision)
      FROM jsonb_array_elements(sg."dataPoints") AS p
    ) AS mean_score
  FROM "SentimentGraph" sg
)
SELECT
  f.id                                   AS film_id,
  f.title,
  f.runtime,
  s."overallScore"                       AS overall_score,
  s.mean_score,
  abs(s.mean_score - s."overallScore")   AS gap
FROM scored s
JOIN "Film" f ON f.id = s."filmId"
WHERE s.mean_score IS NOT NULL
  AND abs(s.mean_score - s."overallScore") > 0.2
ORDER BY gap DESC, f.title;
