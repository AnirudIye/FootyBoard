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

In production, skip step 1 and point `DATABASE_URL` at a managed Postgres. Do
not point it at a superuser: provision the restricted role with
`sql/runtime-role.sql` and require TLS with `sslmode=verify-full`. See **The
database credential** below, which is also where the migration-role question is
settled.

## Endpoints

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/health` | liveness |
| GET | `/api/auth/security-questions` | the canonical list; the client's dropdown is built from it |
| POST | `/api/auth/signup` | `{ email, password, acceptedTerms, securityQuestionId, securityAnswer, displayName }` — sets session cookie. `displayName` is **required**: presence falls back to the address without one |
| POST | `/api/auth/claim` | same body as signup; attaches credentials to the **guest** account the caller already holds, keeping its boards. Refused for an account that already has a password |
| PATCH | `/api/auth/display-name` | `{ displayName }`; no current password, and open to a guest. A name may not contain `@` |
| POST | `/api/auth/login` | `{ email, password }` -> `{ user, challenge }`, exactly one of them null. A challenge means **no session was minted**; see Two-step sign-in |
| POST | `/api/auth/login/2fa` | `{ token, code }` -> `{ user }` and the session cookie. The challenge is spent whether the code is right or wrong |
| GET | `/api/auth/2fa` | `{ enabled, remainingRecoveryCodes }`; never the codes themselves |
| POST | `/api/auth/2fa/enroll` | `{ currentPassword }` -> `{ secret, uri }`; writes an **unconfirmed** secret and turns nothing on. Refused for a guest, and for an account that already has it on |
| POST | `/api/auth/2fa/confirm` | `{ code }` -> `{ recoveryCodes }`; the only path that turns the factor on, and the only place the ten codes are ever said |
| POST | `/api/auth/2fa/disable` | `{ currentPassword, code }`; clears the secret, the codes and any pending challenge in one transaction. Sessions are deliberately left alone |
| POST | `/api/auth/2fa/recovery-codes` | `{ currentPassword, code }` -> `{ recoveryCodes }`; replaces all ten in the statement that writes them |
| POST | `/api/auth/password` | `{ currentPassword, password, securityQuestionId, securityAnswer }` — signs out every other session |
| POST | `/api/auth/sessions` | `{ currentPassword }` — ends every session and changes nothing else; mints one for the caller and sets the cookie. Refused for a guest, which has no password to check |
| POST | `/api/auth/forgot` | `{ email }` -> `{ question }`; every address gets one, so this cannot enumerate accounts |
| POST | `/api/auth/forgot/verify` | `{ email, answer }` -> `{ token, challenge, expiresInMinutes }`, one of the first two null; a factor account gets the challenge and **no reset token**. Rate limited per address and per IP, failures only |
| POST | `/api/auth/forgot/2fa` | `{ token, code }` -> `{ token, expiresInMinutes }`; spends a `reset`-purpose challenge for the reset token |
| POST | `/api/auth/reset` | `{ token, password }`; single use, destroys every session and closes its rooms. Never touches the second factor |
| POST | `/api/auth/logout` | clears the session and closes its rooms |
| GET | `/api/auth/me` | current user, or 401 |
| DELETE | `/api/auth/me` | `{ currentPassword, code? }`; deletes the account, boards cascade |
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
- `idx_revocations_at` — both readers of `session_revocations`: an instance
  catching up asks for rows newer than its watermark, the hourly sweep for rows
  older than the retention, and nothing ever looks one up by session or user

**Connection pooling** is real now that the database is Postgres. Every
connection is a TCP socket plus a backend process on the server, both expensive
to create, so `pg.Pool` keeps a small set warm and hands them out per query.
`PG_POOL_MAX` is *per instance* — the database sees up to `INSTANCES × max`,
which is why the default is a modest 10 rather than "as many as possible".

**Schema migrations take an advisory lock.** `CREATE TABLE IF NOT EXISTS` is
not atomic against concurrent DDL: two instances booting together can both find
a table missing and then collide inserting into the system catalogue. The lock
serialises them — one migrates, the rest wait and find the work done.

## The database credential

`DATABASE_URL` is the most powerful secret this service holds, and for most of
its life it was worth considerably more than anyone using it assumed.

The API connects as `soccerboard`, which is SUPERUSER, and CREATEROLE, CREATEDB,
BYPASSRLS and REPLICATION besides, and which owns every table. So the string is
not a grant to read and write the application's data. It is control of the
Postgres host: the same credential the API uses for `SELECT` will serve
`DROP TABLE boards`, `TRUNCATE`, `ALTER`, `CREATE ROLE`, and `COPY ... TO
PROGRAM`, which is a shell. **There is no backup behind board data**, so the
destructive half of that list is not an incident anyone recovers from, and the
ways a connection string escapes are mundane: a log line, a screenshot, a stack
trace in a bug report, an environment variable copied into the wrong project.

### The runtime role

`sql/runtime-role.sql` provisions the role production should actually connect
as. Run it once against the database, as a superuser or as the role that owns
the tables:

```bash
psql "$ADMIN_DATABASE_URL" -f server/sql/runtime-role.sql
# then set the password out of band, so it never lands in a file or a history:
psql "$ADMIN_DATABASE_URL" -c "ALTER ROLE soccerboard_app PASSWORD '…'"
```

It creates a role with `CONNECT` on the database, `USAGE` on the schema,
`SELECT/INSERT/UPDATE/DELETE` on the tables, `USAGE` on sequences, and nothing
else. No superuser, no ownership, no `CREATE`. Point `DATABASE_URL` at it and a
leaked connection string is worth what people already thought it was worth.

The grants are `ON ALL TABLES IN SCHEMA public` plus `ALTER DEFAULT PRIVILEGES`
rather than a list of table names, and that is not tidiness. A list is correct on
the day it is written and wrong at the next migration, and it fails in
production rather than in the test that added the table. `ALTER DEFAULT
PRIVILEGES` attaches to the role that creates objects, which is why the file
asks who that is: name the wrong one and every table added after today lands
outside the default, with the failure arriving a release later.

`src/databasePrivileges.test.js` holds the whole boundary as assertions against
the real database, including a table created after provisioning to prove the
default privileges actually work.

**What it does not buy.** `DELETE FROM boards` still works, and no arrangement of
grants can prevent it while the application is still able to delete a board: the
hourly sweeps and the cascade behind account deletion are unqualified deletes the
API issues itself. The role confines the damage to rows, inside a schema that
survives, by a credential that cannot then rewrite the tables or reach the host.
That is a real reduction and it is not the same thing as safety. The control that
would close it is a backup, which this deployment does not have.

### Why the runtime role is not the migration role

`migrate()` runs DDL on every boot, so a role without `CREATE` cannot start the
app at all. It fails on the first statement:

```
migrate() as the runtime role
  ERROR:  permission denied for schema public
  SQLSTATE: 42501
