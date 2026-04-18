# SentimentGraph.dataPoints — write-path audit (3b pre-lock)

Audit-only inventory of every location in the repo that writes to `SentimentGraph.dataPoints`, in preparation for locking `label`, `timeStart`, `timeEnd`, and `timeMidpoint` once they are first set. Read end-to-end; no code was modified as part of this audit.

`SentimentDataPoint` shape (from `src/lib/types.ts:2-10`):

```
{ timeStart, timeEnd, timeMidpoint, score, label, confidence, reviewEvidence }
```

Any write listed below that hands a `dataPoints` array to Prisma writes the JSON column wholesale — Prisma does not field-merge JSON columns, so every element of every write includes every key present on the incoming object, whether or not that key was intentionally changed.

---

## Files covered

File list from the prompt, plus additional write paths surfaced by the greps in STEP 4:

Prompt-listed:
- `src/lib/sentiment-pipeline.ts`
- `src/lib/review-blender.ts`
- `src/app/api/cron/analyze/route.ts`
- `src/app/api/cron/refresh-scores/route.ts`
- `src/app/api/admin/films/[id]/route.ts`

Added by grep sweep:
- `scripts/batch-analyze.ts`
- `scripts/test-pipeline.ts`
- `scripts/backfill-wikipedia-beats.ts`

Greps also surfaced read-only call sites (e.g. `src/app/page.tsx`, `src/app/api/films/route.ts`, `src/app/api/share/review/[reviewId]/route.ts`, `src/app/admin/page.tsx` `.count()`). Those are read/aggregate queries, not writes, and are out of scope.

---

## Path 1 — `storeSentimentGraphResult` (UPDATE branch)

- **File / line:** `src/lib/sentiment-pipeline.ts:384` (`prisma.sentimentGraph.update`)
- **Trigger:** Called by `generateSentimentGraph` in the same file (admin "Analyze / Regenerate" buttons via `generateBatchSentimentGraphs`, ad-hoc scripts) AND by `processBatchResults` in `src/app/api/cron/analyze/route.ts:137` (cron batch results handler after the Anthropic Batch API ends).
- **dataPoint fields written:** Whatever the Claude analysis produced. The code writes `graphData.dataPoints as any` (line 391). `graphData` conforms to `SentimentGraphData` (see `src/lib/types.ts:56`), whose element type is `SentimentDataPoint`, so the payload per element is:
  - `timeStart`
  - `timeEnd`
  - `timeMidpoint`
  - `score`
  - `label`
  - `confidence`
  - `reviewEvidence`
- **Writes `label`?** Yes.
- **Writes `timeStart` / `timeEnd` / `timeMidpoint`?** Yes (all three).
- **Writes `score`?** Yes.
- **Writes `confidence`?** Yes.
- **Writes `reviewEvidence`?** Yes.
- **Any other dataPoint fields?** Not on the dataPoint object. Sibling columns on the row that this same statement also writes: `previousScore`, `overallScore`, `anchoredFrom`, `peakMoment`, `lowestMoment`, `biggestSwing`, `summary`, `reviewCount`, `sourcesUsed`, `generatedAt`, `version`, `reviewHash`.
- **Inside a `$transaction`?** No. `storeSentimentGraphResult` issues two sequential awaited calls (the graph update at line 384 and the `prisma.film.update` at line 433) without any `$transaction` wrapper.
- **Can race with another write path?** Yes — it is the single biggest race target in the system. Details in the Race scenarios section below.

## Path 2 — `storeSentimentGraphResult` (CREATE branch)

- **File / line:** `src/lib/sentiment-pipeline.ts:410` (`prisma.sentimentGraph.create`)
- **Trigger:** Same as Path 1 — but only fires when `findUnique({ where: { filmId } })` at line 381 returns `null`, i.e. the very first analysis for a given film.
- **dataPoint fields written:** Same as Path 1 (Claude output, full `SentimentDataPoint` shape):
  - `timeStart`, `timeEnd`, `timeMidpoint`, `score`, `label`, `confidence`, `reviewEvidence`.
- **Writes `label`?** Yes.
- **Writes `timeStart` / `timeEnd` / `timeMidpoint`?** Yes.
- **Writes `score`?** Yes.
- **Writes `confidence`?** Yes.
- **Writes `reviewEvidence`?** Yes.
- **Any other dataPoint fields?** No. Sibling row columns written: `filmId`, `overallScore`, `anchoredFrom`, `peakMoment`, `lowestMoment`, `biggestSwing`, `summary`, `reviewCount`, `sourcesUsed`, `generatedAt`, `reviewHash`.
- **Inside a `$transaction`?** No.
- **Can race with another write path?** Yes — specifically the find-unique/create pair at lines 381+410 is a classic check-then-act race. Two concurrent invocations for the same filmId (e.g. two cron ticks, or admin Analyze + cron) can both see `existing === null` and both call `.create`, one of which will fail on the unique `filmId` constraint. Detail in Race scenarios below.

