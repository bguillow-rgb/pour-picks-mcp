#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { checkRateLimit } from "./db.js";
import { logCall, setClientInfo, SERVER_VERSION } from "./telemetry.js";
import {
  attribution,
  Bottle,
  bottleCard,
  candidatePool,
  displayName,
  priceUsd,
  ratingSummary,
  resolveBottle,
  searchBottles,
  sharedFlavors,
  similarityScore,
  trendingBottles,
} from "./bottles.js";

const CATEGORIES = [
  "bourbon",
  "rye",
  "tennessee",
  "wheat",
  "corn",
  "american_single_malt",
  "scotch_single_malt",
  "scotch_blend",
  "irish",
  "japanese",
  "canadian",
  "world_whisky",
  "rum",
  "tequila",
  "mezcal",
  "cognac",
  "armagnac",
  "brandy",
  "gin",
  "vodka",
  "other",
] as const;

const server = new McpServer({
  name: "pour-picks",
  version: SERVER_VERSION,
});

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

async function respond(payload: Record<string, unknown>): Promise<ToolResult> {
  const body = { ...payload, attribution: await attribution() };
  return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }] };
}

function errorResult(message: string): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify({ error: message }) }], isError: true };
}

/** Wrap a handler with rate limiting, error normalization, and call logging. */
function guarded<A>(
  toolName: string,
  fn: (args: A) => Promise<ToolResult>
): (args: A) => Promise<ToolResult> {
  return async (args: A) => {
    const started = Date.now();
    try {
      checkRateLimit();
      const result = await fn(args);
      logCall({ tool_name: toolName, args, success: true, duration_ms: Date.now() - started });
      return result;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      logCall({
        tool_name: toolName,
        args,
        success: false,
        error: message,
        duration_ms: Date.now() - started,
      });
      return errorResult(message);
    }
  };
}

async function mustResolve(ref: string): Promise<Bottle> {
  const b = await resolveBottle(ref);
  if (!b) throw new Error(`No bottle found matching "${ref}". Try search_bottles first.`);
  return b;
}

// ---------------------------------------------------------------------------
server.registerTool(
  "search_bottles",
  {
    title: "Search the Pour Picks catalog",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description:
      "Full-text search across 4,700+ bourbons, ryes, scotches, and other spirits in the Pour Picks database. Filter by category, price (USD), and proof. Returns structured tasting profiles with source attribution.",
    inputSchema: {
      query: z.string().optional().describe("Free-text search: distillery, bottle name, or expression"),
      category: z.enum(CATEGORIES).optional().describe("Spirit category filter"),
      price_min: z.number().min(0).optional().describe("Minimum price in USD"),
      price_max: z.number().min(0).optional().describe("Maximum price in USD"),
      proof_min: z.number().min(0).optional().describe("Minimum proof"),
      proof_max: z.number().min(0).optional().describe("Maximum proof"),
      limit: z.number().int().min(1).max(25).optional().describe("Max results (default 10)"),
    },
  },
  guarded("search_bottles", async (args) => {
    const bottles = await searchBottles(args);
    return respond({
      result_count: bottles.length,
      bottles: bottles.map((b) => bottleCard(b)),
    });
  })
);

server.registerTool(
  "get_bottle",
  {
    title: "Get bottle details",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description:
      "Detailed record for one bottle: tasting profile, flavor notes, pairings, price, community ratings. Accepts a Pour Picks bottle ID (UUID) or a bottle name.",
    inputSchema: {
      slug_or_id: z.string().describe("Bottle UUID or a name like 'Eagle Rare 10'"),
    },
  },
  guarded("get_bottle", async ({ slug_or_id }) => {
    const b = await mustResolve(slug_or_id);
    const ratings = await ratingSummary(b.id);
    return respond({
      bottle: bottleCard(b, { community_ratings: ratings }),
    });
  })
);

server.registerTool(
  "find_similar",
  {
    title: "Find similar bottles",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description:
      "Bottles with a similar flavor profile to a given bottle, ranked by shared flavor notes and body/sweetness/char proximity. Deterministic scoring over the Pour Picks structured tasting data.",
    inputSchema: {
      bottle_id: z.string().describe("Bottle UUID or name"),
      limit: z.number().int().min(1).max(15).optional().describe("Max results (default 5)"),
    },
  },
  guarded("find_similar", async ({ bottle_id, limit }) => {
    const ref = await mustResolve(bottle_id);
    const pool = await candidatePool(ref);
    const ranked = pool
      .map((b) => ({ b, score: similarityScore(ref, b) }))
      .sort((x, y) => y.score - x.score)
      .slice(0, limit ?? 5);
    return respond({
      reference_bottle: displayName(ref),
      similar_bottles: ranked.map(({ b, score }) =>
        bottleCard(b, {
          similarity: Math.round(score * 100) / 100,
          shared_flavors: sharedFlavors(ref, b),
        })
      ),
    });
  })
);

