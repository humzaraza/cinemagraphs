import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { sendFeedbackNotification } from '@/lib/email'
import { apiLogger } from '@/lib/logger'

const VALID_TYPES = ['bug', 'suggestion', 'support', 'other']

export async function POST(request: Request) {
  try {
    const session = await getServerSession(authOptions)
    const body = await request.json()

    const { type, message, page } = body as {
      type: string
      message: string
      page: string
    }

    if (!type || !VALID_TYPES.includes(type)) {
      return Response.json({ error: 'Invalid feedback type' }, { status: 400 })
    }
    if (!message || message.trim().length < 5) {
      return Response.json({ error: 'Message too short' }, { status: 400 })
    }
    if (!page) {
      return Response.json({ error: 'Page URL required' }, { status: 400 })
    }

    const feedback = await prisma.feedback.create({
      data: {
        userId: session?.user?.id ?? null,
        page,
        type,
        message: message.trim().slice(0, 5000),
      },
    })

    // Send email notification (non-blocking)
    sendFeedbackNotification({
      type,
      message: message.trim().slice(0, 5000),
      page,
      userName: session?.user?.name ?? null,
    }).catch((err) => {
      apiLogger.error({ err }, 'Failed to send feedback notification email')
    })

    return Response.json({ id: feedback.id })
  } catch (err) {
    apiLogger.error({ err }, 'Failed to save feedback')
    return Response.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}
