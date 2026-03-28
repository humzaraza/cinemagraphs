import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { apiLogger } from '@/lib/logger'
import { writeFile, mkdir } from 'fs/promises'
import path from 'path'
import crypto from 'crypto'

export async function POST(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
    }

    const formData = await request.formData()
    const file = formData.get('file') as File | null

    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 })
    }

    // Validate type
    if (!['image/jpeg', 'image/png'].includes(file.type)) {
      return NextResponse.json({ error: 'Only JPG and PNG files are allowed.' }, { status: 400 })
    }

    // Validate size (2MB max)
    if (file.size > 2 * 1024 * 1024) {
      return NextResponse.json({ error: 'Image must be under 2MB.' }, { status: 400 })
    }

    const ext = file.type === 'image/png' ? '.png' : '.jpg'
    const filename = `avatar-${session.user.id}-${crypto.randomBytes(8).toString('hex')}${ext}`

    // Save to public/avatars
    const avatarDir = path.join(process.cwd(), 'public', 'avatars')
    await mkdir(avatarDir, { recursive: true })

    const buffer = Buffer.from(await file.arrayBuffer())
    await writeFile(path.join(avatarDir, filename), buffer)

    const url = `/avatars/${filename}`
    return NextResponse.json({ url })
  } catch (err) {
    apiLogger.error({ err }, 'Failed to upload avatar')
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}
