import { NextAuthOptions } from 'next-auth'
import GoogleProvider from 'next-auth/providers/google'
import AppleProvider from 'next-auth/providers/apple'
import CredentialsProvider from 'next-auth/providers/credentials'
import { PrismaAdapter } from '@auth/prisma-adapter'
import bcrypt from 'bcrypt'
import { prisma } from './prisma'
import { apiLogger } from './logger'
import type { Adapter } from 'next-auth/adapters'

export const authOptions: NextAuthOptions = {
  debug: process.env.NODE_ENV !== 'production',
  logger: {
    error(code, metadata) {
      apiLogger.error({ code, ...metadata }, 'NextAuth error')
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
  cookies: {
    pkceCodeVerifier: {
      name: '__Secure-next-auth.pkce.code_verifier',
      options: { httpOnly: true, sameSite: 'lax', path: '/', secure: true },
    },
    state: {
      name: '__Secure-next-auth.state',
      options: { httpOnly: true, sameSite: 'lax', path: '/', secure: true },
    },
    nonce: {
      name: '__Secure-next-auth.nonce',
      options: { httpOnly: true, sameSite: 'lax', path: '/', secure: true },
    },
    callbackUrl: {
      name: '__Secure-next-auth.callback-url',
      options: { httpOnly: true, sameSite: 'lax', path: '/', secure: true },
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
    async signIn({ user, account, profile }) {
      apiLogger.info({ provider: account?.provider, userId: user?.id, email: user?.email, profile }, 'Sign-in event')
    },
  },
  callbacks: {
    async signIn({ user, account }) {
      apiLogger.info({ provider: account?.provider, userId: user?.id, email: user?.email }, 'signIn callback triggered')

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
            apiLogger.info({ provider: account.provider, email: user.email }, 'Linked OAuth account to existing user')
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
