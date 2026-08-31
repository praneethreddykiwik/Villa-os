import fs from "node:fs";
import path from "node:path";
import type { Database } from "./types";

/**
 * Storage is a single JSON document behind a narrow repository interface.
 *
 * Why: it makes the whole system runnable with `npm run dev` and nothing else —
 * no Postgres, no Docker, no migrations — while keeping every read/write funnelled
 * through `read()` / `mutate()`. Swapping in Postgres/Drizzle later means
 * reimplementing exactly those two functions; no page or engine touches storage
 * directly.
 */

const DATA_DIR = path.join(process.cwd(), ".data");
const DB_PATH = path.join(DATA_DIR, "db.json");

const EMPTY: Database = {
  workspaces: [],
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
};

let cache: Database | null = null;
let cacheMtime = 0;

function ensureFile(): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_PATH)) {
    // Lazily seed on first read so a fresh clone boots with a populated demo brand.
    const { buildSeed } = require("./seed") as typeof import("./seed");
    fs.writeFileSync(DB_PATH, JSON.stringify(buildSeed(), null, 0));
  }
}

/** Read the whole DB. Cached until the file changes on disk. */
export function read(): Database {
  ensureFile();
  const mtime = fs.statSync(DB_PATH).mtimeMs;
  if (!cache || mtime !== cacheMtime) {
    cache = { ...EMPTY, ...(JSON.parse(fs.readFileSync(DB_PATH, "utf8")) as Database) };
    cacheMtime = mtime;
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
  fs.writeFileSync(tmp, JSON.stringify(db, null, 0));
  fs.renameSync(tmp, DB_PATH);
  cacheMtime = fs.statSync(DB_PATH).mtimeMs;
  cache = db;
  return result;
}

/** Overwrite everything — used by the reseed endpoint. */
export function replaceAll(db: Database): void {
  ensureFile();
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 0));
  cache = db;
  cacheMtime = fs.statSync(DB_PATH).mtimeMs;
}

export function resetToSeed(): Database {
  const { buildSeed } = require("./seed") as typeof import("./seed");
  const fresh = buildSeed();
  replaceAll(fresh);
  return fresh;
}

/** Resolve the brand to operate on: explicit id, else the first brand. */
export function resolveBrandId(db: Database, brandId?: string | null): string {
  if (brandId && db.brands.some((b) => b.id === brandId)) return brandId;
  return db.brands[0]?.id ?? "";
}