## Path 3 — `maybeBlendAndUpdate` (the critical path for beat locking)

- **File / line:** `src/lib/review-blender.ts:121` (`prisma.sentimentGraph.update`)
- **Trigger:** Called after user-review approval or live-reaction submission. Fires whenever either (a) ≥5 approved non-null-sentiment user reviews exist OR (b) ≥20 live reactions from quality sessions exist. However, the actual DB write at line 121 is nested **inside `if (hasEnoughReviews)`** (line 70) — so today it only writes when the user-review threshold is met; a reactions-only trigger currently does not write anything.
- **dataPoint fields written:** The code computes `blendedPoints` like this (paraphrased from lines 65-113):

  ```
  const dataPoints = graph.dataPoints as unknown as SentimentDataPoint[]
  let blendedPoints = dataPoints.map((dp) => ({ ...dp }))   // spread → full object copy
  …
  blendedPoints = blendedPoints.map((dp) => {
    const avg = beatAverages[dp.label]
    if (avg && avg.count > 0) {
      dp.score = dp.score * weights.external + userAvg * weights.userReviews
      …
    }
    return dp
  })
  …
  blendedPoints = blendedPoints.map((dp, i) => {
    if (buckets[i] !== undefined) dp.score = dp.score + buckets[i] * weights.liveReactions
    return dp
  })
  ```

  Because `blendedPoints` is built from `{ ...dp }` spreads of the existing graph's dataPoints, every element of the array written at line 126 carries the full `SentimentDataPoint` shape:
  - `timeStart`, `timeEnd`, `timeMidpoint`, `label`, `confidence`, `reviewEvidence` — **copied verbatim** from the existing row (not mutated, but written).
  - `score` — **mutated** by the blend math, then written.
- **Writes `label`?** **YES.** The label string is copied through the spread and serialized back into the JSON column. It is not intentionally modified, but it IS in the payload, so a concurrent writer's label change can be clobbered. This is the single most important finding of this audit.
- **Writes `timeStart` / `timeEnd` / `timeMidpoint`?** Yes — same mechanism. Copied through the spread, written back.
- **Writes `score`?** Yes — mutated by the blend math.
- **Writes `confidence`?** Yes — spread-through, not mutated.
- **Writes `reviewEvidence`?** Yes — spread-through, not mutated.
- **Any other dataPoint fields?** No fields beyond the `SentimentDataPoint` shape. Sibling row columns written in the same `.update`: `previousScore`, `overallScore`, `varianceSource: 'blended'`.
- **Inside a `$transaction`?** No. The read at line 32 (`findUnique`) and the update at line 121 are separate awaited calls with no transaction.
- **Can race with another write path?** Yes — and this is where the label/timestamp lock matters most. A cron-triggered `storeSentimentGraphResult` landing between the `findUnique` at line 32 and the `update` at line 121 would have its new labels overwritten with the stale labels this path just read. Detail in Race scenarios.

## Path 4 — `refresh-scores` cron

- **File / line:** `src/app/api/cron/refresh-scores/route.ts:82` (`prisma.sentimentGraph.update`)
- **Trigger:** Daily cron for `nowPlaying` films whose `imdbRating` has drifted on OMDB/TMDB by >0.01.
- **dataPoint fields written:** **None.** The `data` payload at lines 84-85 is `{ previousScore: film.sentimentGraph.overallScore }` — it touches only the `previousScore` column and never references `dataPoints`. Listed here for completeness since it writes the `sentimentGraph` row, but it is not a `dataPoints` write path.
- **Writes `label`?** No.
- **Writes `timeStart` / `timeEnd` / `timeMidpoint`?** No.
- **Writes `score`?** No. (It writes `previousScore` on the row, not the per-dataPoint `score`.)
- **Writes `confidence`?** No.
- **Writes `reviewEvidence`?** No.
- **Any other dataPoint fields?** No — payload contains only `previousScore`.
- **Inside a `$transaction`?** No. Two separate awaited statements (`prisma.film.update` then `prisma.sentimentGraph.update`), no transaction.
- **Can race with another write path?** Yes — a parallel `storeSentimentGraphResult` or `maybeBlendAndUpdate` could re-set `previousScore` to a different value within the same second. But since this path does not touch `dataPoints`, it is not a concern for the label-lock work.