server.registerTool(
  "find_cheaper_alternative",
  {
    title: "Find a cheaper alternative",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description:
      "Bottles in the same style with a similar flavor profile at a lower price than the given bottle. Great for 'what tastes like X without the price tag' questions.",
    inputSchema: {
      bottle_id: z.string().describe("Bottle UUID or name"),
      limit: z.number().int().min(1).max(10).optional().describe("Max results (default 5)"),
    },
  },
  guarded("find_cheaper_alternative", async ({ bottle_id, limit }) => {
    const ref = await mustResolve(bottle_id);
    const refPrice = priceUsd(ref);
    if (refPrice == null) {
      throw new Error(
        `${displayName(ref)} has no price on record, so a cheaper alternative can't be computed. Try find_similar instead.`
      );
    }
    const pool = await candidatePool(ref, (q) =>
      q.lt("price_usd_cents", ref.price_usd_cents).not("price_usd_cents", "is", null)
    );
    const ranked = pool
      .map((b) => ({ b, score: similarityScore(ref, b) }))
      .sort((x, y) => y.score - x.score)
      .slice(0, limit ?? 5);
    return respond({
      reference_bottle: displayName(ref),
      reference_price_usd: refPrice,
      cheaper_alternatives: ranked.map(({ b, score }) =>
        bottleCard(b, {
          similarity: Math.round(score * 100) / 100,
          savings_usd: Math.round((refPrice - (priceUsd(b) ?? 0)) * 100) / 100,
          shared_flavors: sharedFlavors(ref, b),
        })
      ),
    });
  })
);

server.registerTool(
  "get_recommendations",
  {
    title: "Get personalized recommendations",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description:
      "Personalized bottle picks from taste preferences (flavor keywords like 'caramel', 'smoke', 'cherry'), a budget in USD, and an occasion (e.g. 'gift', 'everyday sipper', 'celebration', 'introducing a friend to bourbon').",
    inputSchema: {
      taste_preferences: z
        .array(z.string())
        .min(1)
        .describe("Flavor keywords the drinker enjoys, e.g. ['caramel','vanilla','oak']"),
      budget: z.number().min(0).optional().describe("Max price in USD"),
      occasion: z.string().optional().describe("What the bottle is for"),
      category: z.enum(CATEGORIES).optional().describe("Restrict to one spirit category"),
      limit: z.number().int().min(1).max(10).optional().describe("Max results (default 5)"),
    },
  },
  guarded("get_recommendations", async ({ taste_preferences, budget, occasion, category, limit }) => {
    const wanted = taste_preferences.map((t) => t.toLowerCase().trim());
    const occ = (occasion ?? "").toLowerCase();
    // Occasion heuristics: gifts and celebrations favor recognizable bottles,
    // exploration favors deeper cuts. Neutral otherwise.
    const minPopularity = /gift|celebrat|impress|wedding|birthday|new to|introduc|beginner/.test(occ)
      ? 4
      : /adventur|explor|surprise|deep cut|obscure|hunt/.test(occ)
        ? null
        : 2;
    const pool = await searchBottles({ category, price_max: budget }, { maxRows: 300 });
    const scored = pool
      .filter((b) => minPopularity == null || (b.popularity_tier ?? 3) >= minPopularity)
      .map((b) => {
        const flavors = (b.flavors ?? []).map((f) => f.toLowerCase());
        const hits = wanted.filter((w) => flavors.some((f) => f.includes(w) || w.includes(f)));
        return { b, hits, score: hits.length / wanted.length };
      })
      .filter((x) => x.hits.length > 0)
      .sort((x, y) => y.score - x.score || (y.b.popularity_tier ?? 0) - (x.b.popularity_tier ?? 0))
      .slice(0, limit ?? 5);
    return respond({
      criteria: { taste_preferences, budget: budget ?? null, occasion: occasion ?? null },
      recommendations: scored.map(({ b, hits }) =>
        bottleCard(b, { matched_flavors: hits })
      ),
      note: scored.length
        ? undefined
        : "No bottles matched those flavor keywords within the constraints. Try broader flavors or a higher budget.",
    });
  })
);

