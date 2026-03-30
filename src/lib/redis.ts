import { Redis } from '@upstash/redis'

// Support both UPSTASH_REDIS_* (standard) and KV_REST_API_* (Vercel KV) env vars
const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL
const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN

export const redis = url && token ? new Redis({ url, token }) : null

export const REDIS_AVAILABLE = redis !== null
