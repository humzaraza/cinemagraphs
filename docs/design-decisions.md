# Cinemagraphs — Design Decisions

A running log of non-obvious design and architectural decisions made during development. Most recent first. Each entry explains context, problem, decision, any rejected alternatives, and impact, so future maintainers (including future-me) understand the reasoning without reading the chat transcript.

## 2026-04-19 — Guardian source accepts only tagged reviews, not news coverage

**Context.** The Guardian fetcher at src/lib/sources/guardian.ts initially had a fallback query that ran without the tone/reviews tag when the primary query returned zero results. This was intended to broaden coverage for films with sparse Guardian review presence.

**Problem.** The fallback admitted news articles (opinion pieces, festival previews, coverage of the director's other projects) that mention the film by name. Hybrid sentiment generation was treating these as audience reviews, producing distorted beat scores because news articles lack the scene-by-scene sentiment signal that actual reviews provide. Concrete case: Christopher Nolan's Oppenheimer was getting James Cameron's "moral cop-out" opinion piece, a festival premiere preview, and coverage of Nolan's next project The Odyssey — none of which are reviews of Oppenheimer the film.

**Decision.** Removed the fallback query. The Guardian fetcher now accepts only articles tagged tone/reviews. If a film has no Guardian reviews tagged as such, the fetcher returns zero, which is the honest signal.

**Rejected alternative.** URL pattern check (accept only URLs containing /film/ and -review slugs) to preserve more data. Rejected because Guardian's editorial system reliably applies the tone/reviews tag to actual reviews, and URL patterns can drift over time while tags are structural metadata. Tag-based filtering is more robust.

**Impact.** Some films lose Guardian coverage in their review set. Acceptable because hybrid sentiment generation is better served by fewer high-quality signals than by more noisy signals. Guardian is one of five review sources; the cost to data density is small, the benefit to signal quality is meaningful for any film Guardian has written non-review coverage about.

**Related commits.** The Guardian fix for this decision, and the earlier director-surname verification fix (commit 29e78cd) that surfaced this as a deeper issue.
