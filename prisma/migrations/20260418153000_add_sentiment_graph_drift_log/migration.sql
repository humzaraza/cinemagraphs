-- CreateTable
CREATE TABLE "SentimentGraphDriftLog" (
    "id" TEXT NOT NULL,
    "filmId" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "callerPath" TEXT NOT NULL,
    "existingBeatCount" INTEGER NOT NULL,
    "incomingBeatCount" INTEGER NOT NULL,
    "mismatchedLabels" JSONB NOT NULL,
    "action" TEXT NOT NULL,
    "envLockEnabled" BOOLEAN NOT NULL,

    CONSTRAINT "SentimentGraphDriftLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SentimentGraphDriftLog_filmId_idx" ON "SentimentGraphDriftLog"("filmId");

-- CreateIndex
CREATE INDEX "SentimentGraphDriftLog_occurredAt_idx" ON "SentimentGraphDriftLog"("occurredAt");

-- AddForeignKey
ALTER TABLE "SentimentGraphDriftLog" ADD CONSTRAINT "SentimentGraphDriftLog_filmId_fkey" FOREIGN KEY ("filmId") REFERENCES "Film"("id") ON DELETE CASCADE ON UPDATE CASCADE;