## Path 5 — admin film DELETE

- **File / line:** `src/app/api/admin/films/[id]/route.ts:72` (`prisma.sentimentGraph.deleteMany`)
- **Trigger:** `DELETE /api/admin/films/[id]` — an admin removing a film record.
- **dataPoint fields written:** **None** — this is a row delete, not a write.
- **Writes `label`?** No.
- **Writes `timeStart` / `timeEnd` / `timeMidpoint`?** No.
- **Writes `score`?** No.
- **Writes `confidence`?** No.
- **Writes `reviewEvidence`?** No.
- **Any other dataPoint fields?** N/A — deletion.
- **Inside a `$transaction`?** No. Lines 71-74 are four sequential `deleteMany`/`delete` calls with no transaction.
- **Can race with another write path?** Yes — a delete fired while cron/analyze or a review-blender update is mid-flight can leave the cron write throwing on a missing FK or race with the sentiment row's absence. Not a `dataPoints` mutation concern, but worth noting alongside Path 4.

## Path 6 — `scripts/batch-analyze.ts` (UPDATE branch)

- **File / line:** `scripts/batch-analyze.ts:179` (`prisma.sentimentGraph.update`)
- **Trigger:** Manual `node`/`tsx` invocation of the batch-analyze script (not wired to any route or cron).
- **dataPoint fields written:** `graphData.dataPoints` as returned by Claude. The prompt (lines 151-152) requests the full `SentimentDataPoint` shape: `timeStart`, `timeEnd`, `timeMidpoint`, `score`, `label`, `confidence`, `reviewEvidence`.
- **Writes `label`?** Yes.
- **Writes `timeStart` / `timeEnd` / `timeMidpoint`?** Yes.
- **Writes `score`?** Yes.
- **Writes `confidence`?** Yes.
- **Writes `reviewEvidence`?** Yes.
- **Any other dataPoint fields?** No. Sibling row columns written via `graphPayload` spread (lines 164-176, 179): `overallScore`, `anchoredFrom`, `peakMoment`, `lowestMoment`, `biggestSwing`, `summary`, `reviewCount`, `sourcesUsed`, `generatedAt`, `version`.
- **Inside a `$transaction`?** No.
- **Can race with another write path?** In principle yes (a production operator running the script against the live DB while cron is active). In practice the script is an operator tool — race exposure depends on when someone runs it.

## Path 7 — `scripts/batch-analyze.ts` (CREATE branch)

- **File / line:** `scripts/batch-analyze.ts:181` (`prisma.sentimentGraph.create`)
- **Trigger:** Same as Path 6, taken when `existing` (the `findUnique` at line 164) is `null`.
- **dataPoint fields written:** Same as Path 6: `timeStart`, `timeEnd`, `timeMidpoint`, `score`, `label`, `confidence`, `reviewEvidence`.
- **Writes `label`?** Yes.
- **Writes `timeStart` / `timeEnd` / `timeMidpoint`?** Yes.
- **Writes `score`?** Yes.
- **Writes `confidence`?** Yes.
- **Writes `reviewEvidence`?** Yes.
- **Any other dataPoint fields?** No. Sibling row columns: same list as Path 6 minus `version` (newly created row).
- **Inside a `$transaction`?** No.
- **Can race with another write path?** Same find-unique/create pattern as Path 2; concurrent invocations can both see `existing === null`.

## Path 8 — `scripts/test-pipeline.ts` (UPDATE branch)

- **File / line:** `scripts/test-pipeline.ts:231` (`prisma.sentimentGraph.update`)
- **Trigger:** Manual `node`/`tsx` invocation of the Oppenheimer-specific pipeline smoke test.
- **dataPoint fields written:** `graphData.dataPoints` from Claude. Prompt at line 174 requests the full `SentimentDataPoint` shape: `timeStart`, `timeEnd`, `timeMidpoint`, `score`, `label`, `confidence`, `reviewEvidence`.
- **Writes `label`?** Yes.
- **Writes `timeStart` / `timeEnd` / `timeMidpoint`?** Yes.
- **Writes `score`?** Yes.
- **Writes `confidence`?** Yes.
- **Writes `reviewEvidence`?** Yes.
- **Any other dataPoint fields?** No. Sibling row columns (lines 233-245): `overallScore`, `anchoredFrom`, `peakMoment`, `lowestMoment`, `biggestSwing`, `summary`, `reviewCount`, `sourcesUsed`, `generatedAt`, `version`.
- **Inside a `$transaction`?** No.
- **Can race with another write path?** In principle yes (operator runs against live DB during cron). Practically rare.

