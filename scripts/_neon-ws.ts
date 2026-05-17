/**
 * Side-effect module. Import this BEFORE any module that pulls in
 * `@prisma/adapter-neon` (which is everything that constructs a PrismaClient
 * via the Neon adapter in scripts/).
 *
 * Why: @neondatabase/serverless needs a WebSocket constructor. The Vercel
 * runtime provides one globally; local Node does not. Without this, the
 * scripts fail at first query with "All attempts to open a WebSocket to
 * connect to the database failed."
 *
 * Convention: pair this with `_load-env` as the first two imports in any
 * script under scripts/ that talks to the database:
 *   import './_load-env'
 *   import './_neon-ws'
 *   // ...prisma imports follow
 */
import { neonConfig } from '@neondatabase/serverless'
import ws from 'ws'

if (typeof WebSocket === 'undefined') {
  // `ws` does not exactly match the browser WebSocket interface but is
  // functionally compatible for what the Neon serverless driver uses.
  neonConfig.webSocketConstructor = ws as unknown as typeof WebSocket
}
