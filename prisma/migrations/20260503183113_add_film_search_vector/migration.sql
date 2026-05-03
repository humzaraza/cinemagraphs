-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- AlterTable
ALTER TABLE "Film" ADD COLUMN     "searchVector" tsvector;

-- CreateIndex
CREATE INDEX "Film_searchVector_idx" ON "Film" USING GIN ("searchVector");

-- Trigger to keep searchVector in sync with title, director, synopsis.
-- Weights: A = title (strongest), B = director, C = synopsis (weakest).
CREATE OR REPLACE FUNCTION film_search_vector_update() RETURNS trigger AS $$
BEGIN
  NEW."searchVector" :=
    setweight(to_tsvector('english', coalesce(NEW.title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(NEW.director, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(NEW.synopsis, '')), 'C');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER film_search_vector_trigger
  BEFORE INSERT OR UPDATE OF title, director, synopsis
  ON "Film"
  FOR EACH ROW
  EXECUTE FUNCTION film_search_vector_update();

-- Backfill existing rows. UPDATE with no-op SET fires the trigger.
UPDATE "Film" SET title = title;
