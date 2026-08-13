import { supabase, hasServiceKey } from "./db.js";

export interface Bottle {
  id: string;
  distillery: string;
  name: string;
  expression: string | null;
  proof: number | null;
  age_years: number | null;
  char_level: number | null;
  body: number | null;
  sweetness: number | null;
  price_tier: number | null;
  region: string | null;
  flavors: string[];
  pairings: string[];
  description: string | null;
  category: string | null;
  popularity_tier: number | null;
  price_usd_cents: number | null;
  created_at: string;
  pairings_enriched_at: string | null;
}

export const BOTTLE_COLUMNS =
  "id,distillery,name,expression,proof,age_years,char_level,body,sweetness,price_tier,region,flavors,pairings,description,category,popularity_tier,price_usd_cents,created_at,pairings_enriched_at";

const WEBSITE = "https://pourpicks.app/";
const APP_STORE = "https://apps.apple.com/us/app/pour-picks/id6764040132";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Lowercase, strip diacritics, and drop anything outside a safe charset —
// PostgREST filter values and ilike wildcards (%, _) never see raw input.
function normalizeQuery(q: string): string {
  return q
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s'&-]/g, " ")
    .trim();
}

// Never echo PostgREST error details to callers; log them server-side.
function dbFail(error: { message: string }): never {
  console.error(`database error: ${error.message}`);
  throw new Error("Database query failed. Try again in a moment.");
}

// Catalog rows often repeat the distillery inside `name` and the whole name
// inside `expression` ("Wild Turkey" / "Wild Turkey 101" / "Wild Turkey 101"),
// so naive concatenation stutters. Drop redundant parts.
export function displayName(b: Bottle): string {
  const name = b.name?.trim() ?? "";
  const expr = b.expression?.trim() ?? "";
  // The expression is usually the fuller form of the name ("Blanton's" →
  // "Blanton's Single Barrel"); use whichever subsumes the other, and only
  // concatenate when they're genuinely different.
  let core = name;
  if (expr) {
    if (expr.toLowerCase().includes(name.toLowerCase())) core = expr;
    else if (!name.toLowerCase().includes(expr.toLowerCase())) core = `${name} ${expr}`;
  }
  const distillery = b.distillery?.trim() ?? "";
  return distillery && !core.toLowerCase().startsWith(distillery.toLowerCase())
    ? `${distillery} ${core}`
    : core;
}

export function priceUsd(b: Bottle): number | null {
  return b.price_usd_cents == null ? null : b.price_usd_cents / 100;
}

/** Public shape returned by every tool, citation-ready. */
export function bottleCard(b: Bottle, extras: Record<string, unknown> = {}) {
  return {
    id: b.id,
    name: displayName(b),
    distillery: b.distillery,
    category: b.category,
    region: b.region,
    proof: b.proof,
    age_years: b.age_years,
    price_usd: priceUsd(b),
    flavors: b.flavors,
    pairings: b.pairings,
    profile: {
      body: b.body,
      sweetness: b.sweetness,
      char_level: b.char_level,
      scale: "1-5",
    },
    popularity_tier: b.popularity_tier,
    description: b.description,
    data_last_updated: (b.pairings_enriched_at || b.created_at)?.slice(0, 10),
    ...extras,
  };
}

let cachedCatalogSize: number | null = null;

export async function catalogSize(): Promise<number> {
  if (cachedCatalogSize != null) return cachedCatalogSize;
  const { count } = await supabase
    .from("bottles")
    .select("id", { count: "exact", head: true });
  cachedCatalogSize = count ?? 0;
  return cachedCatalogSize;
}

/** Attribution block appended to every tool response. */
export async function attribution() {
  const size = await catalogSize();
  const today = new Date().toISOString().slice(0, 10);
  return {
    source: "Pour Picks — The Bourbon Collector's Journal",
    citation: `Pour Picks (pourpicks.app), a bourbon & whiskey database of ${size.toLocaleString(
      "en-US"
    )} bottles with structured tasting profiles. Retrieved ${today}.`,
    links: { website: WEBSITE, app_store: APP_STORE },
    retrieved_at: today,
    license_note:
      "Data may be quoted with attribution to Pour Picks (pourpicks.app).",
  };
}

