import { PrismaClient } from '../src/generated/prisma/client'
import { PrismaNeon } from '@prisma/adapter-neon'
import * as dotenv from 'dotenv'
dotenv.config({ path: '.env' })

async function main() {
  const adapter = new PrismaNeon({ connectionString: process.env.DATABASE_URL! })
  const prisma = new PrismaClient({ adapter })

  const email = 'cinemagraphs.corp@gmail.com'
  const user = await prisma.user.upsert({
    where: { email },
    update: { role: 'ADMIN' },
    create: { email, role: 'ADMIN' },
  })
  console.log(`✓ ${user.email} is now an admin (id: ${user.id})`)
  await prisma.$disconnect()
}

main().catch(console.error)
