import { prisma } from '@/lib/prisma'
import type { UserRole } from '@/generated/prisma/client'

export interface UserIdentity {
  id: string
  email: string
  name: string | null
  image: string | null
  role: UserRole
}

/**
 * Finds a user by their primary email or any of their linked emails.
 * Used by OAuth and password-reset flows to handle Apple private-relay
 * addresses and other multi-email account scenarios.
 *
 * Primary email is checked first (uses unique index, fastest path).
 * Falls back to a scan of User.linkedEmails. The fallback is only
 * exercised once a future link flow populates linkedEmails; today it
 * is a no-op for all existing users.
 */
export async function findUserByAnyEmail(email: string): Promise<UserIdentity | null> {
  const emailLower = email.toLowerCase().trim()

  const primary = await prisma.user.findUnique({
    where: { email: emailLower },
    select: { id: true, email: true, name: true, image: true, role: true },
  })
  if (primary) return primary

  return prisma.user.findFirst({
    where: { linkedEmails: { has: emailLower } },
    select: { id: true, email: true, name: true, image: true, role: true },
  })
}
