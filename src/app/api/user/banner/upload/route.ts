import { NextResponse, type NextRequest } from 'next/server'
import { handleUpload, type HandleUploadBody } from '@vercel/blob/client'
import { getMobileOrServerSession } from '@/lib/mobile-auth'
import { apiLogger } from '@/lib/logger'

export async function POST(request: NextRequest) {
  let body: HandleUploadBody
  try {
    body = (await request.json()) as HandleUploadBody
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  try {
    const result = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname) => {
        const session = await getMobileOrServerSession()
        if (!session?.user?.id) {
          throw new Error('Authentication required')
        }
        const userId = session.user.id

        const expectedPrefix = `banners/${userId}/`
        if (!pathname.startsWith(expectedPrefix)) {
          throw new Error(`Banner upload pathname must start with '${expectedPrefix}'`)
        }

        return {
          allowedContentTypes: ['image/jpeg', 'image/png'],
          maximumSizeInBytes: 5 * 1024 * 1024,
          addRandomSuffix: true,
          tokenPayload: JSON.stringify({ userId }),
        }
      },
      onUploadCompleted: async ({ blob, tokenPayload }) => {
        let userId: string | null = null
        if (typeof tokenPayload === 'string' && tokenPayload.length > 0) {
          try {
            const parsed = JSON.parse(tokenPayload) as { userId?: unknown }
            if (typeof parsed?.userId === 'string') userId = parsed.userId
          } catch {
            // tokenPayload not valid JSON; leave userId null
          }
        }
        apiLogger.info(
          {
            userId,
            pathname: blob.pathname,
            contentType: blob.contentType,
            url: blob.url,
          },
          'Banner blob upload completed'
        )
      },
    })

    return NextResponse.json(result)
  } catch (err) {
    apiLogger.warn({ err }, 'Banner upload token issuance failed')
    const message = err instanceof Error ? err.message : 'Banner upload failed'
    const status = message === 'Authentication required' ? 401 : 400
    return NextResponse.json({ error: message }, { status })
  }
}