```

The tempting objection is that the statements are all `IF NOT EXISTS`, so against
an existing schema they change nothing and ought to be free. They are not.
Postgres checks the schema privilege **before** it checks existence, so
`CREATE TABLE IF NOT EXISTS users` is refused even though `users` is right there
and the statement would have done nothing. `ALTER TABLE ... ADD COLUMN IF NOT
EXISTS` and `CREATE INDEX IF NOT EXISTS` fail the same way, on ownership. There
is no arrangement of grants that lets a role run this migration without also
letting it drop the tables, because they are the same privilege.

So the two cannot be one role, and the question is what to do about it.

### What to do at deploy time

**The recommendation is two roles: a privileged one that migrates and a
restricted one that serves.** It is the only option that actually closes the
finding, because any arrangement where the serving credential can run `migrate()`
is one where the serving credential can drop the tables.

The cost, stated plainly rather than buried: **the deploy gains an ordered
step.** The migration runs first,
under the privileged URL, and only then do the instances roll with the restricted
one. What you are spending is the property `migrate()` was built for, which is
that several instances can boot simultaneously and the advisory lock sorts them
out, with no separate migration stage to forget or to sequence. You also lose
atomicity between schema and code: skip the step and the instances come up
against an old schema and fail at query time, later and further from the cause
than a failed boot would have been.

**The switch that makes it possible now exists**, and the sequence is:

```bash
# 1. Apply the schema, under the URL that owns the tables. Once, before any
#    instance rolls.
DATABASE_URL="$ADMIN_DATABASE_URL" npm --prefix server run migrate

