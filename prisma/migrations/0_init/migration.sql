-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('USER', 'MODERATOR', 'ADMIN', 'BANNED');

-- CreateEnum
CREATE TYPE "FilmStatus" AS ENUM ('ACTIVE', 'HIDDEN', 'PENDING');

-- CreateEnum
CREATE TYPE "PersonRole" AS ENUM ('ACTOR', 'DIRECTOR', 'CINEMATOGRAPHER', 'COMPOSER', 'EDITOR', 'WRITER', 'PRODUCER');

-- CreateEnum
CREATE TYPE "ReviewSource" AS ENUM ('TMDB', 'IMDB', 'REDDIT', 'CRITIC_BLOG', 'LETTERBOXD', 'GUARDIAN');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "name" TEXT,
    "username" TEXT,
    "email" TEXT NOT NULL,
    "emailVerified" TIMESTAMP(3),
    "image" TEXT,
    "bio" TEXT,
    "favoriteGenres" TEXT[],
    "password" TEXT,
    "role" "UserRole" NOT NULL DEFAULT 'USER',
    "suspendedUntil" TIMESTAMP(3),
    "isPublic" BOOLEAN NOT NULL DEFAULT true,
    "publicProfile" BOOLEAN NOT NULL DEFAULT true,
    "allowFollowers" BOOLEAN NOT NULL DEFAULT true,
    "privateGraphs" BOOLEAN NOT NULL DEFAULT false,
    "points" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastFilmAddedAt" TIMESTAMP(3),

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerAccountId" TEXT NOT NULL,
    "refresh_token" TEXT,
    "access_token" TEXT,
    "expires_at" INTEGER,
    "token_type" TEXT,
    "scope" TEXT,
    "id_token" TEXT,
    "session_state" TEXT,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "sessionToken" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VerificationToken" (
    "identifier" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL
);

