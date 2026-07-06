#!/usr/bin/env node
// Maintenance report for the skill library: near-duplicates, malformed
// SKILL.md files, dangling symlinks, and cross-root shadowing. Dependency-free
// port of the concept in skill-auditor.ts (no embeddings/Convex, just stdlib).
import { readdir, readFile, realpath } from "node:fs/promises";
import {
  ROOTS,
  buildIndex,
  getIndex,
  findSkillFiles,
  isExcludedPluginPath,
  parseFrontmatter,
} from "./lib.mjs";

const SHINGLE_SIZE = 8;
function normalizeText(...parts) {
  return parts.join(" ").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
function shingles(text) {
  const words = normalizeText(text).split(/\s+/).filter(Boolean);
  const set = new Set();
  for (let i = 0; i + SHINGLE_SIZE <= words.length; i++) {
    set.add(words.slice(i, i + SHINGLE_SIZE).join(" "));
  }
  if (set.size === 0 && words.length) set.add(words.join(" "));
  return set;
}
function jaccard(a, b) {
  const [small, big] = a.size < b.size ? [a, b] : [b, a];
  let inter = 0;
  for (const shingle of small) if (big.has(shingle)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

// findSkillFiles silently skips broken symlinks (that's the right call for the
// server); the audit wants to surface them instead, so walk separately.
async function findDanglingSymlinks(dir, exclude) {
  const results = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const full = `${dir}/${entry.name}`;
    if (exclude && exclude(full)) continue;
    if (entry.isSymbolicLink()) {
      try {
        await realpath(full);
      } catch {
        results.push(full);
        continue;
      }
    }
    if (entry.isDirectory() || entry.isSymbolicLink()) {
      results.push(...(await findDanglingSymlinks(full, exclude)));
    }
  }
  return results;
}

let issues = 0;
function section(title) {
  console.log(`\n${title}`);
}
function report(line) {
  console.log(`  ${line}`);
  issues++;
}

const counts = await buildIndex();
const index = getIndex();
const items = [...index.values()];

// --- malformed --------------------------------------------------------------
section("MALFORMED");
let malformedCount = 0;
for (const { dir, source } of ROOTS) {
  const exclude = source === "plugin" ? isExcludedPluginPath : undefined;
  for (const file of await findSkillFiles(dir, exclude)) {
    const raw = await readFile(file, "utf8").catch(() => null);
    if (raw === null) continue;
    const fm = parseFrontmatter(raw);
    const problems = [];
    if (!raw.startsWith("---")) problems.push("no frontmatter");
    else {
      if (!fm.name) problems.push("no name");
      if (!fm.description || !fm.description.trim()) problems.push("no/empty description");
    }
    if (problems.length) {
      report(`${file} — ${problems.join(", ")}`);
      malformedCount++;
    }
  }
}
if (!malformedCount) console.log("  none");

// --- dangling symlinks -------------------------------------------------------
section("DANGLING SYMLINKS");
let danglingCount = 0;
for (const { dir, source } of ROOTS) {
  const exclude = source === "plugin" ? isExcludedPluginPath : undefined;
  for (const link of await findDanglingSymlinks(dir, exclude)) {
    report(link);
    danglingCount++;
  }
}
if (!danglingCount) console.log("  none");

// --- shadowed ----------------------------------------------------------------
section("SHADOWED");
let shadowedCount = 0;
for (const item of items) {
  if (item.shadowedBy?.length) {
    report(`${item.id}: ${item.path} (${item.source}) shadows ${item.shadowedBy.join(", ")}`);
    shadowedCount++;
  }
}
if (!shadowedCount) console.log("  none");

// --- near-duplicates ----------------------------------------------------------
section("NEAR-DUPLICATES");
const shingleSets = items.map((item) => shingles(item.name, item.description, item.bodyForScoring));
let dupCount = 0;
for (let i = 0; i < items.length; i++) {
  for (let j = i + 1; j < items.length; j++) {
    const sim = jaccard(shingleSets[i], shingleSets[j]);
    if (sim > 0.4) {
      report(`DUPLICATE ${(sim * 100).toFixed(0)}%: ${items[i].id} <-> ${items[j].id}`);
      dupCount++;
    } else if (sim > 0.2) {
      report(`WARN ${(sim * 100).toFixed(0)}%: ${items[i].id} <-> ${items[j].id}`);
      dupCount++;
    }
  }
}
if (!dupCount) console.log("  none");

// --- summary ------------------------------------------------------------------
section("SUMMARY");
console.log(`  active: ${counts.active}  plugin: ${counts.plugin}  vault: ${counts.vault}`);
console.log(`  total indexed: ${items.length}`);
console.log(issues === 0 ? "CLEAN" : `${issues} issue(s) found`);
process.exit(issues === 0 ? 0 : 1);
