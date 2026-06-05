@AGENTS.md

## Filesystem Safety

NEVER run multiple `rm -rf` or `npm install` commands concurrently. Always wait for each command to fully complete before starting the next. Never retry a failed `rm -rf` automatically — ask the user to handle it if it fails. Never stack destructive filesystem commands.

## Repository Scope

The mobile app lives in a separate repo (`cinemagraphs-mobile`). Do not write mobile/React Native code in this repo. This repo is the Next.js web app only.

## Production Data & Planning

Planning and scouting read code, schema, and tests, never production data. The Neon database behind `DATABASE_URL` is the shared prod/preview database, so any live-data query (counts, samples, `SELECT`s) is a production read and requires explicit go-ahead first. The sandbox egress block is a deliberate guard; do not wire around it (for example with a disabled sandbox or a one-off script) to reach Neon for a planning question. Build the code that would run the query, then ask before running it. The same rule covers DB-mutating commands (`prisma migrate deploy`, backfills): prepare them, confirm before executing.
