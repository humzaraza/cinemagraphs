import './_load-env'
import { neon } from '@neondatabase/serverless'

const sql = neon(process.env.DATABASE_URL!)

async function main() {
  try {
    await sql`ALTER TYPE "ReviewSource" ADD VALUE IF NOT EXISTS 'LETTERBOXD'`
    console.log('Added LETTERBOXD to ReviewSource enum')
  } catch (err: any) {
    if (err.message?.includes('already exists')) {
      console.log('LETTERBOXD already exists in enum')
    } else {
      throw err
    }
  }
}

main()
