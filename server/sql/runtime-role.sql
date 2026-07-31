-- The role the API should connect as in production.
--
-- Run once against the application database, as a superuser or as the role that
-- owns the tables:
--
--   psql "$ADMIN_DATABASE_URL" -f server/sql/runtime-role.sql
--
-- What this exists to fix. The API currently connects as `soccerboard`, which is
-- SUPERUSER, and CREATEROLE, CREATEDB, BYPASSRLS and REPLICATION besides, and
-- which owns every table. A `DATABASE_URL` that gets out is therefore not a
-- disclosure of the rows, it is control of the Postgres host: the same string
-- the API uses for `SELECT` will also serve `DROP TABLE boards`, `TRUNCATE`,
-- `ALTER`, `CREATE ROLE`, and `COPY ... TO PROGRAM`. There is no backup behind
-- board data, so the destructive half of that is not an incident anyone recovers
-- from. The role below can read and write the application's rows and can do
-- nothing else at all, which is the entire idea: it makes a leaked connection
-- string worth what people already assume it is worth.
--
-- This is deliberately NOT the role migrations run as. `migrate()` in
-- `src/db.js` issues DDL on every boot, and a role without CREATE cannot run it
-- — including `CREATE TABLE IF NOT EXISTS` against a table that already exists,
-- because Postgres checks the schema privilege before it checks existence, so
-- the no-op is refused too. See `server/README.md` for what that means at deploy
-- time; `src/databasePrivileges.test.js` holds the whole boundary as assertions.
--
-- Re-running this file is safe and is in fact the supported way to repair a role
-- that has drifted: it resets the password and re-applies every grant and every
-- negative attribute.


-- ---------------------------------------------------------------------------
-- Settings. Edit the three defaults, or set them in the session before running
-- this file and they win. The test suite takes the second route, which is what
-- lets it exercise the values that actually ship rather than a copy of them.
-- ---------------------------------------------------------------------------

-- The role the API logs in as.
SELECT set_config('soccerboard.runtime_role',
                  coalesce(nullif(current_setting('soccerboard.runtime_role', true), ''),
                           'soccerboard_app'),
                  false);

-- Its password. The placeholder is deliberately not a usable value, so that a
-- file run unedited produces a role nobody can log in as rather than a role with
-- a password published in this repository.
--
-- Better still, do not put the real one here at all: run this file as shipped
-- and then set the password out of band, so it never reaches a file, a shell
-- history, or `log_statement=ddl` output.
--
--   ALTER ROLE soccerboard_app PASSWORD '…';
SELECT set_config('soccerboard.runtime_password',
                  coalesce(nullif(current_setting('soccerboard.runtime_password', true), ''),
                           'CHANGE-THIS-BEFORE-YOU-RUN-IT'),
                  false);

-- The role that owns the tables, which is to say the role migrations run as.
--
-- This one matters more than it looks. `ALTER DEFAULT PRIVILEGES` attaches to a
-- specific creating role, not to the schema, so if this names the wrong role
-- then every table added after today is created outside the default and the API
-- gets `permission denied` for it on the next deploy — the failure arriving one
-- release after the mistake, which is the worst possible delay. `current_user`
-- is right whenever you run this file as the owner or as the migration role; set
-- it explicitly if you are running it as some other superuser.
SELECT set_config('soccerboard.owner_role',
                  coalesce(nullif(current_setting('soccerboard.owner_role', true), ''),
                           current_user),
                  false);


-- ---------------------------------------------------------------------------
-- Provisioning.
--
-- Written as a DO block using format() and current_database() rather than as
-- flat DDL, because GRANT will not take the database name as an expression and
-- managed Postgres rarely lets you choose it: it is `defaultdb`, or `railway`,
-- or the project id. Hardcoding `soccerboard` here would mean every deployment
-- edits the file, and an edited file is one that stops matching what is tested.
-- ---------------------------------------------------------------------------