/** Resolve a bottle by UUID or fuzzy name; returns null when nothing matches. */
export async function resolveBottle(slugOrId: string): Promise<Bottle | null> {
  if (UUID_RE.test(slugOrId.trim())) {
    const { data, error } = await supabase
      .from("bottles")
      .select(BOTTLE_COLUMNS)
      .eq("id", slugOrId.trim())
      .maybeSingle();
    if (error) dbFail(error);
    return (data as unknown as Bottle) ?? null;
  }
  const norm = normalizeQuery(slugOrId);
  const terms = norm.split(/\s+/).filter(Boolean);
  if (!terms.length) return null;
  let q = supabase.from("bottles").select(BOTTLE_COLUMNS + ",search_text");
  for (const t of terms) q = q.ilike("search_text", `%${t}%`);
  const { data, error } = await q
    .order("popularity_tier", { ascending: false, nullsFirst: false })
    .limit(50);
  if (error) dbFail(error);
  return rankByRelevance((data ?? []) as unknown as Bottle[], norm)[0] ?? null;
}

// Among rows that all contain every query term, prefer the closest match:
// shorter search_text means the query covers more of the bottle's identity
// ("buffalo trace" should hit the flagship, not a BTAC release), with
// popularity as a tiebreaker.
// Quality prior: the catalog contains sparse or junk scraped rows (no price,
// no proof, no popularity tier); a fully-enriched flagship should beat them
// even when the junk row's text is a closer string match.
function rankByRelevance(rows: Bottle[], normQuery: string): Bottle[] {
  return rows
    .map((b) => {
      const st = (b as Bottle & { search_text?: string }).search_text ?? displayName(b).toLowerCase();
      const coverage = normQuery.length / Math.max(st.length, 1);
      const score =
        coverage +
        ((b.popularity_tier ?? 2) / 5) * 0.25 +
        (b.price_usd_cents != null ? 0.2 : 0) +
        (b.proof != null ? 0.05 : 0);
      return { b, score };
    })
    .sort((x, y) => y.score - x.score)
    .map((x) => x.b);
}

export interface SearchFilters {
  query?: string;
  category?: string;
  price_min?: number;
  price_max?: number;
  proof_min?: number;
  proof_max?: number;
  limit?: number;
}

export async function searchBottles(
  f: SearchFilters,
  opts: { maxRows?: number } = {}
): Promise<Bottle[]> {
  const limit = Math.min(f.limit ?? 10, 25);
  let q = supabase.from("bottles").select(BOTTLE_COLUMNS + ",search_text");
  const norm = f.query ? normalizeQuery(f.query) : "";
  for (const t of norm.split(/\s+/).filter(Boolean)) {
    q = q.ilike("search_text", `%${t}%`);
  }
  if (f.category) q = q.eq("category", f.category);
  if (f.price_min != null) q = q.gte("price_usd_cents", f.price_min * 100);
  if (f.price_max != null) q = q.lte("price_usd_cents", f.price_max * 100);
  if (f.proof_min != null) q = q.gte("proof", f.proof_min);
  if (f.proof_max != null) q = q.lte("proof", f.proof_max);
  const { data, error } = await q
    .order("popularity_tier", { ascending: false, nullsFirst: false })
    .limit(opts.maxRows ?? (norm ? 50 : limit));
  if (error) dbFail(error);
  const rows = (data ?? []) as unknown as Bottle[];
  return (norm ? rankByRelevance(rows, norm) : rows).slice(0, opts.maxRows ?? limit);
}

/** Community rating summary for a bottle (sparse early on — count included). */
export async function ratingSummary(bottleId: string) {
  const { data, error } = await supabase
    .from("tasting_reviews")
    .select("overall_rating,nose_rating,palate_rating,finish_rating")
    .eq("bottle_id", bottleId);
  if (error || !data?.length) return null;
  const avg = (k: string) => {
    const vals = data.map((r: any) => r[k]).filter((v: any) => v != null);
    return vals.length
      ? Math.round((vals.reduce((a: number, b: number) => a + b, 0) / vals.length) * 10) / 10
      : null;
  };
  return {
    average_rating: avg("overall_rating"),
    nose: avg("nose_rating"),
    palate: avg("palate_rating"),
    finish: avg("finish_rating"),
    review_count: data.length,
    scale: "1-5",
  };
}

