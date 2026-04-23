-- AlterTable
ALTER TABLE "CarouselDraft" ADD COLUMN     "mirrorRenderedAt" TIMESTAMP(3),
ADD COLUMN     "mirrorSyncError" TEXT,
ADD COLUMN     "mirrorSyncStatus" TEXT,
ADD COLUMN     "staleBodyCopySlots" INTEGER[] DEFAULT ARRAY[]::INTEGER[];
