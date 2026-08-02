import { NextAuthOptions } from 'next-auth'
import GoogleProvider from 'next-auth/providers/google'
import AppleProvider from 'next-auth/providers/apple'
import CredentialsProvider from 'next-auth/providers/credentials'
import { PrismaAdapter } from '@auth/prisma-adapter'
import bcrypt from 'bcrypt'
import { prisma } from './prisma'
import { apiLogger } from './logger'
import { serializeAuthError } from './auth-error'
import { TERMS_VERSION } from '@/lib/legal/terms-version'
import type { Adapter } from 'next-auth/adapters'

export const authOptions: NextAuthOptions = {
  debug: process.env.NODE_ENV !== 'production',
  logger: {
    // NextAuth v4 wraps provider failures in UnknownError, whose toJSON()
    // returns only { name, message } — and for OAuth callback failures the
    // message is usually ''. Spreading `metadata` straight into pino
    // therefore logged `error: { name: 'OAuthCallbackError', message: '' }`
    // and threw away every field that says what actually went wrong.
    //
    // serializeAuthError pulls out the preserved original stack plus the
    // openid-client fields (error, error_description, response.body) that
    // carry the provider's real answer, e.g. invalid_client. Token-bearing
    // fields are redacted by the logger's redact config.
    error(code, metadata) {
      const { error, ...rest } = (metadata ?? {}) as Record<string, unknown>
      apiLogger.error({ code, ...rest, err: serializeAuthError(error) }, 'NextAuth error')
    },
    warn(code) {
      apiLogger.warn({ code }, 'NextAuth warning')
    },
  },
  adapter: PrismaAdapter(prisma) as Adapter,
  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    }),
    AppleProvider({
      clientId: process.env.APPLE_ID!,
      clientSecret: process.env.APPLE_SECRET!,
    }),
    CredentialsProvider({
      name: 'Email',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) return null

        const user = await prisma.user.findUnique({
          where: { email: credentials.email.toLowerCase().trim() },
          select: { id: true, email: true, name: true, image: true, password: true, emailVerified: true },
        })

        if (!user?.password) return null
        if (!user.emailVerified) return null

        const valid = await bcrypt.compare(credentials.password, user.password)
        if (!valid) return null

        return { id: user.id, email: user.email, name: user.name, image: user.image }
      },
    }),
  ],
  // ---------------------------------------------------------------------
  // DO NOT change sameSite to 'lax' on the four OAuth-flow cookies below.
  //
  // Sign in with Apple uses response_mode=form_post: appleid.apple.com
  // returns the authorization result by auto-submitting an HTML form that
  // POSTs cross-site to /api/auth/callback/apple. SameSite=Lax cookies are
  // only sent on top-level navigations with *safe* methods (GET), so on a
  // cross-site POST the browser withholds them. NextAuth then finds no
  // state/nonce/PKCE cookie and throws OAuthCallbackError, which surfaces
  // as an endless redirect back to /auth/signin.
  //
  // Google is unaffected because it uses response_mode=query (a GET
  // redirect), which Lax permits — so this breakage looks provider-
  // specific and is easy to misdiagnose as an Apple credential problem.
  //
  // History: f8f3c1a (2026-03-28) set these to 'none' to fix exactly this
  // bug. 6c55529 (2026-05-10, "auth hardening") reverted them to 'lax',
  // silently re-breaking Apple sign-in for three months. Please leave the
  // comment attached to the code.
  //
  // csrfToken intentionally stays 'lax': NextAuth v4 only validates CSRF
  // on same-site POSTs to /api/auth/signin/:provider and /signout, never
  // on the OAuth callback, so it does not need to travel cross-site and
  // is safer scoped tightly.
  // ---------------------------------------------------------------------
  cookies: {
    pkceCodeVerifier: {
      name: '__Secure-next-auth.pkce.code_verifier',
      options: { httpOnly: true, sameSite: 'none', path: '/', secure: true },
    },
    state: {
      name: '__Secure-next-auth.state',
      options: { httpOnly: true, sameSite: 'none', path: '/', secure: true },
    },
    nonce: {
      name: '__Secure-next-auth.nonce',
      options: { httpOnly: true, sameSite: 'none', path: '/', secure: true },
    },
    callbackUrl: {
      name: '__Secure-next-auth.callback-url',
      options: { httpOnly: true, sameSite: 'none', path: '/', secure: true },
    },
    csrfToken: {
      name: '__Host-next-auth.csrf-token',
      options: { httpOnly: true, sameSite: 'lax', path: '/', secure: true },
    },
  },
  session: {
    strategy: 'jwt',
  },
  pages: {
    signIn: '/auth/signin',
  },
  events: {
    async signIn({ user, account }) {
      apiLogger.debug({ provider: account?.provider, userId: user?.id }, 'Sign-in event')
    },
    async createUser({ user }) {
      // Defensive: stamps terms acceptance on any user created via the
      // NextAuth adapter. As of PR N-WEB no account-creation path
      // actually routes through here (email/password and mobile OAuth
      // both bypass NextAuth). If a web OAuth UI is added later, this
      // hook ensures terms get stamped without separately wiring it in.
      await prisma.user.update({
        where: { id: user.id },
        data: {
          termsAcceptedAt: new Date(),
          termsVersion: TERMS_VERSION,
        },
      })
    },
  },
  callbacks: {
    async signIn({ user, account }) {
      apiLogger.debug({ provider: account?.provider, userId: user?.id }, 'signIn callback triggered')

      // Auto-link OAuth accounts to existing users with the same email
      if (account && account.provider !== 'credentials' && user?.email) {
        const existingUser = await prisma.user.findUnique({
          where: { email: user.email },
        })
        if (existingUser) {
          const existingAccount = await prisma.account.findUnique({
            where: {
              provider_providerAccountId: {
                provider: account.provider,
                providerAccountId: account.providerAccountId,
              },
            },
          })
          if (!existingAccount) {
            await prisma.account.create({
              data: {
                userId: existingUser.id,
                type: account.type,
                provider: account.provider,
                providerAccountId: account.providerAccountId,
                access_token: account.access_token as string | undefined,
                refresh_token: account.refresh_token as string | undefined,
                expires_at: account.expires_at as number | undefined,
                token_type: account.token_type as string | undefined,
                scope: account.scope as string | undefined,
                id_token: account.id_token as string | undefined,
              },
            })
            apiLogger.info({ provider: account.provider, userId: existingUser.id }, 'Linked OAuth account to existing user')
          }
        }
      }

      return true
    },
    async jwt({ token, user, account }) {
      // On initial sign-in, persist user id and fetch role
      if (user) {
        token.id = user.id
        const dbUser = await prisma.user.findUnique({
          where: { id: user.id },
          select: { role: true, name: true, email: true, image: true },
        })
        token.role = dbUser?.role || 'USER'
        if (dbUser?.name) token.name = dbUser.name
        if (dbUser?.image) token.picture = dbUser.image
      }
      // For OAuth providers, the adapter creates the user — get id from DB
      if (account && account.provider !== 'credentials' && token.email) {
        const dbUser = await prisma.user.findUnique({
          where: { email: token.email },
          select: { id: true, role: true, name: true, image: true },
        })
        if (dbUser) {
          token.id = dbUser.id
          token.role = dbUser.role
          if (dbUser.name) token.name = dbUser.name
          if (dbUser.image) token.picture = dbUser.image
        }
      }
      // On every token refresh, fetch latest name/image/role from DB
      if (token.id && !user && !account) {
        const dbUser = await prisma.user.findUnique({
          where: { id: token.id as string },
          select: { name: true, email: true, image: true, role: true },
        })
        if (dbUser) {
          token.name = dbUser.name || dbUser.email.split('@')[0]
          token.role = dbUser.role
          if (dbUser.image) token.picture = dbUser.image
        }
      }
      return token
    },
    async session({ session, token }) {
      if (session.user && token) {
        session.user.id = token.id as string
        session.user.role = (token.role as 'USER' | 'MODERATOR' | 'ADMIN' | 'BANNED') || 'USER'
        session.user.name = (token.name as string) || session.user.email?.split('@')[0] || null
        if (token.picture) session.user.image = token.picture as string
      }
      return session
    },
  },
}

declare module 'next-auth' {
  interface Session {
    user: {
      id: string
      role: 'USER' | 'MODERATOR' | 'ADMIN' | 'BANNED'
      name?: string | null
      email?: string | null
      image?: string | null
    }
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    id?: string
    role?: string
  }
}
