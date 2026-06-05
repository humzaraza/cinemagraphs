-- AlterTable: SentimentGraph gains arc-shape tags + daily-hero no-repeat state.
-- Both additive and backfill-safe: arcShape defaults to an empty array, and
-- lastFeaturedAt is nullable (NULL = never featured). No data rewrite.
ALTER TABLE "SentimentGraph" ADD COLUMN     "arcShape" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "lastFeaturedAt" TIMESTAMP(3);
