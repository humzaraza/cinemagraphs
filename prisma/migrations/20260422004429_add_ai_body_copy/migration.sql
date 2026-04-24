-- Add AI-original body copy column for revert, and cached backdrop URL so
-- PATCH/revert renders don't re-hit TMDB.
ALTER TABLE "CarouselDraft" ADD COLUMN "aiBodyCopyJson" JSONB;
ALTER TABLE "CarouselDraft" ADD COLUMN "backdropUrl" TEXT;

-- Backfill: give existing drafts a revert baseline equal to their current
-- body copy. Without this, reverting on a pre-migration row would throw.
UPDATE "CarouselDraft" SET "aiBodyCopyJson" = "bodyCopyJson" WHERE "aiBodyCopyJson" IS NULL;
