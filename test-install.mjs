#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const here = path.dirname(fileURLToPath(import.meta.url));
const installScript = path.join(here, "install.mjs");
const repoReal = realpathSync(here);
const tempHome = mkdtempSync(path.join(os.tmpdir(), "skill-router-install-test-"));
const target = path.join(tempHome, ".claude", "skill-router");

function runInstall() {
  return execFileSync(process.execPath, [installScript], {
    cwd: here,
    env: { ...process.env, HOME: tempHome },
    encoding: "utf8",
  });
}

function assertLinked() {
  assert.equal(lstatSync(target).isSymbolicLink(), true);
  assert.equal(realpathSync(target), repoReal);
}

try {
  const first = runInstall();
  assert.match(first, /linked:/);
  assertLinked();

  const second = runInstall();
  assert.match(second, /already linked/);
  assertLinked();

  rmSync(target);
  symlinkSync(path.join(tempHome, "missing-target"), target);
  const dangling = runInstall();
  assert.match(dangling, /recreated dangling symlink/);
  assertLinked();

  rmSync(target);
  const otherTarget = path.join(tempHome, "other-target");
  mkdirSync(otherTarget);
  symlinkSync(otherTarget, target);
  const otherSymlink = spawnSync(process.execPath, [installScript], {
    cwd: here,
    env: { ...process.env, HOME: tempHome },
    encoding: "utf8",
  });
  assert.notEqual(otherSymlink.status, 0);
  assert.match(`${otherSymlink.stdout}${otherSymlink.stderr}`, /refusing to clobber/);
  assert.equal(realpathSync(target), realpathSync(otherTarget));

  rmSync(target);
  mkdirSync(target);
  const occupied = spawnSync(process.execPath, [installScript], {
    cwd: here,
    env: { ...process.env, HOME: tempHome },
    encoding: "utf8",
  });
  assert.notEqual(occupied.status, 0);
  assert.match(`${occupied.stdout}${occupied.stderr}`, /refusing to clobber/);
  assert.equal(existsSync(target), true);
  assert.equal(lstatSync(target).isDirectory(), true);

  console.log("install tests passed");
} finally {
  rmSync(tempHome, { recursive: true, force: true });
}
