import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto'
import { APP_ENV, allowsDerivedKey, SESSION_SECRET } from './env.js'

/**
 * Encryption at rest for board contents.
 *
 * Boards are the only thing here worth reading, so they are encrypted before
 * they touch the database. A stolen database file — or a leaked backup — is
 * then just noise without the key, which lives in the environment and never in
 * the DB.
 *
 * AES-256-GCM is authenticated: tampering with a stored row makes decryption
 * fail loudly rather than silently returning altered data.
 */

const ALGORITHM = 'aes-256-gcm'
const IV_BYTES = 12 // 96 bits, the size GCM is defined for
const PREFIX = 'v1' // lets the format change later without guessing

let key = null

/**
 * Resolves the key once at startup. A real key is required everywhere except
 * the environments that are explicitly local, where a stable one is derived
 * from SESSION_SECRET so nobody has to set up key material to run the app.
 *
 * The permission to do that comes from `APP_ENV` rather than from the absence
 * of a signal, which is the whole point: this used to fall through to a derived
 * key whenever `NODE_ENV` was anything other than the literal 'production', so
 * a staging box quietly encrypted real boards under a key derivable from the
 * placeholder in `.env.example`.
 */
export function initEncryption() {
  const configured = process.env.ENCRYPTION_KEY?.trim()

  if (configured) {
    const bytes = Buffer.from(configured, 'hex')
    if (bytes.length !== 32) {
      throw new Error(
        'ENCRYPTION_KEY must be 32 bytes of hex (64 characters). Generate one with:\n' +
          '  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
      )
    }
    key = bytes
    return
  }

  if (!allowsDerivedKey) {
    throw new Error(
      `ENCRYPTION_KEY is required when APP_ENV is "${APP_ENV}". Boards will not be stored unencrypted, ` +
        'and they will not be stored under a key anyone holding .env.example can recompute.',
    )
  }

  // Through `env.js` rather than `process.env`, so there is one reading of this
  // variable and one place the production floor sits. This branch is
  // unreachable in production anyway, because `allowsDerivedKey` is false there.
  key = createHash('sha256').update(`dev-key:${SESSION_SECRET}`).digest()
  console.warn(
    `ENCRYPTION_KEY is not set — using a key derived from SESSION_SECRET, allowed because APP_ENV is "${APP_ENV}".`,
  )
}

/** `v1:<iv>:<authTag>:<ciphertext>`, all base64url. */
export function encrypt(plaintext) {
  if (!key) throw new Error('Encryption is not initialised.')
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return [
    PREFIX,
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    encrypted.toString('base64url'),
  ].join(':')
}

/**
 * Decrypts a stored value. Rows written before encryption was switched on are
 * plain JSON, so they are returned as-is and re-encrypted the next time the
 * board is saved — no migration step, no downtime.
 */
export function decrypt(stored) {
  if (!key) throw new Error('Encryption is not initialised.')
  if (typeof stored !== 'string' || !stored.startsWith(`${PREFIX}:`)) return stored

  const [, ivPart, tagPart, dataPart] = stored.split(':')
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivPart, 'base64url'))
  decipher.setAuthTag(Buffer.from(tagPart, 'base64url'))
  return Buffer.concat([
    decipher.update(Buffer.from(dataPart, 'base64url')),
    decipher.final(),
  ]).toString('utf8')
}
