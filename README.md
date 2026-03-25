# Cinemagraphs

**[cinemagraphs.ca](https://cinemagraphs.ca)**

A Next.js web application that aggregates movie reviews from multiple sources (TMDB, IMDb, The Guardian, Reddit, Letterboxd, critic blogs), analyzes them with Claude AI, and generates sentiment graphs showing how audience opinion shifts scene-by-scene across a film's runtime.

## Tech Stack

- **Next.js 16** (App Router)
- **TypeScript**
- **Tailwind CSS 4**
- **Prisma ORM** with **Neon PostgreSQL** (serverless)
- **Recharts 3** for data visualization
- **Claude Sonnet** (Anthropic API) for NLP sentiment analysis
- **NextAuth.js** with Google OAuth
- Deployed on **Vercel**

## Project Structure

```
src/
├── app/                    # Next.js App Router pages & API routes
│   ├── api/
│   │   ├── admin/          # Admin-only endpoints (import, analyze)
│   │   ├── auth/           # NextAuth endpoints
│   │   ├── cron/           # Scheduled analysis jobs
│   │   └── films/          # Public film API
│   ├── admin/              # Admin dashboard
│   ├── auth/               # Auth pages
│   ├── films/              # Film detail & browse pages
│   └── page.tsx            # Homepage
├── components/             # React components
│   ├── SentimentGraph.tsx  # Main sentiment visualization
│   ├── FilmCard.tsx        # Film card with mini graph
│   ├── FilmCardMiniGraph.tsx # Condensed sparkline graph
│   └── ...
├── lib/                    # Business logic
│   ├── types.ts            # Shared TypeScript types
│   ├── claude.ts           # Claude AI sentiment analysis
│   ├── review-fetcher.ts   # Multi-source review orchestrator
│   ├── sources/            # Individual review source fetchers
│   │   ├── tmdb.ts
│   │   ├── imdb.ts
│   │   ├── guardian.ts
│   │   ├── reddit.ts
│   │   ├── letterboxd.ts
│   │   ├── critic.ts
│   │   └── helpers.ts
│   ├── sentiment-pipeline.ts # Full analysis pipeline orchestrator
│   ├── omdb.ts             # OMDB anchor scores
│   ├── tmdb.ts             # TMDB API helpers
│   ├── prisma.ts           # Prisma client singleton
│   ├── auth.ts             # NextAuth config
│   └── utils.ts            # General utilities
└── generated/prisma/       # Auto-generated Prisma client
prisma/
└── schema.prisma           # Database schema
```

## How the Sentiment Pipeline Works

1. **Review Fetching** -- Aggregates reviews from up to 6 sources in parallel (TMDB, IMDb via RapidAPI, The Guardian, Reddit, Letterboxd, critic blogs).
2. **Anchor Scores** -- Pulls IMDb/RT/Metacritic ratings from OMDB as calibration anchors.
3. **AI Analysis** -- Sends reviews and anchor scores to Claude Sonnet, which generates 14-18 data points mapping sentiment across the film's runtime.
4. **Storage** -- Results are stored as JSON in the `SentimentGraph` table, linked to each `Film`.
5. **Visualization** -- Recharts renders an interactive area chart with confidence-weighted dots, reference lines, and peak/low moment markers.

## Getting Started

1. Clone the repo.
2. Copy `.env.example` to `.env` and fill in the required values.
3. Install dependencies:
   ```bash
   npm install
   ```
4. Push the database schema:
   ```bash
   npx prisma db push
   ```
5. Generate the Prisma client:
   ```bash
   npx prisma generate
   ```
6. Start the development server:
   ```bash
   npm run dev
   ```

## Environment Variables

See `.env.example` for all required and optional variables.

## Key Commands

| Command | Description |
|---|---|
| `npm run dev` | Start the development server |
| `npm run build` | Production build |
| `npx prisma studio` | Browse the database visually |
| `npx prisma db push` | Push schema changes to the database |
