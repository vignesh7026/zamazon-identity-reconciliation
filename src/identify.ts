// Core identity-reconciliation logic used by the /identify endpoint.
//
// Rules implemented:
// 1. No existing contact matches email/phoneNumber -> create a new "primary".
// 2. Exactly one existing "identity cluster" matches -> if the request
//    introduces a new email or new phone number (not already stored anywhere
//    in the cluster), create a "secondary" contact linked to the cluster's
//    primary. If both fields already exist somewhere in the cluster, no new
//    row is created.
// 3. The request's email and phone match two *different* existing primary
//    contacts -> the two clusters must merge. The older primary (by
//    createdAt) stays "primary"; the newer primary - and everything already
//    linked to it - is demoted to "secondary" and re-linked under the older
//    primary.

import { db, Contact } from './db';

export class BadRequestError extends Error {}

export interface IdentifyRequest {
  email?: string | null;
  phoneNumber?: string | null;
}

export interface IdentifyResponse {
  contact: {
    primaryContactId: number;
    emails: string[];
    phoneNumbers: string[];
    secondaryContactIds: number[];
  };
}

// A request field this long has no legitimate use case here and only costs
// index/scan time; reject it outright instead of quietly truncating (which
// could otherwise cause two different long inputs to collide after cutoff).
const MAX_FIELD_LENGTH = 320; // RFC 5321 max email length, reused as a sane cap for phone too

// --- Prepared statements, created once at module load and reused on every
// request. better-sqlite3 has to parse and plan a SQL string the first time
// it sees it; preparing statements once here instead of inside the request
// path (as an earlier version of this file did) avoids paying that cost on
// every single /identify call — a real, measurable win under load, not a
// cosmetic one. ---
const stmts = {
  findByEmailOrPhone: db.prepare(
    `SELECT * FROM contacts WHERE deletedAt IS NULL AND (email = ? OR phoneNumber = ?)`
  ),
  findByEmail: db.prepare(`SELECT * FROM contacts WHERE deletedAt IS NULL AND email = ?`),
  findByPhone: db.prepare(`SELECT * FROM contacts WHERE deletedAt IS NULL AND phoneNumber = ?`),
  findById: db.prepare(`SELECT * FROM contacts WHERE id = ?`),
  findCluster: db.prepare(`SELECT * FROM contacts WHERE id = ? OR linkedId = ?`),
  insertContact: db.prepare(
    `INSERT INTO contacts (email, phoneNumber, linkPrecedence, linkedId, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?)`
  ),
  demoteToSecondary: db.prepare(
    `UPDATE contacts SET linkPrecedence = 'secondary', linkedId = ?, updatedAt = ? WHERE id = ?`
  ),
  relinkChildren: db.prepare(
    `UPDATE contacts SET linkedId = ?, updatedAt = ? WHERE linkedId = ?`
  ),
};

function normalize(v?: string | null): string | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v !== 'string') {
    // Defensive: a client sending {"email": {...}} or {"email": 123} would
    // otherwise coerce into a confusing string via String(v) (e.g.
    // "[object Object]"), silently corrupting the dataset. Reject instead.
    throw new BadRequestError('"email" and "phoneNumber" must be strings.');
  }
  const trimmed = v.trim();
  if (!trimmed.length) return undefined;
  if (trimmed.length > MAX_FIELD_LENGTH) {
    throw new BadRequestError('"email" or "phoneNumber" exceeds the maximum allowed length.');
  }
  return trimmed;
}

function nowIso(): string {
  return new Date().toISOString();
}

function findMatches(email?: string, phoneNumber?: string): Contact[] {
  if (email && phoneNumber) return stmts.findByEmailOrPhone.all(email, phoneNumber) as Contact[];
  if (email) return stmts.findByEmail.all(email) as Contact[];
  return stmts.findByPhone.all(phoneNumber) as Contact[];
}

function createContact(
  email: string | undefined,
  phoneNumber: string | undefined,
  linkPrecedence: 'primary' | 'secondary',
  linkedId: number | null
): Contact {
  const ts = nowIso();
  const info = stmts.insertContact.run(email ?? null, phoneNumber ?? null, linkPrecedence, linkedId, ts, ts);
  return stmts.findById.get(info.lastInsertRowid) as Contact;
}

