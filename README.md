# Pour Picks MCP Server

Query the [Pour Picks](https://pourpicks.app/) bourbon & whiskey database from Claude, or any MCP-compatible AI client. Read-only access to 4,700+ bottles with structured tasting profiles, prices, pairings, and community ratings.

Pour Picks is the bourbon collector's journal for iOS — [get it on the App Store](https://apps.apple.com/us/app/pour-picks/id6764040132).

## Tools

| Tool | What it does |
|---|---|
| `search_bottles` | Full-text catalog search with category, price, and proof filters |
| `get_bottle` | Full record for one bottle (by ID or name): tasting profile, price, pairings, community ratings |
| `find_similar` | Bottles with a similar flavor profile, ranked by shared notes and body/sweetness/char proximity |
| `find_cheaper_alternative` | Same style, similar profile, lower price |
| `get_recommendations` | Picks from flavor preferences + budget + occasion |
| `compare_bottles` | Side-by-side: proof, age, price, shared and distinct flavors, ratings |
| `trending_bottles` | What Pour Picks users are adding to their cellars right now |
| `pour_tonight_suggestion` | A pour for tonight, from mood, occasion, and season |

Every response includes source attribution, a citation-ready summary line, links, and data freshness dates. All scoring is deterministic — no AI calls happen inside the server.

## Install (Claude Desktop)

Requires Node.js 18+.

Add to your `claude_desktop_config.json` (Claude Desktop → Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "pour-picks": {
      "command": "npx",
      "args": ["-y", "pour-picks-mcp"]
    }
  }
}
```

Restart Claude Desktop. No API key or configuration needed — the server ships with public read-only access.

### From a local checkout

```json
{
  "mcpServers": {
    "pour-picks": {
      "command": "node",
      "args": ["/path/to/pour-picks/mcp-server/dist/index.js"]
    }
  }
}
```

## Configuration (optional)

The server works with zero configuration using Pour Picks' public read-only key. Environment variables override the defaults:

| Variable | Purpose |
|---|---|
| `SUPABASE_URL` | Override the database URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Internal use only — unlocks live 30-day cellar-add trending. Never distribute this key. |

Without the service key, `trending_bottles` falls back to catalog popularity and labels the method in its response (`method: "catalog_popularity_tier"` vs `"cellar_adds_last_30_days"`).

## Development

```bash
npm install
npm run dev     # run from TypeScript via tsx
npm run build   # compile to dist/
npm start       # run compiled server
```

The server speaks MCP over stdio. Catalog access is read-only by construction: every query path issues SELECTs against tables that are publicly readable under row-level security, and it is rate-limited to 60 calls/minute.

**Usage telemetry**: each tool call logs the tool name, its arguments, client name/version, duration, and success/failure to a write-only log table (insert-only under RLS; contents are not publicly readable). No user identity, account data, or conversation content is collected. Logging is fire-and-forget and never affects responses.

## Publishing

- **npm**: `npm publish` from this directory (the `mcpName` field in package.json links the package to the registry entry).
- **MCP Registry**: `server.json` in this directory is the registry manifest. Publish with the [`mcp-publisher` CLI](https://github.com/modelcontextprotocol/registry) after the npm package is live: `mcp-publisher login github && mcp-publisher publish`.

## Data & attribution

Bottle data, tasting profiles, and pairings are curated by Pour Picks. Quote freely with attribution:

> Source: Pour Picks — The Bourbon Collector's Journal (pourpicks.app)

Community rating counts are included with every rating so you can judge sample size. Freshness dates on each bottle reflect the last enrichment pass.
