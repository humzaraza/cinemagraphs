# Apple Sign In Key Rotation

## Overview

The web Apple Sign In client secret is **minted at request time** from the .p8 private key. There is no six-month JWT to regenerate and no expiry deadline to track.

This document covers that setup, the legacy static-JWT fallback it replaced, and rotating the underlying .p8 when needed.

## Current configuration

| Field | Value |
|-------|-------|
| Key ID | `SCR59ABFVK` |
| Team ID | `639P4Q2VAB` |
| Services ID (clientID) | `ca.cinemagraphs.web` |
| Bundle ID (mobile) | `ca.cinemagraphs.app` |
| .p8 file location | `~/Desktop/Cinemagraphs/AuthKey_SCR59ABFVK.p8` |
| Encrypted backup | Apple Notes (iCloud sync) |
| `APPLE_PRIVATE_KEY` | base64-encoded .p8 — the live mechanism |
| `APPLE_SECRET` | pre-signed JWT — fallback only, used when `APPLE_PRIVATE_KEY` is unset |

## How the client secret works

Apple has no fixed client secret. The `client_secret` sent to their token endpoint is an ES256 JWT signed with the .p8, carrying:

- `iss`: Team ID (`639P4Q2VAB`)
- `iat` / `exp`: issued-at and expiry (Apple caps `exp` at 6 months out)
- `aud`: `https://appleid.apple.com`
- `sub`: Services ID (`ca.cinemagraphs.web`)
- Header `kid`: Key ID (`SCR59ABFVK`)

`src/lib/apple-client-secret.ts` signs one of these on demand with a **30-minute** lifetime, cached in module memory and re-signed once it is within 5 minutes of expiring.

The hook is a getter in `src/lib/auth.ts`:

```ts
AppleProvider({
  clientId: process.env.APPLE_ID!,
  get clientSecret(): string {
    return resolveAppleClientSecret()
  },
})
```

NextAuth v4's `AuthHandler` calls `init()` on every request, and `parseProviders()` runs `Object.entries()` over the provider options — which evaluates getters. So this resolves per auth request rather than being frozen at module load, and correctness does not depend on how long a serverless instance survives.

**Fallback is automatic.** If `APPLE_PRIVATE_KEY` is unset, or the key fails to parse or sign, `resolveAppleClientSecret()` logs and returns `APPLE_SECRET`. It never throws — it runs inside NextAuth's provider parsing, where an exception would become an opaque 500 on every auth route.

**Mobile flow does not use either variable.** `/api/auth/mobile/apple` only verifies inbound identity tokens via `appleSignin.verifyIdToken`. Nothing here affects mobile sign-in.

## One-time setup (already done — recorded for a rebuild)

1. Base64-encode the .p8 (avoids newline mangling in dashboard fields):

   ```bash
   base64 -i ~/Desktop/Cinemagraphs/AuthKey_SCR59ABFVK.p8 | tr -d '\n' | pbcopy
   ```

2. Vercel → cinemagraphs → Settings → Environment Variables → Add:
   - `APPLE_PRIVATE_KEY` = the base64 string, marked **Sensitive**, Production (add Preview too if testing Apple sign-in there)
   - Optionally `APPLE_TEAM_ID` and `APPLE_KEY_ID` — both default to the values in the table above if unset

3. Leave `APPLE_SECRET` in place as the fallback until the new path is confirmed working.

4. Redeploy. Env var changes do not affect existing deployments.

5. Verify (below), then optionally delete `APPLE_SECRET`.

## Rotating the .p8 (security event, or Apple key expiry)

Regenerating the client secret JWT is no longer a scenario — it happens automatically. Only the .p8 itself is ever rotated.

1. Apple Developer portal → Certificates, Identifiers & Profiles → Keys → "+"
2. Name it, enable "Sign In with Apple", Configure → select the existing Primary App ID → Save → Continue → Register
3. Note the new Key ID. Download the .p8 — **Apple allows this once.**
4. Store at `~/Desktop/Cinemagraphs/AuthKey_<NEW_KEY_ID>.p8` and update the encrypted Apple Notes backup
5. In Vercel, update **both**:
   - `APPLE_PRIVATE_KEY` = base64 of the new .p8
   - `APPLE_KEY_ID` = the new Key ID

   These must change together — the `kid` header must match the key that signed the token, or Apple returns `invalid_client`.
6. Redeploy, then verify below
7. Only after confirming production works: Apple portal → Keys → old key → Revoke. This is one-way.
8. Delete the old .p8 from local disk

## Verification

- [ ] https://cinemagraphs.ca/auth/signin → "Sign in with Apple" → complete the flow
- [ ] Lands signed in, not back on the sign-in page
- [ ] Vercel logs, filter `callback/apple`: the entry should be a `302` with an **empty** Messages column. Any `{"level":"error"...}` payload means it failed — expand it for `err.error`, `err.error_description`, and the provider response body.
- [ ] Fresh test account: confirm the `Account` row was created with `provider: 'apple'`

## Rollback

Delete `APPLE_PRIVATE_KEY` in Vercel and redeploy. The provider falls straight back to `APPLE_SECRET`. That is the entire procedure — which is why `APPLE_SECRET` should be kept populated with a valid JWT even though it is unused.

If `APPLE_SECRET` has since expired and the key path is broken, regenerate a static JWT with `scripts/generate-apple-client-secret.mjs` (see its header) and paste it in.

## Do not break this again

Two failure modes have taken Apple sign-in down. Both were invisible in the logs at the time.

**1. Cookie SameSite (May 10 → Aug 2, 2026 — ~3 months of outage).**

Apple uses `response_mode=form_post`: `appleid.apple.com` auto-submits a form that POSTs **cross-site** to `/api/auth/callback/apple`. Browsers withhold `SameSite=Lax` cookies on cross-site POSTs, so the state/nonce/PKCE cookies never arrive and NextAuth throws `OAuthCallbackError`. Google is unaffected because it uses `response_mode=query`, a GET redirect — which makes the breakage look Apple-specific and invites misdiagnosis as a credential problem.

`f8f3c1a` set those cookies to `sameSite: 'none'` to fix it. `6c55529` ("auth hardening") reverted them to `'lax'` and silently re-broke it. `src/__tests__/apple-signin-cookies.test.ts` now asserts this; do not delete it.

**2. Empty error logs.**

NextAuth v4 wraps provider errors in `UnknownError`, whose `toJSON()` returns only `{ name, message }` — and `message` is `''` for callback failures. Logging the `metadata` object directly produced records that named the error and said nothing else, which is why the cookie bug survived three months. `src/lib/auth-error.ts` unwraps the preserved stack and the openid-client fields; the logger config uses it.

## Related files

- `src/lib/apple-client-secret.ts` — runtime minting, caching, fallback
- `src/lib/auth.ts` — AppleProvider config, cookie SameSite policy, NextAuth error logger
- `src/lib/auth-error.ts` — error unwrapping so failures are diagnosable
- `src/app/api/auth/mobile/apple/route.ts` — mobile verification, unaffected by any of the above
- `scripts/generate-apple-client-secret.mjs` — static JWT generator, fallback path only
- `src/__tests__/apple-client-secret.test.ts`, `src/__tests__/apple-signin-cookies.test.ts` — regression cover