DO $provision$
DECLARE
  runtime  text := current_setting('soccerboard.runtime_role');
  secret   text := current_setting('soccerboard.runtime_password');
  owner    text := current_setting('soccerboard.owner_role');
  db       text := current_database();
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = runtime) THEN
    EXECUTE format('CREATE ROLE %I LOGIN PASSWORD %L', runtime, secret);
    RAISE NOTICE 'Created role %', runtime;
  ELSE
    EXECUTE format('ALTER ROLE %I LOGIN PASSWORD %L', runtime, secret);
    RAISE NOTICE 'Role % already existed; password and grants reset', runtime;
  END IF;

  -- Said out loud rather than left to the defaults. These are the defaults for a
  -- new role, so on a first run every one of them is a no-op — but this file is
  -- also the repair tool, and a role that acquired SUPERUSER by some other route
  -- should lose it by being re-provisioned rather than by someone noticing.
  EXECUTE format(
    'ALTER ROLE %I NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', runtime);

  -- CONNECT and nothing else. The REVOKE first is what makes this a statement of
  -- the whole set rather than an addition to whatever was there before, which is
  -- what re-running is supposed to guarantee.
  EXECUTE format('REVOKE ALL ON DATABASE %I FROM %I', db, runtime);
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', db, runtime);

  -- USAGE lets the role resolve names in the schema. CREATE would let it add
  -- tables of its own, and is exactly what we are withholding.
  EXECUTE format('REVOKE ALL ON SCHEMA public FROM %I', runtime);
  EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', runtime);

  -- The four verbs the API actually issues, across every table rather than a
  -- list of the eleven that exist this week. A list would be correct today and
  -- wrong on the next migration, and wrong in the direction that fails in
  -- production rather than in the test that added the table.
  --
  -- TRUNCATE is not among them and its absence is the point: it is not DDL, it
  -- takes no WHERE clause, and it would hand back most of what DROP was taken
  -- away for. REFERENCES and TRIGGER are absent for the same reason — both are
  -- ways to attach something of your own to a table you do not own.
  EXECUTE format(
    'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I', runtime);

  -- There are no sequences today: every primary key here is a random TEXT id
  -- rather than a serial. Granted anyway, because the day somebody adds an
  -- `id SERIAL` the failure is an INSERT that cannot call nextval, and that is a
  -- confusing error to meet in production for the sake of a line here.
  EXECUTE format('GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO %I', runtime);

  -- And the same grants, standing, for whatever the owner creates next. This is
  -- the difference between provisioning that holds and provisioning that has to
  -- be remembered at each migration: without it the two statements above are a
  -- snapshot of the schema on the day they ran.
  EXECUTE format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public
       GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I', owner, runtime);
  EXECUTE format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public
       GRANT USAGE ON SEQUENCES TO %I', owner, runtime);
END
$provision$;


-- Postgres 15 stopped granting CREATE on `public` to PUBLIC, and on 15 and later
-- this line is a no-op. On 13 and 14 it is the line that makes the whole file
-- mean anything: without it every role in the database, including the one above,
-- can still create tables in `public`, and "no CREATE" is a claim rather than a
-- fact. It does not touch any role's attributes and the schema owner keeps
-- CREATE regardless of it, since ownership is not a grant.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

-- Left commented deliberately. PUBLIC holds TEMP on the database by default, so
-- the runtime role can still create session-local temporary tables; they vanish
-- with the connection and cannot touch application data, so this is a disk-usage
-- question rather than a security one. Uncomment it if you want the tighter
-- posture, but understand that it is a database-wide change affecting every
-- role, which is why it is not made on your behalf here.
--
--   REVOKE TEMPORARY ON DATABASE <your database> FROM PUBLIC;


-- ---------------------------------------------------------------------------
-- What you should see afterwards: one row, every column false.
-- ---------------------------------------------------------------------------

SELECT rolname, rolsuper, rolcreaterole, rolcreatedb, rolbypassrls, rolreplication
  FROM pg_roles
 WHERE rolname = current_setting('soccerboard.runtime_role');
