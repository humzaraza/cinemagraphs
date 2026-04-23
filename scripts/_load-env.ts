/**
 * Side-effect module. Import this FIRST in any script under scripts/ that
 * touches the database or env vars.
 *
 * Why: ESM evaluates static imports in dependency order before the importing
 * module's body runs. Scripts that statically import from src/lib/* transitively
 * evaluate src/lib/prisma.ts, which calls createPrismaClient() at module load
 * and captures process.env.DATABASE_URL at that exact moment. If the env
 * hasn't been loaded from .env.local yet, the adapter captures undefined.
 *
 * This file loads .env.local as a side effect at module-evaluation time. By
 * importing it as the first import in every script, we guarantee env is in
 * place before any downstream module reads process.env.
 *
 * Convention: `import './_load-env'` must be the first line of any script
 * that touches the DB. The leading underscore signals "infrastructure,
 * not application logic" and sorts it to the top of directory listings.
 */
import { config } from 'dotenv'
config({ path: '.env.local' })