server.registerTool(
  "compare_bottles",
  {
    title: "Compare two bottles",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description:
      "Side-by-side comparison of two bottles: proof, age, price, flavor profile, shared and distinct tasting notes, and community ratings.",
    inputSchema: {
      bottle_a: z.string().describe("First bottle — UUID or name"),
      bottle_b: z.string().describe("Second bottle — UUID or name"),
    },
  },
  guarded("compare_bottles", async ({ bottle_a, bottle_b }) => {
    const [a, b] = await Promise.all([mustResolve(bottle_a), mustResolve(bottle_b)]);
    const [ra, rb] = await Promise.all([ratingSummary(a.id), ratingSummary(b.id)]);
    const shared = sharedFlavors(a, b);
    const only = (x: Bottle, other: Bottle) => {
      const otherSet = new Set((other.flavors ?? []).map((f) => f.toLowerCase()));
      return (x.flavors ?? []).filter((f) => !otherSet.has(f.toLowerCase()));
    };
    return respond({
      comparison: {
        bottle_a: bottleCard(a, { community_ratings: ra }),
        bottle_b: bottleCard(b, { community_ratings: rb }),
        shared_flavors: shared,
        only_in_a: only(a, b),
        only_in_b: only(b, a),
        similarity: Math.round(similarityScore(a, b) * 100) / 100,
        price_delta_usd:
          priceUsd(a) != null && priceUsd(b) != null
            ? Math.round((priceUsd(a)! - priceUsd(b)!) * 100) / 100
            : null,
      },
    });
  })
);

server.registerTool(
  "trending_bottles",
  {
    title: "Trending bottles",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description:
      "Bottles Pour Picks users are adding to their cellars most over the last 30 days (falls back to catalog popularity when live activity data is unavailable). The method used is labeled in the response.",
    inputSchema: {
      limit: z.number().int().min(1).max(20).optional().describe("Max results (default 10)"),
    },
  },
  guarded("trending_bottles", async ({ limit }) => {
    const { method, bottles } = await trendingBottles(limit ?? 10);
    return respond({
      method,
      window: method === "cellar_adds_last_30_days" ? "last 30 days" : "all-time catalog popularity",
      trending: bottles.map(({ bottle, cellar_adds_30d }) =>
        bottleCard(bottle, cellar_adds_30d == null ? {} : { cellar_adds_30d })
      ),
    });
  })
);

server.registerTool(
  "pour_tonight_suggestion",
  {
    title: "What should I pour tonight?",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description:
      "A pour suggestion for right now, based on mood (e.g. 'unwinding', 'celebratory', 'contemplative'), occasion (e.g. 'nightcap', 'with friends', 'after dinner'), and season.",
    inputSchema: {
      mood: z.string().optional().describe("How you're feeling"),
      occasion: z.string().optional().describe("The setting"),
      season: z.enum(["winter", "spring", "summer", "fall"]).optional().describe("Season to weight the pick toward — heavier, warming pours in winter; lighter in summer"),
    },
  },
  guarded("pour_tonight_suggestion", async ({ mood, occasion, season }) => {
    const text = `${mood ?? ""} ${occasion ?? ""}`.toLowerCase();
    // Deterministic mood/season → profile mapping (no runtime AI).
    const wantFlavors: string[] = [];
    let proof_max: number | undefined;
    let proof_min: number | undefined;
    if (season === "summer") wantFlavors.push("citrus", "honey", "floral", "fruit");
    if (season === "winter") wantFlavors.push("baking spice", "dark chocolate", "cinnamon", "toffee");
    if (season === "fall") wantFlavors.push("caramel", "oak", "maple", "apple");
    if (season === "spring") wantFlavors.push("vanilla", "honey", "herbal", "floral");
    if (/unwind|relax|chill|nightcap|mellow|easy/.test(text)) {
      wantFlavors.push("caramel", "vanilla", "honey");
      proof_max = 100;
    }
    if (/celebrat|special|toast|win|promotion/.test(text)) wantFlavors.push("cherry", "toffee", "oak");
    if (/contempl|slow|thought|quiet|fireside/.test(text)) {
      wantFlavors.push("smoke", "leather", "tobacco", "oak");
      proof_min = 90;
    }
    if (/friends|party|group|share/.test(text)) wantFlavors.push("caramel", "brown sugar");
    if (!wantFlavors.length) wantFlavors.push("caramel", "vanilla", "oak");

    const pool = await searchBottles({ proof_min, proof_max }, { maxRows: 300 });
    const scored = pool
      .map((b) => {
        const flavors = (b.flavors ?? []).map((f) => f.toLowerCase());
        const hits = wantFlavors.filter((w) => flavors.some((f) => f.includes(w)));
        return { b, hits, score: hits.length + (b.popularity_tier ?? 3) / 10 };
      })
      .sort((x, y) => y.score - x.score)
      .slice(0, 3);
    return respond({
      criteria: { mood: mood ?? null, occasion: occasion ?? null, season: season ?? null },
      matched_profile: wantFlavors,
      suggestions: scored.map(({ b, hits }, i) =>
        bottleCard(b, { rank: i + 1, matched_flavors: hits })
      ),
    });
  })
);

// ---------------------------------------------------------------------------
const transport = new StdioServerTransport();
server.server.oninitialized = () => setClientInfo(server.server.getClientVersion());
await server.connect(transport);
console.error("Pour Picks MCP server running (stdio, read-only)");
