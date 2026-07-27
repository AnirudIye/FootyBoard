import test, { before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { migrate, run, get, closePool } from './db.js'
import { accessFor } from './access.js'

/**
 * The authorization matrix.
 *
 * These run against a real Postgres rather than a stub, because the thing being
 * tested is largely the SQL: a LEFT JOIN that has to return the right answer
 * for a board you own, one you were shared into, one you were removed from, and
 * one that does not exist. A stub would only prove the JavaScript around it.
 */

let owner
let member
let stranger
let boardId

const insertUser = async () => {
  const id = randomUUID()
  await run(
    `INSERT INTO users (id, email, password_hash, password_salt, accepted_terms_at, created_at)
     VALUES ($1, $2, 'x', 'x', $3, $3)`,
    id,
    `${id}@test.invalid`,
    new Date().toISOString(),
  )
  return id
}

const insertBoard = async (userId) => {
  const id = randomUUID()
  await run(
    `INSERT INTO boards (id, user_id, name, data, created_at, updated_at)
     VALUES ($1, $2, 'Test board', 'x', $3, $3)`,
    id,
    userId,
    new Date().toISOString(),
  )
  return id
}

before(async () => {
  await migrate()
  owner = await insertUser()
  member = await insertUser()
  stranger = await insertUser()
})

beforeEach(async () => {
  // A fresh board each time, so a test that changes the lock cannot leak into
  // the next one.
  boardId = await insertBoard(owner)
  await run(
    `INSERT INTO board_members (board_id, user_id, joined_at) VALUES ($1, $2, $3)`,
    boardId,
    member,
    new Date().toISOString(),
  )
})

after(async () => {
  // Users cascade to boards, members and shares.
  for (const id of [owner, member, stranger]) await run('DELETE FROM users WHERE id = $1', id)
  await closePool()
})

test('the owner is the owner and can always edit', async () => {
  const access = await accessFor(boardId, owner)
  assert.equal(access.role, 'owner')
  assert.equal(access.canEdit, true)
})

test('a shared-in user is a member and can edit while the board is unlocked', async () => {
  const access = await accessFor(boardId, member)
  assert.equal(access.role, 'member')
  assert.equal(access.membersCanEdit, true, 'boards default to unlocked')
  assert.equal(access.canEdit, true)
})

test('locking the board stops members editing but never the owner', async () => {
  await run('UPDATE boards SET members_can_edit = false WHERE id = $1', boardId)

  const locked = await accessFor(boardId, member)
  assert.equal(locked.canEdit, false)
  assert.equal(locked.role, 'member', 'a locked member is still in the room')
  assert.equal(
    (await accessFor(boardId, owner)).canEdit,
    true,
    'the owner is not locked out by their own lock',
  )
})

test('a stranger has no role at all', async () => {
  const access = await accessFor(boardId, stranger)
  assert.equal(access.role, null)
  assert.equal(access.canEdit, false)
})

test('removing the membership removes the access', async () => {
  await run('DELETE FROM board_members WHERE board_id = $1 AND user_id = $2', boardId, member)
  assert.equal((await accessFor(boardId, member)).role, null)
})

test('a board that does not exist reads the same as one you cannot see', async () => {
  const missing = await accessFor(randomUUID(), owner)
  const forbidden = await accessFor(boardId, stranger)
  assert.deepEqual(missing, forbidden)
})

test('missing arguments are refused rather than matching everything', async () => {
  assert.equal((await accessFor(null, owner)).role, null)
  assert.equal((await accessFor(boardId, null)).role, null)
  assert.equal((await accessFor(undefined, undefined)).role, null)
})

test('a share issued before join codes existed gets one on migrate', async () => {
  // Otherwise a share whose link still works reads as "not shared", and the
  // owner turns sharing back on and silently revokes a link people are using.
  const shareId = randomUUID()
  await run(
    `INSERT INTO board_shares (id, board_id, token_hash, created_by, created_at)
     VALUES ($1, $2, $3, $4, $5)`,
    shareId,
    boardId,
    `legacy-${shareId}`,
    owner,
    new Date().toISOString(),
  )
  assert.equal((await get('SELECT code FROM board_shares WHERE id = $1', shareId)).code, null)

  await migrate()

  const filled = await get('SELECT code FROM board_shares WHERE id = $1', shareId)
  assert.match(filled.code, /^[A-HJ-NP-Z]{6}$/)
})

test('deleting a board takes its shares and members with it', async () => {
  const shareId = randomUUID()
  await run(
    `INSERT INTO board_shares (id, board_id, token_hash, created_by, created_at)
     VALUES ($1, $2, $3, $4, $5)`,
    shareId,
    boardId,
    `hash-${shareId}`,
    owner,
    new Date().toISOString(),
  )

  await run('DELETE FROM boards WHERE id = $1', boardId)

  assert.equal(await get('SELECT id FROM board_shares WHERE id = $1', shareId), null)
  assert.equal(
    await get('SELECT user_id FROM board_members WHERE board_id = $1', boardId),
    null,
  )
})
