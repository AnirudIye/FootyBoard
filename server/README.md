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
| POST | `/api/auth/signup` | `{ email, password, acceptedTerms }` — sets session cookie |
| POST | `/api/auth/login` | `{ email, password }` |
| POST | `/api/auth/logout` | clears the session |
| GET | `/api/auth/me` | current user, or 401 |
| DELETE | `/api/auth/me` | deletes the account; sessions and boards cascade |
| GET | `/api/boards?limit&cursor` | keyset page of the caller's boards |
| GET | `/api/boards/:id` | one board including its data |
| POST | `/api/boards` | `{ name, data }` |
| PUT | `/api/boards/:id` | replace name and data |
| PATCH | `/api/boards/:id` | rename only |
| DELETE | `/api/boards/:id` | remove one board |
| WS | `/ws?board=<id>` | join that board's room |

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

**Sessions** are opaque random tokens in an `HttpOnly`, `SameSite=Lax` cookie
(`Secure` in production). Only the SHA-256 of a token is stored, so a leaked
database yields no usable cookies, and any session can be revoked by deleting
one row.

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

The frontend does not open a socket. The rooms work — proven with two sockets
pinned to different instances exchanging an op — but the board UI still saves
over REST and does not yet broadcast or apply live ops. That needs an op
protocol for board mutations and a merge strategy for simultaneous edits, which
is a design decision rather than plumbing.

There is also no password reset, and board *names* are stored unencrypted so
the list can be sorted without decrypting every row.
