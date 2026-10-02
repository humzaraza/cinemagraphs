-- The critic beats as generated, before any audience blend. The review
-- blender re-blends from this column every time instead of re-blending its
-- own previous output, which compounded toward the user averages.
ALTER TABLE "SentimentGraph" ADD COLUMN "criticDataPoints" JSONB;

-- Rows that have never been blended still hold the critic beats in
-- dataPoints, so seed the new column from them. Rows already blended keep
-- NULL and fall back to dataPoints until their next regeneration.
UPDATE "SentimentGraph"
SET "criticDataPoints" = "dataPoints"
WHERE "varianceSource" = 'external_only';
