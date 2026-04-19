# Cinemagraphs — Design Decisions

A running log of non-obvious design and architectural decisions made during development. Most recent first. Each entry explains context, problem, decision, any rejected alternatives, and impact, so future maintainers (including future-me) understand the reasoning without reading the chat transcript.

## 2026-04-19 — Cron skip logic uses cached review count

**Context.** The daily sentiment regeneration cron (src/app/api/cron/analyze/route.ts) added a maturity-based skip rule: a film skips regeneration on a given run if it was released 180+ days ago, has 17+ quality reviews, and was regenerated within the last 30 days. The decision function lives in src/lib/cron-skip-logic.ts and takes a `qualityReviewCount` parameter.

**Problem.** What should "quality review count" be at decision time — the live count (re-filtered from Review rows via `isQualityReview` on every cron run), or a cached snapshot? The cron evaluates a pool of ~200 candidate films per run; computing a live count would mean loading every candidate's Review rows from the DB, running the `isQualityReview` regex on each, and counting matches. That's a per-film DB read and CPU pass that scales with the candidate pool.

**Decision.** Use `Film.lastReviewCount` as the count — a snapshot written by `storeSentimentGraphResult` at each regeneration. It reflects the filtered count as of the last graph write, not a live count. The cron passes it directly into `decideCronRegen`.

**Why this is safe.** Staleness is bounded by the 30-day stale-regen rule. If a film's true review count shifts above or below the 17-review threshold between regenerations, the skip decision relies on the stale value only until the next regen — at most 30 days away, since the stale-regen eligibility branch forces regeneration once `generatedAt <= now - 30d`. A film crossing the threshold may therefore be skipped (or eligible) for one extra cycle relative to ground truth, but it cannot be stuck on the stale value indefinitely.

**Rejected alternative.** Count quality reviews at decision time via `isQualityReview` across every candidate's Review rows. Rejected because the cost scales with candidate pool size (200 films × all their reviews, once per day), and the accuracy gain is bounded to a single cycle of lag at the threshold boundary. The optimization isn't worth the read load for a skip heuristic whose whole purpose is to reduce work.

**Impact.** The skip decision can disagree with a live count only for films that crossed the 17-review boundary between regens, and the disagreement self-resolves at the next regeneration (≤30d). The field comment on `CronRegenInput.qualityReviewCount` documents the staleness contract and the live-count alternative path for future maintainers who might need stricter semantics.

**Related commits.** The cron skip logic was introduced in commit 53b74a2; this documentation entry was added in the follow-up commit.

## 2026-04-19 — Guardian source accepts only tagged reviews, not news coverage

**Context.** The Guardian fetcher at src/lib/sources/guardian.ts initially had a fallback query that ran without the tone/reviews tag when the primary query returned zero results. This was intended to broaden coverage for films with sparse Guardian review presence.

**Problem.** The fallback admitted news articles (opinion pieces, festival previews, coverage of the director's other projects) that mention the film by name. Hybrid sentiment generation was treating these as audience reviews, producing distorted beat scores because news articles lack the scene-by-scene sentiment signal that actual reviews provide. Concrete case: Christopher Nolan's Oppenheimer was getting James Cameron's "moral cop-out" opinion piece, a festival premiere preview, and coverage of Nolan's next project The Odyssey — none of which are reviews of Oppenheimer the film.

**Decision.** Removed the fallback query. The Guardian fetcher now accepts only articles tagged tone/reviews. If a film has no Guardian reviews tagged as such, the fetcher returns zero, which is the honest signal.

**Rejected alternative.** URL pattern check (accept only URLs containing /film/ and -review slugs) to preserve more data. Rejected because Guardian's editorial system reliably applies the tone/reviews tag to actual reviews, and URL patterns can drift over time while tags are structural metadata. Tag-based filtering is more robust.

**Impact.** Some films lose Guardian coverage in their review set. Acceptable because hybrid sentiment generation is better served by fewer high-quality signals than by more noisy signals. Guardian is one of five review sources; the cost to data density is small, the benefit to signal quality is meaningful for any film Guardian has written non-review coverage about.

**Related commits.** The Guardian fix for this decision, and the earlier director-surname verification fix (commit 29e78cd) that surfaced this as a deeper issue.
