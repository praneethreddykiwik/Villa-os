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
/**
 * Where the store lives.
 *
 * On a serverless host the deployment directory is read-only and only /tmp can
 * be written. Detecting that from environment variables alone is not reliable:
 * this broke in production with
 *
 *     ENOENT: no such file or directory, mkdir '/var/task/.data'
 *
 * because Vercel's "Automatically expose System Environment Variables" setting
 * was off, so `VERCEL` was unset and the writable-path branch never ran. Every
 * page backed by this store returned a server error while the Postgres-backed
 * pages were fine.
 *
 * So the env check is only a fast path. The real guarantee is behavioural:
 * `writableDir()` below tries the chosen directory and falls back to /tmp when
 * the filesystem actually refuses, which no dashboard toggle can defeat.
 */
const PREFERRED_DIR = process.env.OPS_DATA_DIR
  ? path.resolve(process.env.OPS_DATA_DIR)
  : process.env.VERCEL ||
    process.env.VERCEL_ENV ||
    process.env.AWS_LAMBDA_FUNCTION_NAME ||
    process.env.LAMBDA_TASK_ROOT
  ? path.join("/tmp", ".data")
  : path.join(process.cwd(), ".data");

const FALLBACK_DIR = path.join("/tmp", ".data");

/** Codes a read-only or non-existent deployment directory raises. */
const NOT_WRITABLE = new Set(["EROFS", "EACCES", "EPERM", "ENOENT"]);

let resolvedDir: string | null = null;

/**
 * The first directory that actually accepts a write. Resolved once per process;
 * an explicit OPS_DATA_DIR is honoured as-is so tests stay isolated.
 */
function dataDir(): string {
  if (resolvedDir) return resolvedDir;
  const candidates = process.env.OPS_DATA_DIR
    ? [PREFERRED_DIR]
    : PREFERRED_DIR === FALLBACK_DIR
      ? [FALLBACK_DIR]
      : [PREFERRED_DIR, FALLBACK_DIR];

  let lastError: unknown = null;
  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.accessSync(dir, fs.constants.W_OK);
      resolvedDir = dir;
      return dir;
    } catch (e) {
      lastError = e;
      const code = (e as NodeJS.ErrnoException).code ?? "";
      // Anything other than "the filesystem said no" is a real fault worth
      // surfacing rather than papering over with a silent fallback.
      if (!NOT_WRITABLE.has(code)) throw e;
    }
  }
  throw lastError ?? new Error("No writable data directory found.");
}

function dbPath(): string {
  return path.join(dataDir(), "db.json");
}

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
  voiceCallQueue: [],
  voiceAgentConfigs: [],
  inventoryUnits: [],
  ...EMPTY_OPS,
};

let cache: Database | null = null;
let cacheMtime = 0;

function ensureFile(): void {
  if (!fs.existsSync(dataDir())) fs.mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
  if (!fs.existsSync(dbPath())) {
    // If a seeded db exists in the repo bundle, copy it to the writable store
    const repoSeed = path.join(process.cwd(), "src", "lib", "seed-db.json");
    const dotDataSeed = path.join(process.cwd(), ".data", "db.json");
    const seedToUse = fs.existsSync(repoSeed) ? repoSeed : fs.existsSync(dotDataSeed) ? dotDataSeed : null;
    if (seedToUse && seedToUse !== dbPath()) {
      try {
        fs.copyFileSync(seedToUse, dbPath());
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
    fs.writeFileSync(dbPath(), JSON.stringify(buildBootstrap(), null, 0), { mode: 0o600 });
  }
}

/** Read the whole DB. Cached until the file changes on disk. */
export function read(): Database {
  ensureFile();
  const mtime = fs.statSync(dbPath()).mtimeMs;
  if (!cache || mtime !== cacheMtime) {
    cache = { ...EMPTY, ...(JSON.parse(fs.readFileSync(dbPath(), "utf8")) as Database) };
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
        fs.writeFileSync(dbPath(), JSON.stringify(cache, null, 0), { mode: 0o600 });
        cacheMtime = fs.statSync(dbPath()).mtimeMs;
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
  const tmp = `${dbPath()}.${process.pid}.tmp`;
  // The temp file inherits the same restriction, or the atomic rename would
  // publish a 0644 copy of the tokens on every single write.
  fs.writeFileSync(tmp, JSON.stringify(db, null, 0), { mode: 0o600 });
  fs.renameSync(tmp, dbPath());
  cacheMtime = fs.statSync(dbPath()).mtimeMs;
  cache = db;
  return result;
}

/** Overwrite everything — used by the reseed endpoint. */
export function replaceAll(db: Database): void {
  ensureFile();
  fs.writeFileSync(dbPath(), JSON.stringify(db, null, 0), { mode: 0o600 });
  cache = db;
  cacheMtime = fs.statSync(dbPath()).mtimeMs;
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
