// Thin, dependency-light data layer on top of better-sqlite3.
// better-sqlite3 is synchronous under the hood, which is fine here since
// SQLite itself only ever serializes writes anyway; we still expose an
// async-shaped API from identify.ts so swapping to Postgres later is a
// contained change.
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const dbPath = process.env.DATABASE_URL ?? path.join(__dirname, '..', 'data', 'dev.db');

// Ensure the containing directory exists (matters for the Docker image,
// where we point at /app/data/prod.db).
const dir = path.dirname(dbPath);
if (dbPath !== ':memory:' && dir !== '.' && !fs.existsSync(dir)) {
  fs.mkdirSync(dir, { recursive: true });
}

export const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS contacts (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    phoneNumber    TEXT,
    email          TEXT,
    linkedId       INTEGER,
    linkPrecedence TEXT NOT NULL DEFAULT 'primary',
    createdAt      TEXT NOT NULL,
    updatedAt      TEXT NOT NULL,
    deletedAt      TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_contacts_email ON contacts(email);
  CREATE INDEX IF NOT EXISTS idx_contacts_phone ON contacts(phoneNumber);
`);

export interface Contact {
  id: number;
  phoneNumber: string | null;
  email: string | null;
  linkedId: number | null;
  linkPrecedence: 'primary' | 'secondary';
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}
