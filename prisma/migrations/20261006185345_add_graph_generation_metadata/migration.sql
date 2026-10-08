ALTER TABLE "SentimentGraph"
  ADD COLUMN "generationMode" TEXT,
  ADD COLUMN "plotSource" TEXT,
  ADD COLUMN "modelName" TEXT,
  ADD COLUMN "promptVersion" TEXT,
  ADD COLUMN "reviewsInPrompt" INTEGER;
