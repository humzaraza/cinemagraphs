@AGENTS.md

## Filesystem Safety

NEVER run multiple `rm -rf` or `npm install` commands concurrently. Always wait for each command to fully complete before starting the next. Never retry a failed `rm -rf` automatically — ask the user to handle it if it fails. Never stack destructive filesystem commands.

## Repository Scope

The mobile app lives in a separate repo (`cinemagraphs-mobile`). Do not write mobile/React Native code in this repo. This repo is the Next.js web app only.

## Verification & Merging

Establish merge status only with a two-dot content diff: `git --no-pager diff origin/main <branch>`. Never search commit messages for a PR number suffix. This repo squash-merges, which rewrites the message on main and leaves the local branch tip unchanged, producing a false negative every time.

When a prompt asks for the raw output of a command, paste the complete output into the reply itself. A reference to tool output visible only in the CC session is not a substitute.

## Production Data & Planning

Planning and scouting read code, schema, and tests, never production data.

Two Neon branches exist. Production is the endpoint whose host contains
`plain-shadow`. Dev is the branch `dev-activity-feed`, whose host contains
`cool-lake`. `.env.local` points at `cool-lake`, so a local script or query runs
against dev by default. Vercel Production and Preview deployments point at
`plain-shadow`.

Never state which database a command will hit without verifying it in the same
session. Do not infer it from this file, from `.env.example`, or from
`NODE_ENV`. Verify by reading the host out of the real environment with exactly
this pipeline, which strips credentials before printing:

    grep -E '^(DATABASE_URL|DIRECT_URL)' .env.local | sed 's/=.*@/=/' | cut -d/ -f1

Do not `cat`, `view`, or otherwise read the whole of `.env.local`; it holds live
secrets.

Any query against `plain-shadow` is a production read (counts, samples,
`SELECT`s) and requires explicit go-ahead first. The sandbox egress block is a
deliberate guard; do not wire around it (for example with a disabled sandbox or
a one-off script) to reach Neon for a planning question. Build the code that
would run the query, then ask before running it. The same rule covers
DB-mutating commands (`prisma migrate deploy`, backfills): prepare them, confirm
before executing.