## Path 9 — `scripts/test-pipeline.ts` (CREATE branch)

- **File / line:** `scripts/test-pipeline.ts:248` (`prisma.sentimentGraph.create`)
- **Trigger:** Same as Path 8, taken when `existingGraph` is `null` at line 229.
- **dataPoint fields written:** Same as Path 8.
- **Writes `label`?** Yes.
- **Writes `timeStart` / `timeEnd` / `timeMidpoint`?** Yes.
- **Writes `score`?** Yes.
- **Writes `confidence`?** Yes.
- **Writes `reviewEvidence`?** Yes.
- **Any other dataPoint fields?** No. Sibling columns same as Path 8 minus `version`.
- **Inside a `$transaction`?** No.
- **Can race with another write path?** Same find-unique/create exposure as Paths 2 and 7.

## Path 10 — `scripts/backfill-wikipedia-beats.ts`

- **File / line:** `scripts/backfill-wikipedia-beats.ts:278` (`prisma.sentimentGraph.update`)
- **Trigger:** Manual `node`/`tsx` invocation of the Wikipedia-plot-context backfill script. Intentionally regenerates beats from plot context with proper nouns.
- **dataPoint fields written:** `graphData.dataPoints` from Claude. Prompt at lines 216-225 requests the full `SentimentDataPoint` shape: `timeStart`, `timeEnd`, `timeMidpoint`, `score`, `label`, `confidence`, `reviewEvidence`.
- **Writes `label`?** Yes — **and this is the one script whose whole purpose is to rewrite labels** ("Regenerating beats + scores using plot context" per line 312).
- **Writes `timeStart` / `timeEnd` / `timeMidpoint`?** Yes.
- **Writes `score`?** Yes.
- **Writes `confidence`?** Yes.
- **Writes `reviewEvidence`?** Yes.
- **Any other dataPoint fields?** No. Sibling row columns (lines 280-290): `previousScore`, `overallScore`, `peakMoment`, `lowestMoment`, `biggestSwing`, `summary`, `generatedAt`, `version`.
- **Inside a `$transaction`?** No.
- **Can race with another write path?** Yes (operator runs against live DB during cron / review-blender). This script is the one intentional label-rewriter in the codebase; once a beat-lock lands, this script will either need an explicit unlock path or will have to be retired.

---

## Race scenarios

None of the write paths above use row-level locking, optimistic concurrency via `where: { version: x }`, `SELECT … FOR UPDATE`, or a `$transaction` wrapping the read-and-write together. Every single pair below is therefore a real race with no mitigation in the current code. `version: existing.version + 1` is computed in application code from a stale read and is not enforced as a compare-and-swap — two concurrent writers can both read version N, both write N+1, and the last writer wins.

| # | Write path A | Write path B | Same row? | Current code handles race? |
|---|---|---|---|---|
| 1 | Path 3 `maybeBlendAndUpdate` (review-blender.ts:121) | Path 1 `storeSentimentGraphResult` UPDATE (sentiment-pipeline.ts:384) — fired from cron/analyze | Yes (same `filmId`) | **No.** Classic read-modify-write race. Blender reads at line 32, cron lands a new graph (new labels) between then and line 121, blender writes back the stale labels it read. Result: cron's new labels are silently reverted. |
| 2 | Path 3 `maybeBlendAndUpdate` | Path 1 `storeSentimentGraphResult` UPDATE fired from admin Analyze button (`generateSentimentGraph`) | Yes | **No.** Same mechanism as #1. An admin Regenerate that lands mid-blend has its new beats overwritten. |
| 3 | Path 1 cron/analyze | Path 1 admin Analyze button (both call `storeSentimentGraphResult`) | Yes | **No.** Two concurrent `.update`s on the same row. Last write wins; `version` column is advisory, not enforced. |
| 4 | Path 2 create (first-ever analysis) | Path 2 create fired concurrently (cron + admin both seeing no row) | Yes | **Partially** — the DB's unique constraint on `filmId` will reject the second `.create`, but the failure surfaces as an exception the caller must handle. `storeSentimentGraphResult` does not catch it; the caller (`processBatchResults` at cron/analyze/route.ts:141) catches any throw and records a "failed" summary entry. No retry to convert the create into an update. |
| 5 | Path 3 `maybeBlendAndUpdate` fired twice for the same film (two reviews approved nearly simultaneously) | (same) | Yes | **No.** Two blends read the same pre-blend state, both write a blend of the same original. Net effect: one blend is lost. Not catastrophic for scores (blends are approximately idempotent over a single review batch) but still not handled. |
| 6 | Path 4 refresh-scores (previousScore only) | Path 1/3 storeSentimentGraphResult or blender | Yes | **No.** Path 4 does not touch dataPoints, so this race does not affect the beat-lock work. It can, however, overwrite `previousScore` with a stale value. |
| 7 | Path 5 admin DELETE | Path 1 cron/analyze mid-flight | Yes (row deleted under cron) | **No.** The cron's `processBatchResults` re-reads the film via `prisma.film.findUnique` (cron/analyze/route.ts:110) but does not re-check the sentimentGraph. If the row is deleted between batch submit and result, the `storeSentimentGraphResult` UPDATE branch will still run its `findUnique` at line 381 and fall through to `.create` — surviving the race, but the graph reappears after a user deletion, which is a separate bug not in scope here. |
| 8 | Path 10 backfill-wikipedia-beats (operator script) | Path 3 `maybeBlendAndUpdate` (user approved a review) | Yes | **No.** Backfill reads the existing graph outside a transaction; blender reads separately; whichever updates last wins. If backfill is the second writer, its freshly generated plot-specific labels stick; if blender is second, it writes back the pre-backfill labels it read seconds earlier, and the backfill is silently reverted. |
| 9 | Path 6/7 batch-analyze (operator script) | Path 1 cron/analyze | Yes | **No.** Same class of race as Paths 3↔1. |
| 10 | Path 8/9 test-pipeline (Oppenheimer-targeted) | Path 1 cron/analyze happening to pick Oppenheimer in the same cycle | Yes | **No.** Practically rare, but structurally identical. |

