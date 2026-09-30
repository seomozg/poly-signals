/**
 * SQLite persistence for the signal catalog.
 *
 * The site owns its database (`data/poly_site.db`) and has no dependency
 * on any external service: the worker writes, the Next.js app reads.
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import {config} from './config';

/** Schema migrations, applied in order. `user_version` stores the last applied index. */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL,
    event_slug TEXT NOT NULL,
    market_id TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    question TEXT NOT NULL,
    outcome TEXT NOT NULL,
    market_price REAL NOT NULL,
    predicted_price REAL NOT NULL,
    edge REAL NOT NULL,
    recommendation TEXT NOT NULL DEFAULT 'BUY',
    reason_ru TEXT NOT NULL,
    reason_en TEXT NOT NULL,
    image TEXT,
    icon TEXT,
    volume REAL,
    liquidity REAL,
    current_price REAL,
    category TEXT,
    tags TEXT NOT NULL DEFAULT '[]',
    end_date TEXT,
    polymarket_url TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (event_id, market_id)
  );
  CREATE INDEX idx_signals_created_at ON signals(created_at DESC);
  CREATE INDEX idx_signals_edge ON signals(edge DESC);
  CREATE INDEX idx_signals_category ON signals(category);
  `
];

let cached: Database.Database | null = null;

/** Opens (and migrates) the shared SQLite connection. Cached per process. */
export function getDb(): Database.Database {
  if (cached) return cached;

  // Read the path at call time so tests can point DATABASE_PATH at a temp file.
  const file = process.env.DATABASE_PATH ?? config.databasePath;
  fs.mkdirSync(path.dirname(file), {recursive: true});

  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  const current = db.pragma('user_version', {simple: true}) as number;
  if (current < MIGRATIONS.length) {
    const migrate = db.transaction(() => {
      for (let i = current; i < MIGRATIONS.length; i++) {
        db.exec(MIGRATIONS[i]);
        db.pragma(`user_version = ${i + 1}`);
      }
    });
    migrate();
  }

  cached = db;
  return db;
}

/** Closes the connection (used by tests and the worker on shutdown). */
export function closeDb(): void {
  cached?.close();
  cached = null;
}