-- CreateTable
CREATE TABLE "PasswordResetToken" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PasswordResetToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Film" (
    "id" TEXT NOT NULL,
    "tmdbId" INTEGER NOT NULL,
    "imdbId" TEXT,
    "title" TEXT NOT NULL,
    "releaseDate" TIMESTAMP(3),
    "runtime" INTEGER,
    "synopsis" TEXT,
    "posterUrl" TEXT,
    "backdropUrl" TEXT,
    "genres" TEXT[],
    "director" TEXT,
    "cast" JSONB,
    "imdbRating" DOUBLE PRECISION,
    "imdbVotes" INTEGER,
    "rtCriticsScore" INTEGER,
    "rtAudienceScore" INTEGER,
    "metacriticScore" INTEGER,
    "lastReviewCount" INTEGER NOT NULL DEFAULT 0,
    "nowPlaying" BOOLEAN NOT NULL DEFAULT false,
    "nowPlayingOverride" TEXT,
    "tickerOverride" TEXT,
    "addedByUserId" TEXT,
    "isFeatured" BOOLEAN NOT NULL DEFAULT false,
    "pinnedSection" TEXT,
    "status" "FilmStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Film_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SentimentGraph" (
    "id" TEXT NOT NULL,
    "filmId" TEXT NOT NULL,
    "overallScore" DOUBLE PRECISION NOT NULL,
    "previousScore" DOUBLE PRECISION,
    "anchoredFrom" TEXT NOT NULL,
    "dataPoints" JSONB NOT NULL,
    "peakMoment" JSONB,
    "lowestMoment" JSONB,
    "biggestSwing" TEXT,
    "summary" TEXT,
    "reviewCount" INTEGER NOT NULL,
    "sourcesUsed" TEXT[],
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "varianceSource" TEXT NOT NULL DEFAULT 'external_only',
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "SentimentGraph_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FilmBeats" (
    "id" TEXT NOT NULL,
    "filmId" TEXT NOT NULL,
    "beats" JSONB NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'wikipedia',
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FilmBeats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Review" (
    "id" TEXT NOT NULL,
    "filmId" TEXT NOT NULL,
    "sourcePlatform" "ReviewSource" NOT NULL,
    "sourceUrl" TEXT,
    "author" TEXT,
    "reviewText" TEXT NOT NULL,
    "sourceRating" DOUBLE PRECISION,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "contentHash" TEXT,

    CONSTRAINT "Review_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FeaturedFilm" (
    "id" TEXT NOT NULL,
    "filmId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "FeaturedFilm_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SiteSettings" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,

    CONSTRAINT "SiteSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserReview" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "filmId" TEXT NOT NULL,
    "overallRating" DOUBLE PRECISION NOT NULL,
    "beginning" TEXT,
    "middle" TEXT,
    "ending" TEXT,
    "otherThoughts" TEXT,
    "combinedText" TEXT,
    "beatRatings" JSONB,
    "sentiment" DOUBLE PRECISION,
    "status" TEXT NOT NULL DEFAULT 'approved',
    "flagReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserReview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LiveReaction" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "filmId" TEXT NOT NULL,
    "reaction" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "sessionTimestamp" INTEGER NOT NULL,
    "sessionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LiveReaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LiveReactionSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "filmId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastReactionAt" TIMESTAMP(3) NOT NULL,
    "completionRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "flagged" BOOLEAN NOT NULL DEFAULT false,
    "flagReason" TEXT,

    CONSTRAINT "LiveReactionSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Feedback" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "page" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Feedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Collection" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "isPublic" BOOLEAN NOT NULL DEFAULT true,
    "filmIds" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Collection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Watchlist" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "filmId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Watchlist_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Announcement" (
    "id" TEXT NOT NULL,
    "message" VARCHAR(500) NOT NULL,
    "pinned" BOOLEAN NOT NULL DEFAULT true,
    "authorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Announcement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Follow" (
    "id" TEXT NOT NULL,
    "followerId" TEXT NOT NULL,
    "followingId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Follow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Person" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "tmdbPersonId" INTEGER NOT NULL,
    "profilePath" TEXT,
    "biography" TEXT,
    "birthday" TEXT,
    "deathday" TEXT,
    "knownForDepartment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Person_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FilmPerson" (
    "id" TEXT NOT NULL,
    "filmId" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "role" "PersonRole" NOT NULL,
    "character" TEXT,
    "order" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FilmPerson_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "List" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "genreTag" TEXT,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "List_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ListFilm" (
    "id" TEXT NOT NULL,
    "listId" TEXT NOT NULL,
    "filmId" TEXT NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ListFilm_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Account_provider_providerAccountId_key" ON "Account"("provider", "providerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "Session_sessionToken_key" ON "Session"("sessionToken");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationToken_token_key" ON "VerificationToken"("token");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationToken_identifier_token_key" ON "VerificationToken"("identifier", "token");

-- CreateIndex
CREATE UNIQUE INDEX "PasswordResetToken_token_key" ON "PasswordResetToken"("token");

-- CreateIndex
CREATE INDEX "PasswordResetToken_email_idx" ON "PasswordResetToken"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Film_tmdbId_key" ON "Film"("tmdbId");

-- CreateIndex
CREATE INDEX "Film_tmdbId_idx" ON "Film"("tmdbId");

-- CreateIndex
CREATE INDEX "Film_title_idx" ON "Film"("title");

-- CreateIndex
CREATE UNIQUE INDEX "SentimentGraph_filmId_key" ON "SentimentGraph"("filmId");

-- CreateIndex
CREATE UNIQUE INDEX "FilmBeats_filmId_key" ON "FilmBeats"("filmId");

-- CreateIndex
CREATE INDEX "FilmBeats_filmId_idx" ON "FilmBeats"("filmId");

-- CreateIndex
CREATE INDEX "Review_filmId_idx" ON "Review"("filmId");

-- CreateIndex
CREATE INDEX "Review_contentHash_idx" ON "Review"("contentHash");

-- CreateIndex
CREATE UNIQUE INDEX "FeaturedFilm_filmId_key" ON "FeaturedFilm"("filmId");

-- CreateIndex
CREATE UNIQUE INDEX "FeaturedFilm_position_key" ON "FeaturedFilm"("position");

-- CreateIndex
CREATE UNIQUE INDEX "SiteSettings_key_key" ON "SiteSettings"("key");

-- CreateIndex
CREATE INDEX "SiteSettings_key_idx" ON "SiteSettings"("key");

-- CreateIndex
CREATE INDEX "UserReview_filmId_idx" ON "UserReview"("filmId");

-- CreateIndex
CREATE INDEX "UserReview_status_idx" ON "UserReview"("status");

-- CreateIndex
CREATE UNIQUE INDEX "UserReview_userId_filmId_key" ON "UserReview"("userId", "filmId");

-- CreateIndex
CREATE INDEX "LiveReaction_filmId_idx" ON "LiveReaction"("filmId");

-- CreateIndex
CREATE INDEX "LiveReaction_userId_filmId_idx" ON "LiveReaction"("userId", "filmId");

-- CreateIndex
CREATE INDEX "LiveReaction_sessionId_idx" ON "LiveReaction"("sessionId");

-- CreateIndex
CREATE INDEX "LiveReactionSession_userId_filmId_idx" ON "LiveReactionSession"("userId", "filmId");

-- CreateIndex
CREATE INDEX "Feedback_createdAt_idx" ON "Feedback"("createdAt");

-- CreateIndex
CREATE INDEX "Watchlist_userId_idx" ON "Watchlist"("userId");

-- CreateIndex
CREATE INDEX "Watchlist_filmId_idx" ON "Watchlist"("filmId");

-- CreateIndex
CREATE UNIQUE INDEX "Watchlist_userId_filmId_key" ON "Watchlist"("userId", "filmId");

-- CreateIndex
CREATE INDEX "Announcement_pinned_idx" ON "Announcement"("pinned");

-- CreateIndex
CREATE INDEX "Follow_followerId_idx" ON "Follow"("followerId");

-- CreateIndex
CREATE INDEX "Follow_followingId_idx" ON "Follow"("followingId");

-- CreateIndex
CREATE UNIQUE INDEX "Follow_followerId_followingId_key" ON "Follow"("followerId", "followingId");

-- CreateIndex
CREATE UNIQUE INDEX "Person_slug_key" ON "Person"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Person_tmdbPersonId_key" ON "Person"("tmdbPersonId");

-- CreateIndex
CREATE INDEX "FilmPerson_filmId_idx" ON "FilmPerson"("filmId");

-- CreateIndex
CREATE INDEX "FilmPerson_personId_idx" ON "FilmPerson"("personId");

-- CreateIndex
CREATE UNIQUE INDEX "FilmPerson_filmId_personId_role_key" ON "FilmPerson"("filmId", "personId", "role");

-- CreateIndex
CREATE UNIQUE INDEX "ListFilm_listId_filmId_key" ON "ListFilm"("listId", "filmId");

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Film" ADD CONSTRAINT "Film_addedByUserId_fkey" FOREIGN KEY ("addedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SentimentGraph" ADD CONSTRAINT "SentimentGraph_filmId_fkey" FOREIGN KEY ("filmId") REFERENCES "Film"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FilmBeats" ADD CONSTRAINT "FilmBeats_filmId_fkey" FOREIGN KEY ("filmId") REFERENCES "Film"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_filmId_fkey" FOREIGN KEY ("filmId") REFERENCES "Film"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeaturedFilm" ADD CONSTRAINT "FeaturedFilm_filmId_fkey" FOREIGN KEY ("filmId") REFERENCES "Film"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserReview" ADD CONSTRAINT "UserReview_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserReview" ADD CONSTRAINT "UserReview_filmId_fkey" FOREIGN KEY ("filmId") REFERENCES "Film"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LiveReaction" ADD CONSTRAINT "LiveReaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LiveReaction" ADD CONSTRAINT "LiveReaction_filmId_fkey" FOREIGN KEY ("filmId") REFERENCES "Film"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LiveReaction" ADD CONSTRAINT "LiveReaction_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "LiveReactionSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LiveReactionSession" ADD CONSTRAINT "LiveReactionSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LiveReactionSession" ADD CONSTRAINT "LiveReactionSession_filmId_fkey" FOREIGN KEY ("filmId") REFERENCES "Film"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Feedback" ADD CONSTRAINT "Feedback_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Collection" ADD CONSTRAINT "Collection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Watchlist" ADD CONSTRAINT "Watchlist_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Watchlist" ADD CONSTRAINT "Watchlist_filmId_fkey" FOREIGN KEY ("filmId") REFERENCES "Film"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Announcement" ADD CONSTRAINT "Announcement_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Follow" ADD CONSTRAINT "Follow_followerId_fkey" FOREIGN KEY ("followerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Follow" ADD CONSTRAINT "Follow_followingId_fkey" FOREIGN KEY ("followingId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FilmPerson" ADD CONSTRAINT "FilmPerson_filmId_fkey" FOREIGN KEY ("filmId") REFERENCES "Film"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FilmPerson" ADD CONSTRAINT "FilmPerson_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "List" ADD CONSTRAINT "List_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListFilm" ADD CONSTRAINT "ListFilm_listId_fkey" FOREIGN KEY ("listId") REFERENCES "List"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListFilm" ADD CONSTRAINT "ListFilm_filmId_fkey" FOREIGN KEY ("filmId") REFERENCES "Film"("id") ON DELETE CASCADE ON UPDATE CASCADE;

