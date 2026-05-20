// Gates `prisma migrate deploy` to VERCEL_ENV=production so Preview deploys never migrate the shared prod database.
import { execSync } from 'node:child_process'

function run(command) {
  try {
    execSync(command, { stdio: 'inherit' })
  } catch (error) {
    process.exit(typeof error.status === 'number' ? error.status : 1)
  }
}

const vercelEnv = process.env.VERCEL_ENV
const envLabel = vercelEnv ? `VERCEL_ENV=${vercelEnv}` : 'VERCEL_ENV unset'

if (vercelEnv === 'production') {
  console.log(`[build] running prisma migrate deploy (${envLabel})`)
  run('npx prisma migrate deploy')
} else {
  console.log(`[build] skipping prisma migrate deploy (${envLabel})`)
}

console.log('[build] running prisma generate')
run('npx prisma generate')

console.log('[build] running next build')
run('npx next build')
