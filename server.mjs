#!/usr/bin/env node
// Lazy router over the local Claude Code skill library: search + load SKILL.md
// files by keyword overlap, so a caller can find a skill without scanning
// every directory itself.
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const HOME = process.env.HOME ?? "/root";
const ROOTS = [
  { dir: path.join(HOME, ".claude/skills"), source: "active" },
  { dir: path.join(HOME, ".claude/plugins"), source: "plugin" },
  { dir: path.join(HOME, ".claude/skill-vault"), source: "vault" },
];
const SOURCE_RANK = { active: 0, plugin: 1, vault: 2 };
const BODY_SCORE_CHARS = 8000;

function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function tokens(text) {
  return new Set((text.match(/\w+/g) ?? []).map((t) => t.toLowerCase()));
}

// Filler words weak/terse callers pad queries with ("make my website load
// faster"). Filtered from the QUERY only — never the haystack — so they can't
// outvote the domain terms. If the whole query is filler, fall back unfiltered.
const STOPWORDS = new Set([
  "the", "a", "an", "my", "me", "i", "you", "your", "to", "for", "of", "in",
  "on", "with", "and", "or", "is", "are", "it", "this", "that", "how", "do",
  "does", "can", "want", "need", "help", "please", "make", "get", "set", "up",
  "use", "using", "when", "what", "which", "some", "more", "so", "at", "be",
]);
function queryTokens(text) {
  const all = tokens(text);
  const filtered = new Set([...all].filter((t) => !STOPWORDS.has(t) && t.length > 1));
  return filtered.size > 0 ? filtered : all;
}

// Parses `key: value` out of a `---\n...\n---` frontmatter block, including
// YAML block scalars (`description: >-` + indented lines — 44 of the ~185
// real skills use that form). Tolerant of missing frontmatter or keys.
function parseFrontmatter(raw) {
  const out = {};
  if (!raw.startsWith("---")) return out;
  const end = raw.indexOf("\n---", 3);
  if (end === -1) return out;
  const lines = raw.slice(3, end).split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(name|description):\s*(.*)$/);
    if (!m) continue;
    let val = m[2].trim();
    if (/^[>|][0-9+-]{0,2}$/.test(val)) {
      const parts = [];
      // blank lines inside a block scalar are paragraph breaks, not the end
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || lines[i + 1].trim() === "")) {
        const next = lines[++i].trim();
        if (next) parts.push(next);
      }
      val = parts.join(" ");
    }
    out[m[1]] = val.replace(/^["']|["']$/g, "");
  }
  return out;
}

function fallbackDescription(body) {
  for (const line of body.split("\n")) {
    const t = line.trim();
    if (t && !t.startsWith("#")) return t.slice(0, 300);
  }
  return "";
}

// Most of ~/.claude/skills is symlinks into a shared store (../../.agents/skills/*),
// and Dirent.isDirectory() doesn't follow symlinks -- so a plain readdir walk
// silently misses most skills. Resolve symlinked dirs via stat, and track
// real paths already visited to survive a symlink cycle.
async function findSkillFiles(dir, exclude, seen = new Set()) {
  const results = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return results; // missing/unreadable root: tolerate silently
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (exclude && exclude(full)) continue;
    let isDir = entry.isDirectory();
    if (!isDir && entry.isSymbolicLink()) {
      try {
        const real = await realpath(full);
        if (seen.has(real)) continue;
        if ((await stat(full)).isDirectory()) {
          seen.add(real);
          isDir = true;
        }
      } catch {
        continue; // broken symlink
      }
    }
    if (isDir) {
      results.push(...(await findSkillFiles(full, exclude, seen)));
    } else if (entry.name === "SKILL.md") {
      results.push(full);
    }
  }
  return results;
}

function isExcludedPluginPath(p) {
  return p.includes("/plugins/cache/") || p.includes("/plugins/marketplaces/");
}

async function loadSkill(filePath, source) {
  let raw;
  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    return null;
  }
  const fm = parseFrontmatter(raw);
  const bodyStart = raw.startsWith("---") ? raw.indexOf("\n---", 3) + 4 : 0;
  const body = raw.slice(Math.max(bodyStart, 0));
  const name = fm.name || path.basename(path.dirname(filePath));
  const description = fm.description || fallbackDescription(body);
  return {
    id: slugify(name),
    name,
    description,
    source,
    path: filePath,
    bodyForScoring: body.slice(0, BODY_SCORE_CHARS),
  };
}

let index = new Map(); // id -> skill item (winner), with shadowedBy: string[]

