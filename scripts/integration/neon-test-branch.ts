/**
 * Neon test-branch lifecycle helpers for integration tests.
 *
 * Every caller MUST wrap createTestBranch in try/finally with deleteTestBranch
 * in the finally block:
 *
 *   const { branchId, databaseUrl } = await createTestBranch({ testName: '...' })
 *   try {
 *     // ... run tests ...
 *   } finally {
 *     await deleteTestBranch(branchId)
 *   }
 *
 * If branch creation or seeding fails partway through, createTestBranch will
 * attempt to delete the branch it created before throwing, so callers never
 * need to worry about orphaned branches from creation-path failures.
 */

import { spawn } from 'node:child_process'

const NEON_API_BASE = 'https://console.neon.tech/api/v2'
const ENDPOINT_READY_TIMEOUT_MS = 30_000
const ENDPOINT_POLL_INTERVAL_MS = 1_000

interface NeonBranch {
  id: string
  name: string
  current_state?: string
  primary?: boolean
  default?: boolean
}

interface NeonEndpoint {
  id: string
  host: string
  branch_id: string
  current_state?: string
  type?: string
}

interface CreateBranchResponse {
  branch: NeonBranch
  endpoints?: NeonEndpoint[]
  connection_uris?: Array<{ connection_uri: string }>
}

interface GetBranchResponse {
  branch: NeonBranch
}

interface ListEndpointsResponse {
  endpoints: NeonEndpoint[]
}

export interface CreateTestBranchResult {
  branchId: string
  branchName: string
  databaseUrl: string
}

function getNeonConfig() {
  const apiKey = process.env.NEON_API_KEY
  const orgId = process.env.NEON_ORG_ID
  const projectId = process.env.NEON_PROJECT_ID ?? 'proud-waterfall-42755951'
  if (!apiKey) {
    throw new Error('NEON_API_KEY env var is required for integration tests')
  }
  if (!orgId) {
    throw new Error('NEON_ORG_ID env var is required for integration tests')
  }
  return { apiKey, orgId, projectId }
}

