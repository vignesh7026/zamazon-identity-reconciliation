# Identity Reconciliation Service

A small REST service that links different orders on Zamazon.com back to the
same customer, even when the customer used a different email address and/or
phone number for each order.

This is a solution to the classic **Bitespeed identity-reconciliation**
problem, implemented in TypeScript + Express, backed by SQLite
(`better-sqlite3`) — no external database or network service required to run
it.

## How it works

Every purchase contact is stored as a `Contact` row:

```
id | phoneNumber | email | linkedId | linkPrecedence | createdAt | updatedAt | deletedAt
```

- The **first** contact seen for a person is `primary`.
- Any later contact that shares an email **or** phone with an existing
  cluster, but adds a new piece of information, is stored as `secondary` and
  linked (`linkedId`) to that cluster's primary.
- If a request's email matches one existing cluster and its phone matches a
  *different* existing cluster, those two clusters are merged: the **older**
  primary (by `createdAt`) stays primary, the newer one — and everything
  already linked to it — is demoted to secondary.

See `src/identify.ts` for the fully commented implementation.

## API

### `POST /identify`

Request body (at least one field required):

```json
{ "email": "doc@delorean.com", "phoneNumber": "1000000000" }
```

Response — `200 OK`:

```json
{
  "contact": {
    "primaryContactId": 1,
    "emails": ["doc@delorean.com", "marty@delorean.com"],
    "phoneNumbers": ["1000000000"],
    "secondaryContactIds": [2]
  }
}
```

- `emails` / `phoneNumbers` are de-duplicated, primary's values first.
- `400` is returned if neither `email` nor `phoneNumber` is provided.

### `GET /health`

Liveness/readiness probe used by Docker/Kubernetes.

## Running locally

```bash
npm install
npm run dev        # ts-node-dev, hot reload, uses ./data/dev.db
```

## Running the tests

```bash
npm test
```

12 integration tests cover: new-contact creation, secondary creation on new
info, no duplicate row for an already-known pair, the two-primaries merge
case, the "neither field provided" 400 error, email-only lookups, malformed
JSON handling, non-string field rejection, over-length field rejection,
missing framework fingerprint header, whitespace-only field rejection, and
a concurrency test proving two racing identical requests don't create
duplicate primaries.

## Hardening / edge cases

- **Generic error responses**: malformed JSON, validation failures, and
  unexpected server errors all return a short, generic message — never a
  raw parser error, stack trace, or SQL fragment. `X-Powered-By` is also
  disabled so the framework isn't fingerprinted for free.
- **Input validation**: non-string `email`/`phoneNumber` (e.g. a nested
  object or number) are rejected rather than silently coerced into a
  confusing string like `"[object Object]"`. Overly long fields (>320
  chars) are rejected outright rather than truncated, since truncation
  could make two different long inputs collide. Whitespace-only values are
  treated as absent.
- **Query performance**: all SQL statements are prepared once at module
  load and reused on every request instead of being re-parsed per call;
  `email`/`phoneNumber` are indexed (see `src/db.ts`).
- **Atomicity & concurrency**: the entire read-modify-write sequence in
  `identify()` runs inside a single `better-sqlite3` transaction. This
  makes multi-row merges atomic (a crash mid-merge can't leave contacts
  half-relinked) and prevents a race condition where two near-simultaneous
  identical requests could otherwise each see "no match" and create two
  separate primary contacts for the same person.

## Running with Docker

```bash
docker build -t identity-service .
docker run -p 3000:3000 -v identity-data:/app/data identity-service
```

or simply:

```bash
docker compose up --build
```

The container:
- Uses a multi-stage build (compile stage vs. slim `node:20-alpine` runtime).
- Runs as a non-root user.
- Has a `HEALTHCHECK` hitting `/health`.
- Reads `DATABASE_URL` / `PORT` from the environment (see `.env.example`) —
  nothing is hard-coded or baked into the image.

## Notes on the data layer

The assignment's reference schema was written against Prisma/Postgres. This
repo swaps in `better-sqlite3` for zero external setup while keeping the
exact same `Contact` shape (`id`, `phoneNumber`, `email`, `linkedId`,
`linkPrecedence`, `createdAt`, `updatedAt`, `deletedAt`). Moving to Postgres
in production only touches `src/db.ts`; `src/identify.ts` would need its raw
SQL swapped for the equivalent Postgres queries (or reintroducing an ORM),
but the reconciliation logic itself is unchanged.
