import { prisma } from './prisma'
import { deleteAllUserBannerBlobs } from './banner-blob'
import { deleteAllUserAvatarBlobs } from './avatar-blob'

export async function deleteUserAndAllData(userId: string): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, linkedEmails: true },
  })
  if (!user) throw new Error('User not found')

  await Promise.allSettled([
    deleteAllUserBannerBlobs(userId),
    deleteAllUserAvatarBlobs(userId),
  ])

  const emails = [user.email, ...(user.linkedEmails ?? [])].filter(Boolean)

  await prisma.$transaction([
    prisma.verificationToken.deleteMany({ where: { identifier: { in: emails } } }),
    prisma.passwordResetToken.deleteMany({ where: { email: { in: emails } } }),
    prisma.feedback.deleteMany({ where: { userId } }),
    prisma.user.delete({ where: { id: userId } }),
  ])
}
