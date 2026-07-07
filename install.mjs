#!/usr/bin/env node
import { lstat, mkdir, readlink, realpath, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const home = process.env.HOME || os.homedir();
if (!home) {
  console.error("error: HOME is not set; cannot locate ~/.claude/skill-router");
  process.exit(1);
}

const repoDir = await realpath(path.dirname(fileURLToPath(import.meta.url)));
const claudeDir = path.join(home, ".claude");
const target = path.join(claudeDir, "skill-router");

try {
  await mkdir(claudeDir, { recursive: true });
} catch (err) {
  console.error(`error: cannot create ${claudeDir}: ${err.message}`);
  process.exit(1);
}

async function linkPointsAtRepo() {
  const link = await readlink(target);
  const resolved = path.isAbsolute(link) ? link : path.resolve(path.dirname(target), link);
  return (await realpath(resolved)) === repoDir;
}

async function createLink(message) {
  await symlink(repoDir, target, "dir");
  console.log(`${message}: ${target} -> ${repoDir}`);
}

try {
  const st = await lstat(target);

  if (st.isSymbolicLink()) {
    try {
      if (await linkPointsAtRepo()) {
        console.log(`already linked: ${target} -> ${repoDir}`);
        process.exit(0);
      }
    } catch (err) {
      if (err?.code === "ENOENT") {
        await rm(target);
        await createLink("recreated dangling symlink");
        process.exit(0);
      }
      throw err;
    }
  }

  console.error(`error: refusing to clobber ${target}`);
  console.error(`Move or remove it first, then run: node ${path.join(repoDir, "install.mjs")}`);
  process.exit(1);
} catch (err) {
  if (err?.code !== "ENOENT") throw err;
  await createLink("linked");
}
