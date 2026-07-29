# Soccerboard API

The backend for accounts, saved boards, and collaborative rooms. Express 5 on
Node 22+, Postgres via `pg`, and WebSockets synchronised across instances with
Postgres LISTEN/NOTIFY.

## Running it

```bash
npm --prefix server install

# 1. Start Postgres. Downloads real Postgres binaries on first run — no Docker,
#    no system install. Leave it running in its own terminal.
npm --prefix server run db

# 2. Start the API. Either one instance:
npm --prefix server start
#    …or a cluster behind a load balancer:
npm --prefix server run cluster
```

`npm run cluster` starts `INSTANCES` (default 3) separate processes on
PORT+1… and round-robins both HTTP and WebSocket traffic across them from
:8787. `GET /api/health` reports which instance answered.

In production, skip step 1 and point `DATABASE_URL` at a managed Postgres.

## Endpoints

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/health` | liveness |
| GET | `/api/auth/security-questions` | the canonical list; the client's dropdown is built from it |
| POST | `/api/auth/signup` | `{ email, password, acceptedTerms, securityQuestionId, securityAnswer }` — sets session cookie |
| POST | `/api/auth/login` | `{ email, password }` |
| POST | `/api/auth/password` | `{ currentPassword, password, securityQuestionId, securityAnswer }` — signs out every other session |
| POST | `/api/auth/forgot` | `{ email }` -> `{ question }`; every address gets one, so this cannot enumerate accounts |
| POST | `/api/auth/forgot/verify` | `{ email, answer }` -> `{ token }`; rate limited per address and per IP, failures only |
| POST | `/api/auth/reset` | `{ token, password }`; single use, destroys every session and closes its rooms |
| POST | `/api/auth/logout` | clears the session and closes its rooms |
| GET | `/api/auth/me` | current user, or 401 |
| DELETE | `/api/auth/me` | deletes the account; sessions and boards cascade |
| GET | `/api/boards?limit&cursor` | keyset page of the caller's boards |
| GET | `/api/boards/:id` | one board including its data and its `generation` |
| POST | `/api/boards` | `{ name, data }` |
| PUT | `/api/boards/:id` | `{ data, baseGeneration, name?, replacing? }`; 409 when the base has been superseded |
| PATCH | `/api/boards/:id` | rename only; a missing `name` is a 400, not a default |
| DELETE | `/api/boards/:id` | remove one board |
| GET | `/api/assistant/status` | whether the AI fallback is configured |
| POST | `/api/assistant` | `{ message, consent: true, … }` — 400 without consent |
| WS | `/ws?board=<id>` | join that board's room |

## Writing a board

`PUT` is not last-writer-wins. `boards.generation` is the lineage the contents
belong to; every write states the base it was made from in `baseGeneration`, and
the compare and the bump happen in one `UPDATE ... WHERE id = $ AND generation =
$`. A write whose base has been superseded is refused with **409** carrying the
generation the board is actually on, and the client answers that by re-reading
rather than by retrying on a base that would make the refused contents
acceptable.

**The generation moves only when `replacing` is true**, which the client sets
exactly when it will also broadcast `replaced` — undo, redo, reset, a format
change, answering a joiner. Ordinary autosaves do not move it, and that is the
whole reason this is usable: two people editing produce a steady alternation of
ordinary saves that already agree with each other, because the ops carried the
contents to everyone first, and refusing those would cost a board read and an
undo history every time for nothing.

`replacing` is a coordination signal among cooperating clients, **not an access
control**. A client that lies about it can only clobber a board it already has
write access to, which it can do with an ordinary write; `access.js` is what
decides who may write at all.

`baseGeneration` is required. An optional check is one an old bundle skips, and
the write it would skip is precisely the one this exists to refuse. Client and
server ship together, as they already must for the exact schema version check in
`src/lib/boardSchema.js`.

## How the five performance concerns are handled

**No `SELECT *`.** Every statement names its columns. The board list
deliberately omits the large `data` column, so listing pages stays cheap.

**No N+1.** A page of boards is one query. There is no "fetch ids, then fetch
each board" pattern anywhere; the session lookup is a single indexed join
rather than a session query followed by a user query.

**Pagination is keyset, not `OFFSET`.** `OFFSET` makes the database walk and
throw away every skipped row, so deep pages get progressively slower. Paging
from the last row read stays flat. Cursors are `updated_at|id`, and `limit` is
clamped to 100.

**Indexes cover every filter, join, and sort.** Verified with `EXPLAIN` — the
hot paths use index scans, not sequential scans:

- `idx_users_email` (unique) — login lookup, and the race-free duplicate check
- `idx_sessions_token` (unique) — hit on every authenticated request
- `idx_boards_user_updated` on `(user_id, updated_at DESC, id DESC)` — one
  composite index serving both halves of the keyset query
- `idx_sessions_expiry` — the hourly sweep of dead sessions

**Connection pooling** is real now that the database is Postgres. Every
connection is a TCP socket plus a backend process on the server, both expensive
to create, so `pg.Pool` keeps a small set warm and hands them out per query.
`PG_POOL_MAX` is *per instance* — the database sees up to `INSTANCES × max`,
which is why the default is a modest 10 rather than "as many as possible".

**Schema migrations take an advisory lock.** `CREATE TABLE IF NOT EXISTS` is
not atomic against concurrent DDL: two instances booting together can both find
a table missing and then collide inserting into the system catalogue. The lock
serialises them — one migrates, the rest wait and find the work done.

## Security

**Passwords** are stored as scrypt digests (N=16384, r=8, p=1) with a
per-user random salt, and compared in constant time. scrypt is memory-hard by
design, so guessing is expensive — unlike a bare SHA-256, which a GPU can try
billions of times a second. The password itself is never written anywhere.

**Injection** is structurally impossible rather than filtered: every value is a
bound parameter, never string-concatenated into SQL. A board named
`Robert'); DROP TABLE boards;--` is stored and returned as ordinary text.

