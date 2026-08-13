import { PostgrestClient } from "@supabase/postgrest-js";

// The publishable (anon) key grants public-read access under RLS: the full
// bottle catalog and community tasting reviews. The service-role key, when
// provided, additionally unlocks live trending data (cellar adds are
// user-scoped rows the anon key cannot aggregate). Either works; nothing in
// this server ever writes except telemetry to a write-only log table.
const PUBLISHABLE_URL = "https://nqnigdqkcvrziwcbgily.supabase.co";
const PUBLISHABLE_KEY = "sb_publishable_UpINaQssccF9gF-PNo0ZwA_Ult0KxoF";

// Configuration comes ONLY from explicit environment variables. This package
// deliberately does NOT read .env files: a published npm package that scans
// the host project's filesystem for credentials is a supply-chain hazard —
// it could silently pick up an unrelated project's service key and send it
// to the wrong server. (Versions <=1.0.1 had that bug; deprecated.)
export const SUPABASE_URL = process.env.SUPABASE_URL || PUBLISHABLE_URL;

const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const key =
  serviceKey ||
  process.env.SUPABASE_ANON_KEY ||
  process.env.SUPABASE_KEY ||
  PUBLISHABLE_KEY;

export const hasServiceKey = Boolean(serviceKey);

// PostgREST-only client: no realtime, no auth, no storage — and structurally
// read-only from this server (every query path issues SELECTs only; the one
// write is telemetry to the insert-only mcp_call_logs table).
export const supabase = new PostgrestClient(`${SUPABASE_URL}/rest/v1`, {
  headers: { apikey: key, Authorization: `Bearer ${key}` },
});

// --- Rate limiting -----------------------------------------------------------
// Sliding one-minute window. An MCP server serves a single client over stdio,
// so this is a guard against a runaway agent loop, not multi-tenant fairness.
const WINDOW_MS = 60_000;
const MAX_CALLS_PER_WINDOW = 60;
const callTimes: number[] = [];

export function checkRateLimit(): void {
  const now = Date.now();
  while (callTimes.length && callTimes[0] < now - WINDOW_MS) callTimes.shift();
  if (callTimes.length >= MAX_CALLS_PER_WINDOW) {
    throw new Error(
      `Rate limit exceeded (${MAX_CALLS_PER_WINDOW} calls/minute). Wait a moment and retry.`
    );
  }
  callTimes.push(now);
}
