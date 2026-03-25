import { getServerSession } from 'next-auth'
import { authOptions } from './auth'
import type { UserRole } from '@/generated/prisma/client'

export interface AuthResult {
  authorized: boolean
  session: Awaited<ReturnType<typeof getServerSession>> | null
  errorResponse?: Response
}

/**
 * Check if the current user has at least the required role.
 * Role hierarchy: ADMIN > MODERATOR > USER > BANNED
 */
export async function requireRole(requiredRole: UserRole): Promise<AuthResult> {
  const session = await getServerSession(authOptions)

  if (!session?.user) {
    return {
      authorized: false,
      session: null,
      errorResponse: Response.json(
        { error: 'Authentication required', code: 'UNAUTHORIZED' },
        { status: 401 }
      ),
    }
  }

  const roleHierarchy: Record<string, number> = {
    BANNED: 0,
    USER: 1,
    MODERATOR: 2,
    ADMIN: 3,
  }

  const userLevel = roleHierarchy[session.user.role] ?? 0
  const requiredLevel = roleHierarchy[requiredRole] ?? 0

  if (userLevel < requiredLevel) {
    return {
      authorized: false,
      session,
      errorResponse: Response.json(
        { error: 'Insufficient permissions', code: 'FORBIDDEN' },
        { status: 403 }
      ),
    }
  }

  // BANNED users can only view, never submit content
  if (session.user.role === 'BANNED' && requiredRole !== 'BANNED') {
    return {
      authorized: false,
      session,
      errorResponse: Response.json(
        { error: 'Account suspended', code: 'BANNED' },
        { status: 403 }
      ),
    }
  }

  return { authorized: true, session }
}

/**
 * Quick check: is the user an admin?
 */
export async function requireAdmin(): Promise<AuthResult> {
  return requireRole('ADMIN' as UserRole)
}

/**
 * Quick check: is the user at least a moderator?
 */
export async function requireModerator(): Promise<AuthResult> {
  return requireRole('MODERATOR' as UserRole)
}

/**
 * Quick check: is the user authenticated and not banned?
 */
export async function requireUser(): Promise<AuthResult> {
  return requireRole('USER' as UserRole)
}