**Validation runs on the server** for every request. The client validates too,
but only for fast feedback — it is not a control, since anyone can post
directly to the API.

**Rate limiting** works on two axes, because they catch different attacks: a
per-account lockout (5 failures → 15 minutes) stops someone guessing one
person's password, and a per-IP limit (30 attempts / 10 minutes) stops one
common password being sprayed across many accounts. Both live in the database,
so they survive a restart and hold across processes. Signups are capped per IP.

Every counter is **one statement**, an upsert whose `DO UPDATE` reads
`login_attempts.count + 1` and expresses the window, the lockout and the
held-lock cases as SQL. That is the difference between a limiter and a
suggestion: read-then-write let concurrent requests all read the same count and
all write the same value, so the allowance never fired under exactly the
parallel traffic it exists to stop. Allowances keyed on values a stranger
chooses are hashed, never stored verbatim, and swept hourly.

**`APP_ENV` is a security setting**, not a label. `production` marks the session
cookie `Secure` and sends HSTS on secure requests; `development` and `test` may
fall back to an encryption key derived from `SESSION_SECRET`, and nothing else
may. An unrecognised value stops the process at boot rather than quietly
choosing the permissive branch, which is what `NODE_ENV=staging` used to do to
both controls at once. `NODE_ENV` is still read when `APP_ENV` is unset.

**Response headers**: `X-Content-Type-Options`, `Referrer-Policy`,
`X-Frame-Options`, and a `Content-Security-Policy` of `default-src 'none';
base-uri 'none'; form-action 'none'; frame-ancestors 'none'` — every response
here is JSON, so the policy permits nothing at all. The document policy for the
app belongs on whatever serves `index.html`, which does not pass through here.

**The WebSocket upgrade checks `Origin`**, because a handshake bypasses CORS
entirely and `SameSite=Lax` would otherwise be the only thing stopping a
cross-site, cookie-carrying connection into a room. Requests with no `Origin`
(non-browser clients, the test suite) are allowed; a browser always sends one.

**The assistant's online fallback requires `consent: true` in the request
body**, answers 400 without it, and records the grant in `assistant_consents`.
Consent enforced only by the panel that asks for it is not enforced.

**Sessions** are opaque random tokens in an `HttpOnly`, `SameSite=Lax` cookie
(`Secure` in production). Only the SHA-256 of a token is stored, so a leaked
database yields no usable cookies, and any session can be revoked by deleting
one row.

**Deleting the row is only half of revoking it.** REST reads the row on every
request, so the next call is refused at once; a WebSocket is authorized once,
during the handshake, and never again, so it carries on relaying edits in both
directions until the tab closes. Every path that deletes from `sessions` goes
through `src/sessions.js`, which publishes an `evict-session` control message on
the same LISTEN/NOTIFY bus the rest of the cluster runs on, and every instance
closes the matching sockets in every room it holds. Evictions are matched on the
session, not on the user, so signing out of one browser does not close another,
and changing a password does not close the replacement session it just minted.
`src/sessionRevocation.test.js` holds this across two instances.

**Login responses do not leak account existence**: a wrong password and an
unknown address both return `Incorrect email or password.`

## Running several instances

Nothing is kept in process memory, which is what makes horizontal scaling work:

- **Sessions** live in Postgres, so a cookie issued by one instance is accepted
  by every other.
- **Rate limits and lockouts** are database rows updated with an atomic upsert,
  so five failures spread across five processes still lock the account. An
  in-memory counter would have let an attacker get five tries *per instance*.
- **Rooms** are synchronised over LISTEN/NOTIFY (below), so no sticky sessions.

## Collaborative rooms

`GET /ws?board=<id>` upgrades to a WebSocket. The session cookie is checked the
same way as on the REST API, and board ownership is verified server-side — a
socket is not a way around authorisation.

Ops are relayed to everyone else in the room. Since a socket is connected to
exactly one instance, the broadcast has to reach the others: each instance
publishes with `pg_notify` and every instance `LISTEN`s, relaying to its own
sockets. Messages carry the originating instance id so an instance ignores its
own echo and nothing is applied twice.

Postgres is the bus, so there is no Redis and no shared memory. The `LISTEN`
connection is a dedicated client, not a pooled one — a pooled client would be
returned to the pool and stop receiving notifications.

Server-side guarantees:

- `peerId` is stamped by the server, so a client cannot impersonate another.
- Payloads over ~6 KB are dropped (`NOTIFY` caps at 8 KB).
- Unauthenticated sockets close with 4401, wrong-owner sockets with 4403.

## Not done yet

Board *names* are stored unencrypted, deliberately, so the picker can sort
without decrypting every row.

The notification bus does not buffer. Losing the `LISTEN` connection is retried
every two seconds, and ops published during the gap reach this instance's own
sockets and are logged as unpublished rather than held for replay. Rooms
reconverge on the next whole-board `replaced`, not on their own.