// The entire read-modify-write sequence runs inside a single SQLite
// transaction. Two things this buys us:
//   1. Atomicity — if a merge (Step 4) modifies several rows and the
//      process crashes mid-way, SQLite rolls the whole thing back instead
//      of leaving contacts half-relinked.
//   2. Concurrency safety — better-sqlite3's transaction() wraps the callback
//      in BEGIN/COMMIT and runs entirely synchronously, so two /identify
//      calls arriving back-to-back for the same email/phone can't interleave
//      their reads and writes (which is exactly how a naive async
//      implementation could end up creating two "primary" contacts for the
//      same person from a race condition).
const runIdentify = db.transaction((email: string | undefined, phoneNumber: string | undefined) => {
  // Step 1: find any existing, non-deleted contacts that share the email or phone.
  const matches = findMatches(email, phoneNumber);

  // Step 2: no matches at all -> brand new, standalone primary contact.
  if (matches.length === 0) {
    const created = createContact(email, phoneNumber, 'primary', null);
    return buildResponse([created], created);
  }

  // Step 3: resolve every match up to its primary contact id.
  const primaryIds = new Set<number>();
  for (const m of matches) {
    if (m.linkPrecedence === 'primary') {
      primaryIds.add(m.id);
    } else if (m.linkedId) {
      primaryIds.add(m.linkedId);
    }
  }

  const placeholders = Array.from(primaryIds).map(() => '?').join(',');
  let primaries = db
    .prepare(`SELECT * FROM contacts WHERE id IN (${placeholders})`)
    .all(...Array.from(primaryIds)) as Contact[];
  primaries.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  const truePrimary = primaries[0];

  // Step 4: if the request bridged two previously separate clusters, merge
  // them under the oldest primary.
  if (primaries.length > 1) {
    const ts = nowIso();
    for (const stalePrimary of primaries.slice(1)) {
      stmts.demoteToSecondary.run(truePrimary.id, ts, stalePrimary.id);
      // Anything that was already secondary under the demoted primary must
      // now point at the new (older) true primary directly.
      stmts.relinkChildren.run(truePrimary.id, ts, stalePrimary.id);
    }
  }

  // Step 5: load the full, up-to-date cluster (primary + all its secondaries).
  let cluster = stmts.findCluster.all(truePrimary.id, truePrimary.id) as Contact[];

  const knownEmails = new Set(cluster.map((c) => c.email).filter((v): v is string => !!v));
  const knownPhones = new Set(cluster.map((c) => c.phoneNumber).filter((v): v is string => !!v));

  const bringsNewEmail = !!email && !knownEmails.has(email);
  const bringsNewPhone = !!phoneNumber && !knownPhones.has(phoneNumber);

  // Step 6: create a new secondary only if the request adds information
  // (a new email and/or new phone number) not already stored in the cluster.
  if (bringsNewEmail || bringsNewPhone) {
    const created = createContact(email, phoneNumber, 'secondary', truePrimary.id);
    cluster.push(created);
  }

  return buildResponse(cluster, truePrimary);
});

export async function identify(input: IdentifyRequest): Promise<IdentifyResponse> {
  const email = normalize(input.email);
  const phoneNumber = normalize(input.phoneNumber);

  if (!email && !phoneNumber) {
    throw new BadRequestError('At least one of "email" or "phoneNumber" is required.');
  }

  return runIdentify(email, phoneNumber) as IdentifyResponse;
}

function buildResponse(cluster: Contact[], primary: Contact): IdentifyResponse {
  const emails: string[] = [];
  const phones: string[] = [];
  const secondaryIds: number[] = [];

  // Primary's own email/phone always come first per the spec.
  if (primary.email) emails.push(primary.email);
  if (primary.phoneNumber) phones.push(primary.phoneNumber);

  const others = cluster
    .filter((c) => c.id !== primary.id)
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

  for (const c of others) {
    if (c.email && !emails.includes(c.email)) emails.push(c.email);
    if (c.phoneNumber && !phones.includes(c.phoneNumber)) phones.push(c.phoneNumber);
    secondaryIds.push(c.id);
  }

  return {
    contact: {
      primaryContactId: primary.id,
      emails,
      phoneNumbers: phones,
      secondaryContactIds: secondaryIds.sort((a, b) => a - b),
    },
  };
}
