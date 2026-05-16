import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  prisma: {
    user: { findUnique: vi.fn(), delete: vi.fn() },
    verificationToken: { deleteMany: vi.fn() },
    passwordResetToken: { deleteMany: vi.fn() },
    feedback: { deleteMany: vi.fn() },
    $transaction: vi.fn(),
  },
  deleteAllUserBannerBlobs: vi.fn(),
  deleteAllUserAvatarBlobs: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({ prisma: mocks.prisma }))
vi.mock('@/lib/banner-blob', () => ({
  deleteAllUserBannerBlobs: mocks.deleteAllUserBannerBlobs,
}))
vi.mock('@/lib/avatar-blob', () => ({
  deleteAllUserAvatarBlobs: mocks.deleteAllUserAvatarBlobs,
}))

const USER_ID = 'user_to_delete'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.prisma.user.findUnique.mockResolvedValue({
    id: USER_ID,
    email: 'me@example.com',
    linkedEmails: ['alt@example.com'],
  })
  mocks.prisma.$transaction.mockResolvedValue([])
  mocks.deleteAllUserBannerBlobs.mockResolvedValue(undefined)
  mocks.deleteAllUserAvatarBlobs.mockResolvedValue(undefined)
})

describe('deleteUserAndAllData', () => {
  it('throws "User not found" when prisma.user.findUnique returns null', async () => {
    mocks.prisma.user.findUnique.mockResolvedValue(null)
    const { deleteUserAndAllData } = await import('@/lib/user-deletion')
    await expect(deleteUserAndAllData(USER_ID)).rejects.toThrow('User not found')
    expect(mocks.prisma.$transaction).not.toHaveBeenCalled()
    expect(mocks.deleteAllUserBannerBlobs).not.toHaveBeenCalled()
    expect(mocks.deleteAllUserAvatarBlobs).not.toHaveBeenCalled()
  })

  it('calls both blob helpers once with the userId', async () => {
    const { deleteUserAndAllData } = await import('@/lib/user-deletion')
    await deleteUserAndAllData(USER_ID)
    expect(mocks.deleteAllUserBannerBlobs).toHaveBeenCalledTimes(1)
    expect(mocks.deleteAllUserBannerBlobs).toHaveBeenCalledWith(USER_ID)
    expect(mocks.deleteAllUserAvatarBlobs).toHaveBeenCalledTimes(1)
    expect(mocks.deleteAllUserAvatarBlobs).toHaveBeenCalledWith(USER_ID)
  })

  it('invokes prisma.$transaction once with 4 ops in order: verificationToken, passwordResetToken, feedback, user.delete', async () => {
    const { deleteUserAndAllData } = await import('@/lib/user-deletion')
    await deleteUserAndAllData(USER_ID)
    expect(mocks.prisma.$transaction).toHaveBeenCalledTimes(1)
    const arg = mocks.prisma.$transaction.mock.calls[0][0]
    expect(Array.isArray(arg)).toBe(true)
    expect(arg).toHaveLength(4)

    const v = mocks.prisma.verificationToken.deleteMany.mock.invocationCallOrder[0]
    const p = mocks.prisma.passwordResetToken.deleteMany.mock.invocationCallOrder[0]
    const f = mocks.prisma.feedback.deleteMany.mock.invocationCallOrder[0]
    const u = mocks.prisma.user.delete.mock.invocationCallOrder[0]
    expect(v).toBeLessThan(p)
    expect(p).toBeLessThan(f)
    expect(f).toBeLessThan(u)
  })

  it('cleans verification and password-reset tokens using user.email and linkedEmails', async () => {
    const { deleteUserAndAllData } = await import('@/lib/user-deletion')
    await deleteUserAndAllData(USER_ID)
    expect(mocks.prisma.verificationToken.deleteMany).toHaveBeenCalledWith({
      where: { identifier: { in: ['me@example.com', 'alt@example.com'] } },
    })
    expect(mocks.prisma.passwordResetToken.deleteMany).toHaveBeenCalledWith({
      where: { email: { in: ['me@example.com', 'alt@example.com'] } },
    })
  })

  it('handles null linkedEmails without crashing; emails contains only user.email', async () => {
    mocks.prisma.user.findUnique.mockResolvedValue({
      id: USER_ID,
      email: 'solo@example.com',
      linkedEmails: null,
    })
    const { deleteUserAndAllData } = await import('@/lib/user-deletion')
    await deleteUserAndAllData(USER_ID)
    expect(mocks.prisma.verificationToken.deleteMany).toHaveBeenCalledWith({
      where: { identifier: { in: ['solo@example.com'] } },
    })
    expect(mocks.prisma.passwordResetToken.deleteMany).toHaveBeenCalledWith({
      where: { email: { in: ['solo@example.com'] } },
    })
  })

  it('completes successfully when deleteAllUserBannerBlobs rejects (Promise.allSettled safety)', async () => {
    mocks.deleteAllUserBannerBlobs.mockRejectedValue(new Error('blob outage'))
    const { deleteUserAndAllData } = await import('@/lib/user-deletion')
    await expect(deleteUserAndAllData(USER_ID)).resolves.toBeUndefined()
    expect(mocks.prisma.$transaction).toHaveBeenCalledTimes(1)
  })
})
