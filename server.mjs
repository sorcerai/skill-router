#!/usr/bin/env node
// Lazy router over the local Claude Code skill library: search + load SKILL.md
// files by keyword overlap, so a caller can find a skill without scanning
// every directory itself.
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { buildIndex, search, closestIds, getIndex, slugify } from "./lib.mjs";

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
        totalIndexed: getIndex().size,
      });
    }
    return textResult(results);
  }

  if (name === "skill_load") {
    const wanted = String(args.id ?? "");
    const wantedSlug = slugify(wanted);
    const index = getIndex();
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
