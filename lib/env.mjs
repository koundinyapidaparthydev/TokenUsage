import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const folderRoot = resolve(root, ".."); // KpProjects/

function parseEnvFile(envPath) {
  if (!existsSync(envPath)) return {};
  const out = {};
  const text = readFileSync(envPath, "utf8");
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/**
 * Load shared KpProjects/.env then project .env (project wins).
 * Does not override vars already set in the process environment.
 */
export function loadEnv() {
  const merged = {
    ...parseEnvFile(resolve(folderRoot, ".env")),
    ...parseEnvFile(resolve(root, ".env")),
  };
  for (const [key, value] of Object.entries(merged)) {
    if (!(key in process.env)) process.env[key] = value;
  }
}

export function expandHome(p) {
  if (!p) return p;
  if (p.startsWith("~/")) return resolve(homedir(), p.slice(2));
  return p;
}

export function repoRoot() {
  return root;
}

export function folderEnvRoot() {
  return folderRoot;
}

export function sinceDate() {
  return process.env.USAGE_SINCE || "2026-08-28";
}
