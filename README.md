# skill-router

A lazy router for Claude Code skills: instead of every installed skill costing
context every turn, expose the whole library through three small MCP tools —
search, load, reindex. Weak/cheap models navigate it fine; that's the point.

Single-file Node MCP server (stdio). One dependency (`@modelcontextprotocol/sdk`).
No database, no embeddings, no background services. Indexing ~185 skills takes
~25ms at startup.

## How it works

On startup (and on `skill_reindex`) the server walks three roots for `SKILL.md`
files:

| Root | Label | Notes |
|---|---|---|
| `~/.claude/skills/` | `active` | symlinks followed (with cycle guard) |
| `~/.claude/plugins/` | `plugin` | `plugins/cache/` and `plugins/marketplaces/` excluded |
| `~/.claude/skill-vault/` | `vault` | see below |

Frontmatter `name:`/`description:` are parsed (including YAML block scalars
like `description: >-`); duplicates dedupe with precedence
`active > plugin > vault`.

### Tools

- **`skill_search`** `{query, limit?}` — ranked `{id, name, description, source, path, score}`.
  Token-overlap scoring with query-side stopword filtering (so "make my website
  load faster" still finds `web-perf`), whole-query substring boost, and partial
  name-fragment credit ("website" matches the name `web-perf`).
- **`skill_load`** `{id}` — full `SKILL.md` content plus sibling files
  (`references/`, `scripts/`, …). Accepts ids or names case-insensitively;
  unknown ids return the 5 closest matches instead of an error.
- **`skill_reindex`** — rescan, returns counts per source.

### The vault

The real context win: move rarely-used skills from `~/.claude/skills/` into
`~/.claude/skill-vault/`. The harness stops listing them every turn, but they
stay fully discoverable and loadable through the router.

## Install

```bash
npm install
claude mcp add --scope user skill-router node /absolute/path/to/server.mjs
```

## Test

```bash
node test.mjs
```

Self-contained: builds a fixture skill tree in a temp `HOME` (including a
symlinked skill, a block-scalar description, an excluded plugin-cache entry,
and a shadowed vault duplicate) and asserts against it over real stdio JSON-RPC.

## Security note

The indexer follows symlinks out of the skill roots and will index any
`SKILL.md` they reach — so don't point skill roots at (or install skill
bundles containing symlinks to) untrusted or sensitive locations. Loaded
skill content is returned as data, never executed.

## Credits

The scoring approach is ported from the Hermes lazy-router plugin in
[agency-agents](https://github.com/msitarzewski/agency-agents) (MIT, AgentLand
Contributors) — the pattern of exposing a large roster as a few search tools
instead of preloading everything.

## License

MIT
