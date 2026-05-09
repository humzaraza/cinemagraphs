#!/usr/bin/env node
/**
 * Generates a new Apple Sign In client secret JWT.
 *
 * Reads the .p8 private key from the path in APPLE_KEY_PATH env var.
 * Outputs the JWT to stdout. Copy that output into the APPLE_SECRET
 * env var in Vercel.
 *
 * Usage:
 *   APPLE_KEY_PATH=~/Desktop/Cinemagraphs/AuthKey_SCR59ABFVK.p8 \
 *     node scripts/generate-apple-client-secret.mjs
 *
 * The generated JWT expires in 6 months (max allowed by Apple).
 * See docs/auth/apple-key-rotation.md for the full procedure.
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import appleSignin from 'apple-signin-auth'

const KEY_ID = 'SCR59ABFVK'
const TEAM_ID = '639P4Q2VAB'
const SERVICES_ID = 'ca.cinemagraphs.web'
const SIX_MONTHS_SECONDS = 15_777_000

const keyPath = process.env.APPLE_KEY_PATH
if (!keyPath) {
  console.error('Error: APPLE_KEY_PATH env var is required.')
  console.error('Example: APPLE_KEY_PATH=~/Desktop/Cinemagraphs/AuthKey_SCR59ABFVK.p8 node scripts/generate-apple-client-secret.mjs')
  process.exit(1)
}

const expandedPath = keyPath.startsWith('~')
  ? path.join(os.homedir(), keyPath.slice(1))
  : keyPath

if (!fs.existsSync(expandedPath)) {
  console.error(`Error: .p8 file not found at ${expandedPath}`)
  process.exit(1)
}

const privateKey = fs.readFileSync(expandedPath, 'utf8')

const clientSecret = appleSignin.getClientSecret({
  clientID: SERVICES_ID,
  teamID: TEAM_ID,
  privateKey,
  keyIdentifier: KEY_ID,
  expAfter: SIX_MONTHS_SECONDS,
})

process.stdout.write(clientSecret)
process.stdout.write('\n')
