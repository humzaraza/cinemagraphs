-- AlterTable: User gets two global blind-mode defaults
ALTER TABLE "User" ADD COLUMN     "blindUnwatchedDefault" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "blindReviewedDefault" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable: Film gets lowercased TMDB keyword array
ALTER TABLE "Film" ADD COLUMN     "keywords" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable: per-film blind-mode overrides
CREATE TABLE "UserFilmBlindMode" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "filmId" TEXT NOT NULL,
    "isBlind" BOOLEAN NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserFilmBlindMode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UserFilmBlindMode_userId_filmId_key" ON "UserFilmBlindMode"("userId", "filmId");

-- CreateIndex
CREATE INDEX "UserFilmBlindMode_userId_idx" ON "UserFilmBlindMode"("userId");

-- CreateTable: pre-computed similar films (top-N per source)
CREATE TABLE "SimilarFilm" (
    "id" TEXT NOT NULL,
    "filmId" TEXT NOT NULL,
    "similarFilmId" TEXT NOT NULL,
    "similarityScore" DOUBLE PRECISION NOT NULL,
    "matchSignals" JSONB NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SimilarFilm_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SimilarFilm_filmId_similarFilmId_key" ON "SimilarFilm"("filmId", "similarFilmId");

-- CreateIndex: source film + score DESC for fast top-N retrieval
CREATE INDEX "SimilarFilm_filmId_similarityScore_idx" ON "SimilarFilm"("filmId", "similarityScore" DESC);

-- AddForeignKey
ALTER TABLE "UserFilmBlindMode" ADD CONSTRAINT "UserFilmBlindMode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserFilmBlindMode" ADD CONSTRAINT "UserFilmBlindMode_filmId_fkey" FOREIGN KEY ("filmId") REFERENCES "Film"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SimilarFilm" ADD CONSTRAINT "SimilarFilm_filmId_fkey" FOREIGN KEY ("filmId") REFERENCES "Film"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SimilarFilm" ADD CONSTRAINT "SimilarFilm_similarFilmId_fkey" FOREIGN KEY ("similarFilmId") REFERENCES "Film"("id") ON DELETE CASCADE ON UPDATE CASCADE;
