import { PostgrestClient } from "@supabase/postgrest-js";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// The publishable (anon) key grants public-read access under RLS: the full
// bottle catalog and community tasting reviews. The service-role key, when
// provided, additionally unlocks live trending data (cellar adds are
// user-scoped rows the anon key cannot aggregate). Either works; nothing in
// this server ever writes.
const PUBLISHABLE_URL = "https://nqnigdqkcvrziwcbgily.supabase.co";
const PUBLISHABLE_KEY = "sb_publishable_UpINaQssccF9gF-PNo0ZwA_Ult0KxoF";

function loadEnvLocal(): Record<string, string> {
  // Dev convenience: when run from inside the pour-picks repo, pick up the
  // app's .env.local so no extra configuration is needed.
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [
    resolve(here, "../../.env.local"),
    resolve(here, "../../../.env.local"),
  ]) {
    try {
      const out: Record<string, string> = {};
      for (const line of readFileSync(candidate, "utf8").split("\n")) {
        const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
        if (m) out[m[1]] = m[2];
      }
      return out;
    } catch {
      /* keep looking */
    }
  }
  return {};
}

const envFile = loadEnvLocal();

export const SUPABASE_URL =
  process.env.SUPABASE_URL || envFile.SUPABASE_URL || PUBLISHABLE_URL;

const serviceKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY || envFile.SUPABASE_SERVICE_ROLE_KEY;

const key =
  serviceKey ||
  process.env.SUPABASE_ANON_KEY ||
  process.env.SUPABASE_KEY ||
  PUBLISHABLE_KEY;

export const hasServiceKey = Boolean(serviceKey);

// PostgREST-only client: no realtime, no auth, no storage — and structurally
// read-only from this server (every query path issues SELECTs only).
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
