-- Add AI-original slot selections column for the per-slot beat-override
-- reset path. The reset endpoint copies aiSlotSelectionsJson[slideNum] back
-- into slotSelectionsJson[slideNum] when admin wants the algorithm's pick.
ALTER TABLE "CarouselDraft" ADD COLUMN "aiSlotSelectionsJson" JSONB;

-- Backfill: give existing drafts a reset baseline equal to their current
-- slot selections. Without this, the reset endpoint on a pre-migration row
-- would have nothing to restore.
UPDATE "CarouselDraft" SET "aiSlotSelectionsJson" = "slotSelectionsJson" WHERE "aiSlotSelectionsJson" IS NULL;
