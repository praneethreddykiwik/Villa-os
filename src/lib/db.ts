import fs from "node:fs";
import path from "node:path";
import type { Database } from "./types";
import { EMPTY_OPS } from "./ops/types";

/**
 * Storage is a single JSON document behind a narrow repository interface.
 *
 * Why: it makes the whole system runnable with `npm run dev` and nothing else —
 * no Postgres, no Docker, no migrations — while keeping every read/write funnelled
 * through `read()` / `mutate()`. Swapping in Postgres/Drizzle later means
 * reimplementing exactly those two functions; no page or engine touches storage
 * directly.
 */

// Overridable so tests run against an isolated store instead of the dev data.
// In serverless environments like Vercel or AWS Lambda, process.cwd() is read-only at runtime,
// so fallback to /tmp/.data where writes are permitted.
const DATA_DIR = process.env.OPS_DATA_DIR
  ? path.resolve(process.env.OPS_DATA_DIR)
  : process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME
  ? path.join("/tmp", ".data")
  : path.join(process.cwd(), ".data");
const DB_PATH = path.join(DATA_DIR, "db.json");

const EMPTY: Database = {
  workspaces: [],
  appointments: [],
  availability: [],
  notificationLog: [],
  webhookSubscribers: [],
  webhookDeliveries: [],
  n8nSubmissions: [],
  brands: [],
  connections: [],
  media: [],
  posts: [],
  dailyStats: [],
  adCampaigns: [],
  adStats: [],
  reviews: [],
  rankGrid: [],
  competitors: [],
  suggestions: [],
  campaigns: [],
  conversations: [],
  ideas: [],
  reports: [],
  activity: [],
  boards: [],
  boardCards: [],
  leads: [],
  brokers: [],
  crmContacts: [],
  crmTasks: [],
  voiceCalls: [],
  voiceAgentConfigs: [],
  ...EMPTY_OPS,
};

let cache: Database | null = null;
let cacheMtime = 0;

function ensureFile(): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(DB_PATH)) {
    // If a seeded db exists in the repo bundle, copy it to the writable store
    const repoSeed = path.join(process.cwd(), "src", "lib", "seed-db.json");
    const dotDataSeed = path.join(process.cwd(), ".data", "db.json");
    const seedToUse = fs.existsSync(repoSeed) ? repoSeed : fs.existsSync(dotDataSeed) ? dotDataSeed : null;
    if (seedToUse && seedToUse !== DB_PATH) {
      try {
        fs.copyFileSync(seedToUse, DB_PATH);
        return;
      } catch {
        // fallback to buildBootstrap()
      }
    }
    // A fresh clone boots with the tenant shell only — no fabricated content.
    const { buildBootstrap } = require("./bootstrap") as typeof import("./bootstrap");
    // 0600, and the directory 0700. This file holds plaintext OAuth tokens and
    // customer PII; the default 0644 made it readable by every account and every
    // process on the host.
    fs.writeFileSync(DB_PATH, JSON.stringify(buildBootstrap(), null, 0), { mode: 0o600 });
  }
}

/** Read the whole DB. Cached until the file changes on disk. */
export function read(): Database {
  ensureFile();
  const mtime = fs.statSync(DB_PATH).mtimeMs;
  if (!cache || mtime !== cacheMtime) {
    cache = { ...EMPTY, ...(JSON.parse(fs.readFileSync(DB_PATH, "utf8")) as Database) };
    cacheMtime = mtime;

    // Self-healing: if connections are missing (e.g. from an empty cold-start /tmp file on Vercel),
    // restore the default connections from buildBootstrap()
    if (!cache.connections || cache.connections.length === 0) {
      const { buildBootstrap } = require("./bootstrap") as typeof import("./bootstrap");
      const boot = buildBootstrap();
      cache.connections = boot.connections;
      if (!cache.brands || cache.brands.length === 0) {
        cache.brands = boot.brands;
      }
      try {
        fs.writeFileSync(DB_PATH, JSON.stringify(cache, null, 0), { mode: 0o600 });
        cacheMtime = fs.statSync(DB_PATH).mtimeMs;
      } catch {}
    }
  }
  return cache;
}

/**
 * Apply a mutation and persist atomically (write-temp + rename), so a crash
 * mid-write can never leave a truncated database behind.
 */
export function mutate<T>(fn: (db: Database) => T): T {
  const db = read();
  const result = fn(db);
  const tmp = `${DB_PATH}.${process.pid}.tmp`;
  // The temp file inherits the same restriction, or the atomic rename would
  // publish a 0644 copy of the tokens on every single write.
  fs.writeFileSync(tmp, JSON.stringify(db, null, 0), { mode: 0o600 });
  fs.renameSync(tmp, DB_PATH);
  cacheMtime = fs.statSync(DB_PATH).mtimeMs;
  cache = db;
  return result;
}

/** Overwrite everything — used by the reseed endpoint. */
export function replaceAll(db: Database): void {
  ensureFile();
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 0), { mode: 0o600 });
  cache = db;
  cacheMtime = fs.statSync(DB_PATH).mtimeMs;
}

/**
 * Return the store to the bootstrap tenant shell, discarding every business
 * record. Named for what it does now: there is no seed dataset to restore.
 */
export function resetToBootstrap(): Database {
  const { buildBootstrap } = require("./bootstrap") as typeof import("./bootstrap");
  const fresh = buildBootstrap();
  replaceAll(fresh);
  return fresh;
}

/** Resolve the brand to operate on: explicit id, else the first brand. */
export function resolveBrandId(db: Database, brandId?: string | null): string {
  if (brandId && db.brands.some((b) => b.id === brandId)) return brandId;
  return db.brands[0]?.id ?? "";
}