async function buildIndex() {
  const counts = { active: 0, plugin: 0, vault: 0, shadowed: 0 };
  const byId = new Map();
  for (const { dir, source } of ROOTS) {
    const exclude = source === "plugin" ? isExcludedPluginPath : undefined;
    const files = await findSkillFiles(dir, exclude);
    for (const file of files) {
      const item = await loadSkill(file, source);
      if (!item) continue;
      counts[source]++;
      const existing = byId.get(item.id);
      if (!existing) {
        item.shadowedBy = [];
        byId.set(item.id, item);
        continue;
      }
      // keep the higher-precedence entry (active > plugin > vault)
      const existingWins = SOURCE_RANK[existing.source] <= SOURCE_RANK[item.source];
      const winner = existingWins ? existing : item;
      const loser = existingWins ? item : existing;
      winner.shadowedBy = [...(existing.shadowedBy ?? []), loser.path].filter(
        (p, i, arr) => arr.indexOf(p) === i,
      );
      counts.shadowed++;
      byId.set(item.id, winner);
    }
  }
  index = byId;
  return counts;
}

function scoreItem(item, qTokens, queryText) {
  const haystackText = [item.name, item.description, item.bodyForScoring]
    .join("\n")
    .toLowerCase();
  const haystackTokens = tokens(haystackText);
  let overlap = 0;
  for (const t of qTokens) if (haystackTokens.has(t)) overlap++;
  let score = overlap;
  if (queryText && haystackText.includes(queryText)) score += 5;
  const nameLower = item.name.toLowerCase();
  const descLower = item.description.toLowerCase();
  const nameFragments = nameLower.split(/[^a-z0-9]+/).filter((n) => n.length >= 3);
  for (const t of qTokens) {
    if (nameLower.includes(t)) score += 3;
    // partial name credit: query "website" should still hit the name "web-perf"
    else if (nameFragments.some((n) => t.includes(n))) score += 2;
    if (descLower.includes(t)) score += 1.5;
  }
  if (score === 0) return 0;
  return score + 1 / Math.sqrt(Math.max(haystackTokens.size, 1));
}

function search(query, limit) {
  const queryText = query.toLowerCase().trim();
  const qTokens = queryTokens(queryText);
  const results = [];
  for (const item of index.values()) {
    const score = scoreItem(item, qTokens, queryText);
    if (score > 0) {
      results.push({
        id: item.id,
        name: item.name,
        description: item.description,
        source: item.source,
        path: item.path,
        score,
      });
    }
  }
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}

function closestIds(query, n) {
  const qTokens = queryTokens(query.toLowerCase());
  const scored = [...index.values()].map((item) => ({
    id: item.id,
    score: scoreItem(item, qTokens, query.toLowerCase()),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, n).map((s) => s.id);
}

const server = new Server(
  { name: "skill-router", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "skill_search",
      description:
        "Search the local skill library; returns ranked skill ids to pass to skill_load. Use concrete task keywords (e.g. 'web performance audit', 'cold email sequence'), not filler words. If the top results look wrong, retry once with different domain terms.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Concrete task keywords describing what you're trying to do." },
          limit: { type: "number", description: "Max results (default 5, max 20)." },
        },
        required: ["query"],
      },
    },
    {
      name: "skill_load",
      description:
        "Load the full SKILL.md content for a skill id (from skill_search) or name.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Skill id or name (case-insensitive)." },
        },
        required: ["id"],
      },
    },
    {
      name: "skill_reindex",
      description: "Rescan the skill roots and rebuild the index. Returns counts per source.",
      inputSchema: { type: "object", properties: {} },
    },
  ],
}));

function textResult(value) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  if (name === "skill_search") {
    const limit = Math.min(Math.max(Number(args.limit) || 5, 1), 20);
    const results = search(String(args.query ?? ""), limit);
    if (results.length === 0) {
      return textResult({
        message: "No matches. Try broader or different terms.",
        totalIndexed: index.size,
      });
    }
    return textResult(results);
  }

  if (name === "skill_load") {
    const wanted = String(args.id ?? "");
    const wantedSlug = slugify(wanted);
    let item = index.get(wantedSlug);
    if (!item) {
      const wantedLower = wanted.toLowerCase();
      item = [...index.values()].find((i) => i.name.toLowerCase() === wantedLower);
    }
    if (!item) {
      return textResult({
        error: `Unknown skill id "${wanted}".`,
        closest: closestIds(wanted, 5),
      });
    }
    const dir = path.dirname(item.path);
    let siblings = [];
    try {
      siblings = (await readdir(dir)).filter((f) => f !== "SKILL.md");
    } catch {
      // directory vanished between index and load; siblings stays empty
    }
    let content;
    try {
      content = await readFile(item.path, "utf8");
    } catch {
      return textResult({
        error: `Skill file unreadable at ${item.path} (moved or deleted since indexing). Run skill_reindex and search again.`,
      });
    }
    return textResult({ id: item.id, name: item.name, path: item.path, siblings, content });
  }

  if (name === "skill_reindex") {
    const counts = await buildIndex();
    return textResult(counts);
  }

  throw new Error(`Unknown tool: ${name}`);
});

await buildIndex();
const transport = new StdioServerTransport();
await server.connect(transport);
