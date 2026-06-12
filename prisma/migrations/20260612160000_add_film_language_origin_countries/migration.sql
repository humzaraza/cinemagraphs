-- AlterTable: Film gains TMDB language/origin metadata. Both additive and
-- backfill-safe: originalLanguage is nullable (NULL = not yet fetched) and
-- originCountries defaults to an empty array. No data rewrite.
ALTER TABLE "Film" ADD COLUMN     "originalLanguage" TEXT,
ADD COLUMN     "originCountries" TEXT[] DEFAULT ARRAY[]::TEXT[];