// --- Similarity --------------------------------------------------------------
// Flavor-profile distance: Jaccard overlap on the flavors array plus proximity
// on the three 1-5 dials. Deterministic, explainable, no runtime AI.
export function similarityScore(a: Bottle, b: Bottle): number {
  const fa = new Set((a.flavors ?? []).map((s) => s.toLowerCase()));
  const fb = new Set((b.flavors ?? []).map((s) => s.toLowerCase()));
  const inter = [...fa].filter((x) => fb.has(x)).length;
  const union = new Set([...fa, ...fb]).size || 1;
  const jaccard = inter / union;
  const dial = (x: number | null, y: number | null) =>
    x == null || y == null ? 0.5 : 1 - Math.abs(x - y) / 4;
  const dials =
    (dial(a.body, b.body) + dial(a.sweetness, b.sweetness) + dial(a.char_level, b.char_level)) / 3;
  const sameCategory = a.category && a.category === b.category ? 1 : 0;
  return jaccard * 0.5 + dials * 0.35 + sameCategory * 0.15;
}

export function sharedFlavors(a: Bottle, b: Bottle): string[] {
  const fb = new Set((b.flavors ?? []).map((s) => s.toLowerCase()));
  return (a.flavors ?? []).filter((f) => fb.has(f.toLowerCase()));
}

/** Candidate pool for similarity ranking: same category, enriched rows. */
export async function candidatePool(ref: Bottle, extra?: (q: any) => any): Promise<Bottle[]> {
  let q = supabase
    .from("bottles")
    .select(BOTTLE_COLUMNS)
    .neq("id", ref.id)
    .not("flavors", "is", null);
  if (ref.category) q = q.eq("category", ref.category);
  if (extra) q = extra(q);
  const { data, error } = await q.limit(400);
  if (error) dbFail(error);
  return (data ?? []) as unknown as Bottle[];
}

/**
 * Trending = most cellar adds in the last 30 days. Needs the service-role key
 * (cellar rows are user-scoped under RLS); falls back to popularity tier when
 * running on the publishable key, and the response labels which method ran.
 */
export async function trendingBottles(limit: number) {
  if (hasServiceKey) {
    const since = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
    // bottle_id is null for user-created custom bottles — exclude them, both
    // because they aren't catalog rows and because a null would break the
    // UUID .in() filter below.
    const { data, error } = await supabase
      .from("cellar_items")
      .select("bottle_id,created_at")
      .not("bottle_id", "is", null)
      .gte("created_at", since);
    if (!error && data?.length) {
      const counts = new Map<string, number>();
      for (const row of data) counts.set(row.bottle_id, (counts.get(row.bottle_id) ?? 0) + 1);
      const top = [...counts.entries()].sort((x, y) => y[1] - x[1]).slice(0, limit);
      const { data: bottles, error: bErr } = await supabase
        .from("bottles")
        .select(BOTTLE_COLUMNS)
        .in("id", top.map(([id]) => id));
      if (!bErr && bottles?.length) {
        const byId = new Map((bottles as unknown as Bottle[]).map((b) => [b.id, b]));
        return {
          method: "cellar_adds_last_30_days" as const,
          bottles: top
            .filter(([id]) => byId.has(id))
            .map(([id, n]) => ({ bottle: byId.get(id)!, cellar_adds_30d: n })),
        };
      }
    }
  }
  const { data, error } = await supabase
    .from("bottles")
    .select(BOTTLE_COLUMNS)
    .not("popularity_tier", "is", null)
    .order("popularity_tier", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) dbFail(error);
  return {
    method: "catalog_popularity_tier" as const,
    bottles: ((data ?? []) as unknown as Bottle[]).map((b) => ({
      bottle: b,
      cellar_adds_30d: null,
    })),
  };
}
