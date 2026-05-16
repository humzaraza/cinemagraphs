-- AlterTable
ALTER TABLE "User" ADD COLUMN     "termsAcceptedAt" TIMESTAMP(3),
ADD COLUMN     "termsVersion" TEXT;

UPDATE "User" SET "termsAcceptedAt" = NOW(), "termsVersion" = '2026-05-15' WHERE "termsAcceptedAt" IS NULL;
