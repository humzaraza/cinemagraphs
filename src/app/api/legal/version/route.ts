import { NextResponse } from 'next/server'
import { TERMS_VERSION } from '@/lib/legal/terms-version'

export const dynamic = 'force-static'

export async function GET() {
  return NextResponse.json({ version: TERMS_VERSION })
}