Across every pair, the mechanism is the same: read-outside-transaction followed by a whole-JSON-column overwrite. The label-lock plan has to contend with all of these; a write-side guard that ignores label/timestamp changes when the row already has them set would defuse races 1–2 and 8 (the ones that actually affect labels).

---

## Findings summary

### Paths that currently write `label` or timestamp fields

All nine of these write the full `SentimentDataPoint` object (including `label`, `timeStart`, `timeEnd`, `timeMidpoint`):

- `src/lib/sentiment-pipeline.ts:384` — `storeSentimentGraphResult` UPDATE branch (cron/analyze, admin Analyze, `generateSentimentGraph` callers)
- `src/lib/sentiment-pipeline.ts:410` — `storeSentimentGraphResult` CREATE branch (first-ever analysis)
- `src/lib/review-blender.ts:121` — `maybeBlendAndUpdate` (**this is the critical finding — the blender writes `label` back even though it does not intentionally modify it, because `blendedPoints` is built from `{ ...dp }` spreads of the existing dataPoints and the whole array is serialized into the JSON column**)
- `scripts/batch-analyze.ts:179` — operator batch-analyze UPDATE branch
- `scripts/batch-analyze.ts:181` — operator batch-analyze CREATE branch
- `scripts/test-pipeline.ts:231` — Oppenheimer pipeline smoke test UPDATE branch
- `scripts/test-pipeline.ts:248` — Oppenheimer pipeline smoke test CREATE branch
- `scripts/backfill-wikipedia-beats.ts:278` — Wikipedia-plot-context backfill (intentionally rewrites labels with proper nouns — will need an explicit unlock path or retirement once the lock lands)

### Paths that only write `score`/`confidence`/`reviewEvidence` today

None. No write path in the codebase writes a narrowly scoped dataPoints payload. Every `dataPoints` write is full-object. The blender is the only path that *intends* to mutate only `score`, but it does so by re-serializing the whole dataPoint array including `label`, `timeStart`, `timeEnd`, `timeMidpoint`, `confidence`, and `reviewEvidence`.

### Paths that are inside transactions vs. not

- **In transaction:** None. Every write path listed above runs its read and its write as separate awaited statements with no `$transaction` wrapper.
- **Not in transaction:**
  - `src/lib/sentiment-pipeline.ts:384` (UPDATE)
  - `src/lib/sentiment-pipeline.ts:410` (CREATE)
  - `src/lib/review-blender.ts:121` (UPDATE)
  - `src/app/api/cron/refresh-scores/route.ts:82` (UPDATE of `previousScore` only — does not touch dataPoints)
  - `src/app/api/admin/films/[id]/route.ts:72` (deleteMany — not a dataPoints write)
  - `scripts/batch-analyze.ts:179` (UPDATE)
  - `scripts/batch-analyze.ts:181` (CREATE)
  - `scripts/test-pipeline.ts:231` (UPDATE)
  - `scripts/test-pipeline.ts:248` (CREATE)
  - `scripts/backfill-wikipedia-beats.ts:278` (UPDATE)
