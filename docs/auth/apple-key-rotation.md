# Apple Sign In Key Rotation

## Overview

This document covers rotating the Apple Sign In client secret JWT and, when needed, the underlying .p8 private key.

## Current configuration

| Field | Value |
|-------|-------|
| Key ID | `SCR59ABFVK` |
| Team ID | `639P4Q2VAB` |
| Services ID (clientID) | `ca.cinemagraphs.web` |
| Bundle ID (mobile) | `ca.cinemagraphs.app` |
| .p8 file location | `~/Desktop/Cinemagraphs/AuthKey_SCR59ABFVK.p8` |
| Encrypted backup | Apple Notes (iCloud sync) |
| Current JWT expiry | September 2026 (approximate; decode current APPLE_SECRET to confirm) |

## What APPLE_SECRET actually is

`APPLE_SECRET` in Vercel is NOT the .p8 file directly. It is a JWT signed with the .p8 private key, carrying these claims:

- `iss`: Team ID (`639P4Q2VAB`)
- `iat`: Issued-at timestamp
- `exp`: Expiry (max 6 months from issue per Apple's spec)
- `aud`: `https://appleid.apple.com`
- `sub`: Services ID (`ca.cinemagraphs.web`)
- Header `kid`: Key ID (`SCR59ABFVK`)

This JWT is what NextAuth's AppleProvider uses to authenticate the web sign-in callback. Apple verifies the signature using the public key associated with `kid` in their developer portal.

**Mobile flow does NOT use APPLE_SECRET.** `/api/auth/mobile/apple` only verifies inbound identity tokens from Apple via `appleSignin.verifyIdToken(token, { audience: APPLE_ID })`. JWT expiry breaks the web NextAuth sign-in flow only; mobile sign-in continues working through any APPLE_SECRET expiry.

## Two rotation scenarios

### Scenario A: JWT regeneration (routine, every 6 months)

The JWT has a max 6-month expiry. Before it expires, web sign-in via NextAuth will start failing with Apple-side validation errors. Regenerate the JWT from the existing .p8 and update `APPLE_SECRET` in Vercel.

### Scenario B: Full .p8 rotation (security event)

If the .p8 is compromised or the team wants a fresh key, generate a new one in the Apple Developer portal. This produces a new Key ID and a new .p8 file. Then run Scenario A's procedure with the new key.

## Pre-rotation checklist

- [ ] Confirm Apple Notes encrypted backup is current (open the note, verify the .p8 contents are present)
- [ ] Confirm the .p8 file is at the documented path: `~/Desktop/Cinemagraphs/AuthKey_SCR59ABFVK.p8`
- [ ] Have access to Vercel env vars (Project Settings → Environment Variables)
- [ ] Have access to Apple Developer portal (https://developer.apple.com/account) if doing Scenario B
- [ ] Plan a low-traffic deploy window for the env var update (rotation is fast but a misconfigured value breaks all web sign-ins)

## Procedure: JWT regeneration (Scenario A)

1. **Generate the new JWT locally:**

   ```bash
   APPLE_KEY_PATH=~/Desktop/Cinemagraphs/AuthKey_SCR59ABFVK.p8 \
     node scripts/generate-apple-client-secret.mjs
   ```

   The script outputs a JWT to stdout. Copy it.

2. **Decode the JWT to confirm claims (optional sanity check):**

   Paste the JWT at https://jwt.io. Confirm:
   - `iss` is `639P4Q2VAB`
   - `sub` is `ca.cinemagraphs.web`
   - `aud` is `https://appleid.apple.com`
   - `exp` is approximately 6 months in the future
   - Header `kid` is `SCR59ABFVK`

3. **Update Vercel env var:**

   - Vercel dashboard → cinemagraphs project → Settings → Environment Variables
   - Find `APPLE_SECRET`
   - Click "..." → Edit
   - Replace the value with the new JWT
   - Save (apply to Production environment)

4. **Trigger a redeploy:**

   Either push a no-op commit, or in Vercel: Deployments → latest → "..." → Redeploy.

   Env var changes don't take effect until redeploy.

5. **Verify post-deploy:** see Post-rotation verification below.

## Procedure: Full key rotation (Scenario B)

1. **Generate a new key in Apple Developer portal:**

   - Go to https://developer.apple.com/account → Certificates, Identifiers & Profiles → Keys
   - Click the "+" button to create a new key
   - Name it (e.g., `Cinemagraphs Sign In Key 2026`)
   - Enable "Sign In with Apple"
   - Click "Configure" next to Sign In with Apple → choose the existing Primary App ID → Save
   - Click Continue → Register
   - Note the new Key ID (10-character alphanumeric)
   - Click Download. Apple lets you download the .p8 file ONCE.
   - Move the file to `~/Desktop/Cinemagraphs/AuthKey_<NEW_KEY_ID>.p8`
   - Update the encrypted Apple Notes backup with the new file contents

2. **Update `scripts/generate-apple-client-secret.mjs`:**

   Edit the `KEY_ID` constant to the new Key ID.

3. **Run Scenario A** with the new .p8 path.

4. **After confirming the new key works, revoke the old key:**

   Apple Developer portal → Keys → click the old key → Revoke.

   This is a one-way action. Do not revoke until the new key is confirmed working in production.

5. **Delete the old .p8 file** from local disk after revocation.

## Post-rotation verification

- [ ] Visit https://cinemagraphs.ca/auth/signin
- [ ] Click "Sign in with Apple"
- [ ] Complete the flow with a test account (or your own — Apple Sign In handles repeat sign-ins idempotently)
- [ ] Verify the user lands on the post-sign-in page successfully
- [ ] Check Vercel runtime logs for any `AppleProvider` errors in the 5 minutes following the test
- [ ] If using a fresh test account: confirm the User record was created in the database with `provider: 'apple'` in the linked Account table

## Rollback

If the new `APPLE_SECRET` breaks production sign-ins:

1. Vercel dashboard → Settings → Environment Variables → `APPLE_SECRET`
2. Click "..." → "Show Value History" (Vercel keeps recent values)
3. Restore the previous value
4. Redeploy

If Vercel's history doesn't have the previous value (unlikely but possible after long enough), and you've already revoked the old key in Apple, the only path forward is to roll forward — fix whatever was wrong with the new JWT and regenerate.

This is why **never revoke the old key until the new one is confirmed in production**.

## Important dates

- **Current APPLE_SECRET expires:** September 2026 (approximate; decode the current value at jwt.io to confirm exactly)
- **Recommended rotation window:** August 2026 (one month before expiry, leaves time for issues)
- **.p8 itself does not expire.** Apple keys persist until manually revoked.

## Related files

- `src/lib/auth.ts`: NextAuth AppleProvider config (uses APPLE_ID and APPLE_SECRET)
- `src/app/api/auth/mobile/apple/route.ts`: mobile Apple Sign In verification (uses APPLE_ID only, NOT affected by APPLE_SECRET expiry)
- `scripts/generate-apple-client-secret.mjs`: regen helper script