# 2. Roll the instances with the restricted URL and the boot migration off.
RUN_MIGRATIONS=false DATABASE_URL="$RUNTIME_DATABASE_URL" npm --prefix server start
```

`RUN_MIGRATIONS` is read the way `RUN_MAINTENANCE` is: anything but the literal
`false` migrates, so an unset value is exactly today's behaviour and nobody who
ignores this pays anything. `scripts/migrate.js` deliberately does **not**
consult it — whoever runs that command is precisely the person who has set it to
`false` on that host, so honouring it there would turn the migration step into a
no-op reporting success, which is the one failure that would make this
arrangement worse than not having it.

Proved rather than reasoned about: `databasePrivileges.test.js` starts a real
instance as the restricted role with `RUN_MIGRATIONS=false` and asserts it
serves, beside the older test asserting that the same role cannot run
`migrate()`. The two together are the whole argument.

**What is deployable today, with no code change at all, is the middle rung:
connect as a non-superuser role that owns the tables.** That keeps boot-time
migration exactly as it is, and it still removes most of the finding. Verified
against the real database rather than assumed: such a role runs `migrate()` to
completion, and is refused `pg_authid`, `COPY ... TO PROGRAM`,
`ALTER ROLE ... SUPERUSER`, and every table belonging to any other role. What it
keeps is `DROP`, `TRUNCATE` and `ALTER` on its own tables, which is precisely the
part that needs the two-role split to remove. It is strictly better than a
superuser and strictly worse than the runtime role, and it is one `ALTER TABLE
... OWNER TO` away.

**The test suite stays on a privileged URL, deliberately.** Twenty-one of the
twenty-nine files in `src/*.test.js` call `migrate()`, so pointing the suite at
the runtime role would fail every one of them for the right reason. The suite
runs against the development database as `soccerboard`; that is not the thing
being hardened. The one test that does connect as the runtime role starts its
own instance with `RUN_MIGRATIONS=false`, which is the deployment being
described rather than the suite changing roles.

### TLS on the connection

`pg` does not negotiate TLS unless it is asked to, and nothing in this repo asks.
Against a managed Postgres that means the password and every board row cross
somebody else's network in cleartext, which undoes the encryption at rest that
`ENCRYPTION_KEY` provides in the one place the data is easiest to intercept.

Set it in the connection string, which is the only place it can be set without
changing `db.js`:

```
DATABASE_URL=postgres://soccerboard_app:…@db.example.com:5432/app?sslmode=verify-full
```

**`sslmode` does not mean here what it means in `psql`**, and that is worth
knowing before you go and test a connection string. libpq reads `require` as
"encrypt but verify nothing", which stops passive capture and not an active
attacker who can answer for the host. node-postgres does not follow libpq:
`pg-connection-string` treats `prefer`, `require` and `verify-ca` as aliases for
`verify-full`, and emits a security warning asking you to say what you mean. So a
URL proved out with `psql` has proved nothing about what this process will
accept, and the discrepancy runs in both directions. Write `verify-full` and the
two agree.

`verify-full` requires the server certificate to chain to a trusted CA and to
match the hostname; add `&sslrootcert=/path/to/ca.pem` where the system trust
store does not carry the provider's CA. `uselibpqcompat=true` switches the driver
back to libpq's weaker reading, and is named here only so it is not mistaken for
a fix. Local development stays plain: it is a loopback socket to a database this
repo started, so there is no network to protect.

### The deploy checklist now mentions all of this

This section used to be a complaint, and it is kept as a resolved one because the
gap it described is the kind that reopens. `handoff.md` treated four environment
variables as the deploy (`APP_ENV`, `SESSION_SECRET`, `ENCRYPTION_KEY` and
`TRUST_PROXY`) and **`DATABASE_URL` was not among them**, which is how the most
powerful secret here ended up being the one nobody was asked to think about. That
checklist now carries it, says which role it should name, and says the two-role
split makes the migration an ordered step rather than a boot-time convenience.

**If you add an environment variable that has to be right in production, add it
to that checklist in the same change.** The failure mode is not that the variable
is undocumented; it is that a list which looks complete is trusted as complete.

## Generating the secrets

Two values have to be generated before a production boot, and one of them cannot
be regenerated later. Both are 32 random bytes as hex, and one command makes
either:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Run it twice and use the two outputs for the two variables. Do not reuse one
value for both: they protect different things, and a single string means one
disclosure costs you both.

| Variable | What it must be | Enforced by | If it changes |
| --- | --- | --- | --- |
| `SESSION_SECRET` | at least 32 characters, not the committed placeholder | `env.js`, refuses to boot in production | everyone signs in again; recovery questions reshuffle |
| `ENCRYPTION_KEY` | **exactly** 32 bytes of hex, so 64 characters | `crypto.js`, refuses to boot unless `APP_ENV` is development or test | **every stored board becomes permanently unreadable** |

**`ENCRYPTION_KEY` is the one to be careful with, and the care is not technical.**
It is the AES-256-GCM key every board is sealed under. There is no re-encryption
path in this tree, so rotating it and losing it are the same operation from the
data's point of view: the old boards decrypt with a key you no longer have, and
nothing in the process will tell you until somebody opens one. Nothing can
enforce that you kept it, which is exactly why it is written down here. Put it in
whatever your host calls a secret store before the first deploy, and put a copy
somewhere that survives the host.

`SESSION_SECRET` is safe to rotate whenever you like; the cost is that live
sessions stop resolving and people sign in again. Its name undersells it: it
signs nothing (sessions are opaque random tokens stored as SHA-256) but it keys
the HMAC deciding which security question an address with **no** account is
shown, and that has to be uncomputable offline or recovery step one becomes a way
to test which addresses are registered.

Two more credentials are not generated by that command:

- **The database password.** See "the runtime role" above, which sets it out of
  band so it never lands in a file or a shell history. In production this is the
  restricted role, not the owner, and the URL carries `sslmode=verify-full`.
- **`GEMINI_API_KEY`** is issued rather than generated, free, from
  <https://aistudio.google.com/apikey>. It is entirely optional: unset, the
  assistant is offline, instant and costs nothing, and the only thing it loses is
  the fallback for phrasings the parser does not know and the tactical advice
  that rides on it. It is read server-side only and never reaches the browser.

The remaining production settings are not secrets and cannot be generated, but
three of them will stop a boot or quietly weaken it if they are wrong:
`APP_ENV=production`, `CORS_ORIGIN` as the exact scheme-host-port the frontend is
served from with no trailing slash, and `TRUST_PROXY` set if and only if
something in front overwrites `X-Forwarded-For`. `handoff.md`'s "Before a deploy"
has the full list and what each failure looks like.

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

**A session alone is not enough for anything destructive**, and until 2026-07-30
it was enough for the most destructive thing here. `POST /api/auth/password` and
`POST /api/auth/sessions` both require the current password, on the argument that
a session left open on a shared machine must not be enough or the control becomes
a gift to the person it exists to remove. `DELETE /api/auth/me` asked for none of
it, while destroying the account and every board under it with no backup behind
them. It goes through the same `assertCurrentPassword` now, **and through the
second factor as well when one is on**: leaving it behind the password alone
would let a stolen session plus a known password destroy everything without the
attacker ever meeting the factor, which is the hole the recovery path was
designed to avoid. A **guest** is admitted on the session alone, deliberately and
by name: that row has no password to confirm, so demanding one would make
deletion impossible rather than harder, and the privacy policy promises deletion
to everybody. `src/accountDeletion.test.js` holds all of it.

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

**Publishing is not the same as arriving, so the eviction is written down too.**
An instance whose `LISTEN` connection is down when a revocation is published
never hears it, and nothing re-checks a socket after the handshake, so it would
keep serving a session that no longer exists anywhere. Every deletion therefore
leaves a `session_revocations` row behind, written in the same statement as the
delete — one data-modifying CTE, so neither half can commit without the other —
and each instance catches up on the rows newer than its in-memory watermark when
its listener reopens. The watermark is not durable on purpose: sockets do not
survive a restart, so an instance that was down at revocation time re-authorizes
everything from scratch and has nothing to catch up on. Rows are swept hourly at
the session TTL plus a day. `src/durableEviction.test.js` holds it by taking the
far instance's connections away and reviving them.

**Ending every session is its own endpoint**, not only a side effect of changing
a password. `POST /api/auth/sessions` takes the current password, destroys every
session for the account, and mints one for the browser that asked, so somebody
who thinks a session has been taken can throw it out without inventing a new
password. The current password is what makes it useless to whoever took the
session; the replacement is what stops it locking its owner out. The presence
check, the guest refusal and the comparison are one `assertCurrentPassword` that
this and `/password` both call, because two spellings of that rule means one of
them drifts weaker. Held by `src/signOutEverywhere.test.js`.

**Two-step sign-in** is TOTP (RFC 6238, SHA-1, 30 second period, six digits, one
step of window), hand-written on `node:crypto` in `src/totp.js` against the RFC's
own test vectors rather than pulled in as a dependency. The secret is **sealed
with `encrypt()`, not hashed**, and that is forced rather than chosen: the server
has to compute the same HMAC the phone computes, so scrypt is structurally
unavailable here in a way it is not for the password or the security answer. A
stolen database plus a stolen `ENCRYPTION_KEY` therefore yields working factors,
which is inherent to TOTP and is why the recovery codes are hashed as well.

`users.totp_confirmed_at` is the switch, never `users.totp_secret`. A secret with
a NULL confirmation is an enrollment somebody abandoned, and reading the secret
as "on" would turn that into a lockout. Every login path and `publicUser`'s
`twoFactorEnabled` read the confirmation column.

**A correct password buys a row in `auth_challenges` and nothing else.** Five
minute TTL, single use, `purpose` of `login` or `reset` compared inside the
claiming statement so a factor met while recovering cannot sign anybody in. It is
returned in the response **body and never in a cookie**: a cookie would ride on
every request including the board routes, and one handler that forgot to
distinguish the two would be an authentication bypass. The cost is that reloading
mid sign-in starts again, which is right for a five minute step.

**The claim is the check, twice over.** A TOTP code moves `users.totp_last_step`
forward in one guarded `UPDATE`, so the same code cannot be spent twice inside
its ninety seconds; a recovery code moves `used_at` off NULL in one guarded
`UPDATE`, so it works exactly once. The challenge itself is claimed **before** the
code is compared, so one challenge is worth one guess: mistype it and you enter
your password again. Ten recovery codes, sixteen characters from a 24 letter
alphabet, stored as SHA-256 (about 2^72.7, so a memory-hard KDF would buy a
property `randomInt` already gives), written in the same transaction that sets
the confirmation so there is no ordering in which an account has the factor on
and no way back in.

Code checks are limited by a read-in-front-of-the-charge pair keyed on the user
id and on the IP, charging failures only: five per fifteen minutes per account,
twenty per ten minutes per network. Charging successes would lock somebody out
for signing in five times on a flaky connection; charging failures with nothing
reading first would refuse the wrong guesses and wave the right one through.

**Losing both the authenticator and every unused recovery code needs an
operator.** That is the accepted cost of having no mailer, and today it means a
`psql` statement:
`UPDATE users SET totp_secret = NULL, totp_confirmed_at = NULL, totp_last_step = NULL WHERE email = '…';`
followed by `DELETE FROM recovery_codes WHERE user_id = '…';`. `src/twoFactorEnroll.test.js`
(:8817) and `src/twoFactorLogin.test.js` (:8818) hold the whole feature.

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

The notification bus does not buffer **ops**. Losing the `LISTEN` connection is
retried every two seconds, and ops published during the gap reach this
instance's own sockets and are logged as unpublished rather than held for
replay. Rooms reconverge on the next whole-board `replaced`, not on their own.
Replaying an op needs a per-board sequence number and a bounded window, neither
of which exists.

Session evictions are the deliberate exception, because losing one costs a
security guarantee rather than convergence; see `session_revocations` above.
