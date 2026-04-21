-- CreateTable
CREATE TABLE "CarouselDraft" (
    "id" TEXT NOT NULL,
    "filmId" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "bodyCopyJson" JSONB NOT NULL,
    "slotSelectionsJson" JSONB NOT NULL,
    "characteristicsJson" JSONB NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "generatedAtModel" TEXT NOT NULL,

    CONSTRAINT "CarouselDraft_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CarouselDraft_filmId_idx" ON "CarouselDraft"("filmId");

-- CreateIndex
CREATE UNIQUE INDEX "CarouselDraft_filmId_format_key" ON "CarouselDraft"("filmId", "format");

-- AddForeignKey
ALTER TABLE "CarouselDraft" ADD CONSTRAINT "CarouselDraft_filmId_fkey" FOREIGN KEY ("filmId") REFERENCES "Film"("id") ON DELETE CASCADE ON UPDATE CASCADE;
