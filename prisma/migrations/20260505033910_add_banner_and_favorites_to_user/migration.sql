-- CreateEnum
CREATE TYPE "BannerType" AS ENUM ('GRADIENT', 'PHOTO', 'BACKDROP');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "bannerType" "BannerType" NOT NULL DEFAULT 'GRADIENT',
ADD COLUMN     "bannerValue" TEXT NOT NULL DEFAULT 'midnight',
ADD COLUMN     "favoriteFilms" TEXT[] DEFAULT ARRAY[]::TEXT[];
