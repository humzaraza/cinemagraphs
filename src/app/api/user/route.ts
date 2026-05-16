import { NextResponse } from 'next/server'
import { getMobileOrServerSession } from '@/lib/mobile-auth'
import { checkRateLimit } from '@/lib/rate-limit'
import { deleteUserAndAllData } from '@/lib/user-deletion'
import { apiLogger } from '@/lib/logger'

export async function DELETE() {
  let userId: string | undefined
  try {
    const session = await getMobileOrServerSession()
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
    }
    userId = session.user.id

    const { limited } = await checkRateLimit('account-delete', userId, 5, 60 * 60 * 1000)
    if (limited) {
      return NextResponse.json(
        { error: 'Too many attempts. Please try again later.' },
        { status: 429 }
      )
    }

    await deleteUserAndAllData(userId)

    apiLogger.info({ userId }, 'User account deleted via self-delete endpoint')

    return NextResponse.json({ message: 'Account deleted' })
  } catch (err) {
    apiLogger.error({ err, userId }, 'Failed to delete account')
    return NextResponse.json({ error: 'Failed to delete account' }, { status: 500 })
  }
}