async function neonFetch(
  path: string,
  options: { method?: string; body?: unknown; apiKey: string }
): Promise<Response> {
  const res = await fetch(`${NEON_API_BASE}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  })
  return res
}

async function readJson<T>(res: Response, context: string): Promise<T> {
  const text = await res.text()
  if (!res.ok) {
    throw new Error(
      `Neon API ${context} failed: ${res.status} ${res.statusText} — ${text}`
    )
  }
  try {
    return JSON.parse(text) as T
  } catch (err) {
    throw new Error(
      `Neon API ${context} returned non-JSON (status ${res.status}): ${text.slice(0, 500)}`
    )
  }
}

async function findPrimaryBranchId(apiKey: string, projectId: string): Promise<string> {
  const res = await neonFetch(`/projects/${projectId}/branches`, { apiKey })
  const data = await readJson<{ branches: NeonBranch[] }>(res, 'list branches')
  const primary = data.branches.find((b) => b.primary) ?? data.branches.find((b) => b.default)
  if (!primary) {
    throw new Error('No primary branch found in Neon project')
  }
  return primary.id
}

async function waitForEndpointReady(
  apiKey: string,
  projectId: string,
  branchId: string
): Promise<void> {
  const deadline = Date.now() + ENDPOINT_READY_TIMEOUT_MS
  let lastBranchState: string | undefined
  let lastEndpointState: string | undefined
  while (Date.now() < deadline) {
    const branchRes = await neonFetch(`/projects/${projectId}/branches/${branchId}`, {
      apiKey,
    })
    const endpointsRes = await neonFetch(
      `/projects/${projectId}/branches/${branchId}/endpoints`,
      { apiKey }
    )
    if (branchRes.ok && endpointsRes.ok) {
      const branchData = await readJson<GetBranchResponse>(branchRes, 'get branch')
      const endpointsData = await readJson<ListEndpointsResponse>(
        endpointsRes,
        'list branch endpoints'
      )
      const endpoint = endpointsData.endpoints[0]
      lastBranchState = branchData.branch.current_state
      lastEndpointState = endpoint?.current_state
      if (
        lastBranchState === 'ready' &&
        (lastEndpointState === 'idle' || lastEndpointState === 'active')
      ) {
        return
      }
    }
    await new Promise((r) => setTimeout(r, ENDPOINT_POLL_INTERVAL_MS))
  }
  throw new Error(
    `Timed out after ${ENDPOINT_READY_TIMEOUT_MS}ms waiting for branch ${branchId} ` +
      `(last branch=${lastBranchState ?? 'unknown'} endpoint=${lastEndpointState ?? 'unknown'})`
  )
}

async function fetchConnectionUri(
  apiKey: string,
  projectId: string,
  branchId: string
): Promise<string> {
  const params = new URLSearchParams({
    branch_id: branchId,
    database_name: 'neondb',
    role_name: 'neondb_owner',
    pooled: 'true',
  })
  const res = await neonFetch(`/projects/${projectId}/connection_uri?${params.toString()}`, {
    apiKey,
  })
  const data = await readJson<{ uri: string }>(res, 'get connection_uri')
  if (!data.uri) {
    throw new Error(`Neon connection_uri response missing 'uri' field: ${JSON.stringify(data)}`)
  }
  return data.uri
}

/**
 * Syncs the Prisma schema onto the test branch. We use `prisma db push`
 * rather than `migrate deploy` because a Neon branch is a snapshot of
 * production's schema — running `migrate deploy` fails when production's
 * `_prisma_migrations` table is out of sync with its actual schema (the
 * branch inherits both the tables and the history, and `migrate deploy`
 * then tries to re-create a table that already exists). `db push` is
 * idempotent: if the schema already matches (the common case for a fresh
 * branch) it's a no-op; if the prisma schema has drifted ahead it applies
 * the diff. Perfect for ephemeral test branches.
 */
function runDbPush(databaseUrl: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'npx',
      ['prisma', 'db', 'push', '--accept-data-loss'],
      {
        env: { ...process.env, DATABASE_URL: databaseUrl },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    )
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => {
      stdout += d.toString()
    })
    child.stderr.on('data', (d) => {
      stderr += d.toString()
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) {
        resolve()
      } else {
        reject(
          new Error(
            `prisma db push failed with exit code ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`
          )
        )
      }
    })
  })
}

export async function createTestBranch(options: {
  testName: string
}): Promise<CreateTestBranchResult> {
  const { apiKey, projectId } = getNeonConfig()
  const branchName = `test-3b3-${options.testName}-${Date.now()}`

  const parentId = await findPrimaryBranchId(apiKey, projectId)

  const createRes = await neonFetch(`/projects/${projectId}/branches`, {
    method: 'POST',
    apiKey,
    body: {
      branch: { name: branchName, parent_id: parentId },
      endpoints: [{ type: 'read_write' }],
    },
  })
  const createData = await readJson<CreateBranchResponse>(createRes, 'create branch')
  const branchId = createData.branch.id

  try {
    await waitForEndpointReady(apiKey, projectId, branchId)
    const databaseUrl = await fetchConnectionUri(apiKey, projectId, branchId)
    await runDbPush(databaseUrl)
    return { branchId, branchName, databaseUrl }
  } catch (err) {
    await deleteTestBranch(branchId).catch((cleanupErr) => {
      console.error(
        `[neon-test-branch] Failed to clean up branch ${branchId} after setup error:`,
        cleanupErr
      )
    })
    throw err
  }
}

export async function deleteTestBranch(branchId: string): Promise<void> {
  try {
    const { apiKey, projectId } = getNeonConfig()
    const res = await neonFetch(`/projects/${projectId}/branches/${branchId}`, {
      method: 'DELETE',
      apiKey,
    })
    if (!res.ok) {
      const text = await res.text()
      console.error(
        `[neon-test-branch] Failed to delete branch ${branchId}: ${res.status} ${res.statusText} — ${text}`
      )
    }
  } catch (err) {
    console.error(`[neon-test-branch] Error while deleting branch ${branchId}:`, err)
  }
}
