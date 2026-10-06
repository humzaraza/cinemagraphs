-- TMDB ratings were stored halved (0 to 5). Restore the true 0 to 10 scale.
-- Guard: refuse to run if the data is already on the 0 to 10 scale.
DO $$
BEGIN
  IF (SELECT max("sourceRating") FROM "Review" WHERE "sourcePlatform" = 'TMDB') > 5 THEN
    RAISE EXCEPTION 'TMDB sourceRating already exceeds 5; refusing to double again';
  END IF;
END $$;

UPDATE "Review"
SET "sourceRating" = "sourceRating" * 2
WHERE "sourcePlatform" = 'TMDB'
  AND "sourceRating" IS NOT NULL;
