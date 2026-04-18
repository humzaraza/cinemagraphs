-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "public"."FilmStatus" AS ENUM ('ACTIVE', 'HIDDEN', 'PENDING');

-- CreateEnum
CREATE TYPE "public"."PersonRole" AS ENUM ('ACTOR', 'DIRECTOR', 'CINEMATOGRAPHER', 'COMPOSER', 'EDITOR', 'WRITER', 'PRODUCER');

-- CreateEnum
CREATE TYPE "public"."ReviewSource" AS ENUM ('TMDB', 'IMDB', 'REDDIT', 'CRITIC_BLOG', 'LETTERBOXD', 'GUARDIAN');

-- CreateEnum
CREATE TYPE "public"."UserRole" AS ENUM ('USER', 'MODERATOR', 'ADMIN', 'BANNED');

-- CreateTable
CREATE TABLE "public"."Account" (
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
CREATE TABLE "public"."Announcement" (
    "id" TEXT NOT NULL,
    "message" VARCHAR(500) NOT NULL,
    "pinned" BOOLEAN NOT NULL DEFAULT true,
    "authorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Announcement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Collection" (
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
CREATE TABLE "public"."FeaturedFilm" (
    "id" TEXT NOT NULL,
    "filmId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "FeaturedFilm_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Feedback" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "page" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Feedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Film" (
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
    "isFeatured" BOOLEAN NOT NULL DEFAULT false,
    "status" "public"."FilmStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastReviewCount" INTEGER NOT NULL DEFAULT 0,
    "nowPlaying" BOOLEAN NOT NULL DEFAULT false,
    "pinnedSection" TEXT,
    "nowPlayingOverride" TEXT,
    "tickerOverride" TEXT,
    "addedByUserId" TEXT,

    CONSTRAINT "Film_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."FilmBeats" (
    "id" TEXT NOT NULL,
    "filmId" TEXT NOT NULL,
    "beats" JSONB NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'wikipedia',
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FilmBeats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."FilmPerson" (
    "id" TEXT NOT NULL,
    "filmId" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "role" "public"."PersonRole" NOT NULL,
    "character" TEXT,
    "order" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FilmPerson_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Follow" (
    "id" TEXT NOT NULL,
    "followerId" TEXT NOT NULL,
    "followingId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Follow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."List" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "genreTag" TEXT,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "description" TEXT,
    "isPublic" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "List_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ListFilm" (
    "id" TEXT NOT NULL,
    "listId" TEXT NOT NULL,
    "filmId" TEXT NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ListFilm_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."LiveReaction" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "filmId" TEXT NOT NULL,
    "reaction" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "sessionTimestamp" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sessionId" TEXT,

    CONSTRAINT "LiveReaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."LiveReactionSession" (
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
CREATE TABLE "public"."PasswordResetToken" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PasswordResetToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Person" (
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
CREATE TABLE "public"."Review" (
    "id" TEXT NOT NULL,
    "filmId" TEXT NOT NULL,
    "sourcePlatform" "public"."ReviewSource" NOT NULL,
    "sourceUrl" TEXT,
    "author" TEXT,
    "reviewText" TEXT NOT NULL,
    "sourceRating" DOUBLE PRECISION,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "contentHash" TEXT,

    CONSTRAINT "Review_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."SentimentGraph" (
    "id" TEXT NOT NULL,
    "filmId" TEXT NOT NULL,
    "overallScore" DOUBLE PRECISION NOT NULL,
    "anchoredFrom" TEXT NOT NULL,
    "dataPoints" JSONB NOT NULL,
    "peakMoment" JSONB,
    "lowestMoment" JSONB,
    "biggestSwing" TEXT,
    "summary" TEXT,
    "reviewCount" INTEGER NOT NULL,
    "sourcesUsed" TEXT[],
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 1,
    "previousScore" DOUBLE PRECISION,
    "varianceSource" TEXT NOT NULL DEFAULT 'external_only',
    "reviewHash" TEXT,

    CONSTRAINT "SentimentGraph_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."SentimentGraphDriftLog" (
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

-- CreateTable
CREATE TABLE "public"."Session" (
    "id" TEXT NOT NULL,
    "sessionToken" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."SiteSettings" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,

    CONSTRAINT "SiteSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."User" (
    "id" TEXT NOT NULL,
    "name" TEXT,
    "email" TEXT NOT NULL,
    "emailVerified" TIMESTAMP(3),
    "image" TEXT,
    "bio" TEXT,
    "favoriteGenres" TEXT[],
    "role" "public"."UserRole" NOT NULL DEFAULT 'USER',
    "isPublic" BOOLEAN NOT NULL DEFAULT true,
    "points" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "password" TEXT,
    "username" TEXT,
    "suspendedUntil" TIMESTAMP(3),
    "lastFilmAddedAt" TIMESTAMP(3),
    "allowFollowers" BOOLEAN NOT NULL DEFAULT true,
    "privateGraphs" BOOLEAN NOT NULL DEFAULT false,
    "publicProfile" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."UserReview" (
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
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'approved',
    "flagReason" TEXT,

    CONSTRAINT "UserReview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."VerificationToken" (
    "identifier" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL
);

-- CreateTable
CREATE TABLE "public"."Watchlist" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "filmId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Watchlist_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Account_provider_providerAccountId_key" ON "public"."Account"("provider" ASC, "providerAccountId" ASC);

-- CreateIndex
CREATE INDEX "Announcement_pinned_idx" ON "public"."Announcement"("pinned" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "FeaturedFilm_filmId_key" ON "public"."FeaturedFilm"("filmId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "FeaturedFilm_position_key" ON "public"."FeaturedFilm"("position" ASC);

-- CreateIndex
CREATE INDEX "Feedback_createdAt_idx" ON "public"."Feedback"("createdAt" ASC);

-- CreateIndex
CREATE INDEX "Film_title_idx" ON "public"."Film"("title" ASC);

-- CreateIndex
CREATE INDEX "Film_tmdbId_idx" ON "public"."Film"("tmdbId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "Film_tmdbId_key" ON "public"."Film"("tmdbId" ASC);

-- CreateIndex
CREATE INDEX "FilmBeats_filmId_idx" ON "public"."FilmBeats"("filmId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "FilmBeats_filmId_key" ON "public"."FilmBeats"("filmId" ASC);

-- CreateIndex
CREATE INDEX "FilmPerson_filmId_idx" ON "public"."FilmPerson"("filmId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "FilmPerson_filmId_personId_role_key" ON "public"."FilmPerson"("filmId" ASC, "personId" ASC, "role" ASC);

-- CreateIndex
CREATE INDEX "FilmPerson_personId_idx" ON "public"."FilmPerson"("personId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "Follow_followerId_followingId_key" ON "public"."Follow"("followerId" ASC, "followingId" ASC);

-- CreateIndex
CREATE INDEX "Follow_followerId_idx" ON "public"."Follow"("followerId" ASC);

-- CreateIndex
CREATE INDEX "Follow_followingId_idx" ON "public"."Follow"("followingId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "ListFilm_listId_filmId_key" ON "public"."ListFilm"("listId" ASC, "filmId" ASC);

-- CreateIndex
CREATE INDEX "LiveReaction_filmId_idx" ON "public"."LiveReaction"("filmId" ASC);

-- CreateIndex
CREATE INDEX "LiveReaction_sessionId_idx" ON "public"."LiveReaction"("sessionId" ASC);

-- CreateIndex
CREATE INDEX "LiveReaction_userId_filmId_idx" ON "public"."LiveReaction"("userId" ASC, "filmId" ASC);

-- CreateIndex
CREATE INDEX "LiveReactionSession_userId_filmId_idx" ON "public"."LiveReactionSession"("userId" ASC, "filmId" ASC);

-- CreateIndex
CREATE INDEX "PasswordResetToken_email_idx" ON "public"."PasswordResetToken"("email" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "PasswordResetToken_token_key" ON "public"."PasswordResetToken"("token" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "Person_slug_key" ON "public"."Person"("slug" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "Person_tmdbPersonId_key" ON "public"."Person"("tmdbPersonId" ASC);

-- CreateIndex
CREATE INDEX "Review_contentHash_idx" ON "public"."Review"("contentHash" ASC);

-- CreateIndex
CREATE INDEX "Review_filmId_idx" ON "public"."Review"("filmId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "SentimentGraph_filmId_key" ON "public"."SentimentGraph"("filmId" ASC);

-- CreateIndex
CREATE INDEX "SentimentGraphDriftLog_filmId_idx" ON "public"."SentimentGraphDriftLog"("filmId" ASC);

-- CreateIndex
CREATE INDEX "SentimentGraphDriftLog_occurredAt_idx" ON "public"."SentimentGraphDriftLog"("occurredAt" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "Session_sessionToken_key" ON "public"."Session"("sessionToken" ASC);

-- CreateIndex
CREATE INDEX "SiteSettings_key_idx" ON "public"."SiteSettings"("key" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "SiteSettings_key_key" ON "public"."SiteSettings"("key" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "public"."User"("email" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "public"."User"("username" ASC);

-- CreateIndex
CREATE INDEX "UserReview_filmId_idx" ON "public"."UserReview"("filmId" ASC);

-- CreateIndex
CREATE INDEX "UserReview_status_idx" ON "public"."UserReview"("status" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "UserReview_userId_filmId_key" ON "public"."UserReview"("userId" ASC, "filmId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "VerificationToken_identifier_token_key" ON "public"."VerificationToken"("identifier" ASC, "token" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "VerificationToken_token_key" ON "public"."VerificationToken"("token" ASC);

-- CreateIndex
CREATE INDEX "Watchlist_filmId_idx" ON "public"."Watchlist"("filmId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "Watchlist_userId_filmId_key" ON "public"."Watchlist"("userId" ASC, "filmId" ASC);

-- CreateIndex
CREATE INDEX "Watchlist_userId_idx" ON "public"."Watchlist"("userId" ASC);

-- AddForeignKey
ALTER TABLE "public"."Account" ADD CONSTRAINT "Account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Announcement" ADD CONSTRAINT "Announcement_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Collection" ADD CONSTRAINT "Collection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."FeaturedFilm" ADD CONSTRAINT "FeaturedFilm_filmId_fkey" FOREIGN KEY ("filmId") REFERENCES "public"."Film"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Feedback" ADD CONSTRAINT "Feedback_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Film" ADD CONSTRAINT "Film_addedByUserId_fkey" FOREIGN KEY ("addedByUserId") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."FilmBeats" ADD CONSTRAINT "FilmBeats_filmId_fkey" FOREIGN KEY ("filmId") REFERENCES "public"."Film"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."FilmPerson" ADD CONSTRAINT "FilmPerson_filmId_fkey" FOREIGN KEY ("filmId") REFERENCES "public"."Film"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."FilmPerson" ADD CONSTRAINT "FilmPerson_personId_fkey" FOREIGN KEY ("personId") REFERENCES "public"."Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Follow" ADD CONSTRAINT "Follow_followerId_fkey" FOREIGN KEY ("followerId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Follow" ADD CONSTRAINT "Follow_followingId_fkey" FOREIGN KEY ("followingId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."List" ADD CONSTRAINT "List_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ListFilm" ADD CONSTRAINT "ListFilm_filmId_fkey" FOREIGN KEY ("filmId") REFERENCES "public"."Film"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ListFilm" ADD CONSTRAINT "ListFilm_listId_fkey" FOREIGN KEY ("listId") REFERENCES "public"."List"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."LiveReaction" ADD CONSTRAINT "LiveReaction_filmId_fkey" FOREIGN KEY ("filmId") REFERENCES "public"."Film"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."LiveReaction" ADD CONSTRAINT "LiveReaction_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "public"."LiveReactionSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."LiveReaction" ADD CONSTRAINT "LiveReaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."LiveReactionSession" ADD CONSTRAINT "LiveReactionSession_filmId_fkey" FOREIGN KEY ("filmId") REFERENCES "public"."Film"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."LiveReactionSession" ADD CONSTRAINT "LiveReactionSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Review" ADD CONSTRAINT "Review_filmId_fkey" FOREIGN KEY ("filmId") REFERENCES "public"."Film"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."SentimentGraph" ADD CONSTRAINT "SentimentGraph_filmId_fkey" FOREIGN KEY ("filmId") REFERENCES "public"."Film"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."SentimentGraphDriftLog" ADD CONSTRAINT "SentimentGraphDriftLog_filmId_fkey" FOREIGN KEY ("filmId") REFERENCES "public"."Film"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."UserReview" ADD CONSTRAINT "UserReview_filmId_fkey" FOREIGN KEY ("filmId") REFERENCES "public"."Film"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."UserReview" ADD CONSTRAINT "UserReview_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Watchlist" ADD CONSTRAINT "Watchlist_filmId_fkey" FOREIGN KEY ("filmId") REFERENCES "public"."Film"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Watchlist" ADD CONSTRAINT "Watchlist_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

