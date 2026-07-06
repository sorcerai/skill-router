#!/usr/bin/env node
// Self-check: build a fixture skill tree in a temp HOME, spawn the server
// against it, speak raw JSON-RPC over stdio, assert the three tools behave.
// No test framework, no dependence on the machine's real skill library.
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import os from "node:os";

const here = path.dirname(fileURLToPath(import.meta.url));

// --- fixture HOME ------------------------------------------------------------
const fixtureHome = mkdtempSync(path.join(os.tmpdir(), "skill-router-test-"));
function skill(dir, name, description, body = "## Usage\n\nDetails long enough to load and score against, with several words of content.") {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n${body}\n`);
}
const skills = path.join(fixtureHome, ".claude/skills");
const store = path.join(fixtureHome, ".agents/skills"); // simulated shared store
const vault = path.join(fixtureHome, ".claude/skill-vault");

skill(path.join(skills, "alpha-skill"), "alpha-skill", "Set up analytics dashboards and tracking plans.");
// beta lives in the shared store; ~/.claude/skills/beta-skill is a SYMLINK to it
skill(path.join(store, "beta-skill"), "beta-skill", "Migrate relational database schemas safely.");
symlinkSync(path.join(store, "beta-skill"), path.join(skills, "beta-skill"));
// gamma uses a YAML block-scalar description with a blank line inside it
mkdirSync(path.join(skills, "gamma-skill"), { recursive: true });
writeFileSync(
  path.join(skills, "gamma-skill", "SKILL.md"),
  "---\nname: gamma-skill\ndescription: >-\n  Deploy purple elephant workloads to the edge.\n\n  Second paragraph still part of the description.\n---\n\n# gamma\n\n## Steps\n\nEnough body text to satisfy the loader and scorer here.\n",
);
// plugin cache must be EXCLUDED from the index
skill(path.join(fixtureHome, ".claude/plugins/cache/junk"), "junk-skill", "Should never be indexed.");
// vaulted skill, plus a vault DUPLICATE of alpha (active must win = 1 shadowed)
skill(path.join(vault, "delta-skill"), "delta-skill", "Archived skill for rotating log files.");
skill(path.join(vault, "alpha-skill"), "alpha-skill", "Stale vault copy that must be shadowed.");

// --- spawn server against the fixture ----------------------------------------
const child = spawn("node", [path.join(here, "server.mjs")], {
  stdio: ["pipe", "pipe", "inherit"],
  env: { ...process.env, HOME: fixtureHome },
});

let buf = "";
const pending = new Map();
let nextId = 1;
child.stdout.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  let idx;
  while ((idx = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});

function send(method, params) {
  return new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}
const notify = (method, params) =>
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
const callTool = async (name, args) =>
  JSON.parse((await send("tools/call", { name, arguments: args })).result.content[0].text);

async function main() {
  await send("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "skill-router-test", version: "0.0.1" },
  });
  notify("notifications/initialized", {});

  const list = await send("tools/list", {});
  assert.deepEqual(
    list.result.tools.map((t) => t.name).sort(),
    ["skill_load", "skill_reindex", "skill_search"],
    "tools/list should expose exactly 3 tools",
  );

  const counts = await callTool("skill_reindex", {});
  assert.equal(counts.active, 3, `active should be 3 (incl. the symlinked skill), got ${counts.active}`);
  assert.equal(counts.plugin, 0, "plugins/cache must be excluded");
  assert.equal(counts.vault, 2, `vault should be 2, got ${counts.vault}`);
  assert.equal(counts.shadowed, 1, "vault duplicate of alpha must be shadowed");

  // block-scalar description is searchable, including past the blank line
  const gamma = await callTool("skill_search", { query: "deploy purple elephant edge" });
  assert.equal(gamma[0]?.id, "gamma-skill", `expected gamma-skill first, got ${gamma[0]?.id}`);
  const gamma2 = await callTool("skill_search", { query: "second paragraph description" });
  assert.ok(gamma2.some?.((h) => h.id === "gamma-skill"), "text after blank line in block scalar must score");

  // symlinked skill is found and loadable
  const beta = await callTool("skill_search", { query: "migrate database schema" });
  assert.equal(beta[0]?.id, "beta-skill", `expected beta-skill first, got ${beta[0]?.id}`);
  const loaded = await callTool("skill_load", { id: "beta-skill" });
  assert.ok(loaded.content?.includes("## Usage"), "skill_load should return full SKILL.md content");

  // shadowing: loading alpha must return the ACTIVE copy, not the vault one
  const alpha = await callTool("skill_load", { id: "alpha-skill" });
  assert.ok(alpha.path.includes("/.claude/skills/"), `alpha should resolve to active copy, got ${alpha.path}`);

  // unknown id gets recovery guidance, not a throw
  const unknown = await callTool("skill_load", { id: "does-not-exist" });
  assert.ok(unknown.error && Array.isArray(unknown.closest), "unknown id should return error + closest suggestions");

  console.log("All checks passed.", { counts });
}

main()
  .then(() => process.exit(cleanup(0)))
  .catch((err) => {
    console.error("FAIL:", err.message);
    process.exit(cleanup(1));
  });

function cleanup(code) {
  child.kill();
  rmSync(fixtureHome, { recursive: true, force: true });
  return code;
}
