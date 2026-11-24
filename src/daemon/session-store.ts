import { Database } from 'bun:sqlite'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { existsSync, rmSync } from 'node:fs'
import { SqliteStorage, type IAuthKeysRepository, type ITelegramStorageProvider } from '@mtcute/bun'
import type { SecretStore } from '../shared/secrets'

/**
 * session.db is mtcute's SQLite file. Most of it is a cache (peers, update state), but the
 * auth_keys rows are the login itself: anyone holding one is you on Telegram, with no code
 * and no 2FA asked. So those rows are sealed with AES-256-GCM under "session-key", which
 * lives in the OS keystore. A copy of session.db on its own (a backup, a synced folder, a
 * stolen laptop image, malware that scrapes ~/.config) doesn't give anyone your account.
 */

const VERSION = 1
const IV_BYTES = 12
const TAG_BYTES = 16
/** Telegram auth keys are always 2048 bits. A row of exactly this size is an unsealed key. */
const AUTH_KEY_BYTES = 256

/** session.db can't be opened with the key we have. Only logging in again fixes it. */
export class SessionLockedError extends Error {
  override name = 'SessionLockedError'
}

const permSlot = (dc: number) => `auth_keys/${dc}`
const tempSlot = (dc: number, idx: number) => `temp_auth_keys/${dc}/${idx}`

/** The slot is authenticated too, so a sealed key can't be moved to another row. */
export function seal(key: Buffer, plain: Uint8Array, slot: string): Uint8Array {
  const iv = randomBytes(IV_BYTES)
  const c = createCipheriv('aes-256-gcm', key, iv)
  c.setAAD(Buffer.from(slot))
  const body = Buffer.concat([c.update(plain), c.final()])
  return new Uint8Array(Buffer.concat([Buffer.of(VERSION), iv, c.getAuthTag(), body]))
}

export function unseal(key: Buffer, blob: Uint8Array, slot: string): Uint8Array {
  const b = Buffer.from(blob)
  if (b.length <= 1 + IV_BYTES + TAG_BYTES || b[0] !== VERSION) throw new SessionLockedError(`${slot} is not a sealed auth key.`)
  try {
    const d = createDecipheriv('aes-256-gcm', key, b.subarray(1, 1 + IV_BYTES))
    d.setAAD(Buffer.from(slot))
    d.setAuthTag(b.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES))
    return new Uint8Array(Buffer.concat([d.update(b.subarray(1 + IV_BYTES + TAG_BYTES)), d.final()]))
  } catch {
    throw new SessionLockedError(`${slot} was sealed with a different session key.`)
  }
}

export const isUnsealed = (blob: Uint8Array) => blob.length === AUTH_KEY_BYTES

/** What mtcute's SQLite auth key repository looks like: synchronous, which keeps ours synchronous. */
interface SyncAuthKeys {
  set(dc: number, key: Uint8Array | null): void
  get(dc: number): Uint8Array | null
  setTemp(dc: number, idx: number, key: Uint8Array | null, expires: number): void
  getTemp(dc: number, idx: number, now: number): Uint8Array | null
  deleteByDc(dc: number): void
  deleteAll(): void
}

/** mtcute's auth key repository with sealing in between. mtcute never sees a sealed row. */
export class SealedAuthKeys implements IAuthKeysRepository {
  constructor(
    private readonly inner: SyncAuthKeys,
    private readonly key: Buffer,
  ) {}

  set(dc: number, key: Uint8Array | null) {
    return this.inner.set(dc, key && seal(this.key, key, permSlot(dc)))
  }

  get(dc: number): Uint8Array | null {
    const blob = this.inner.get(dc)
    if (!blob) return null
    if (!isUnsealed(blob)) return unseal(this.key, blob, permSlot(dc))
    this.inner.set(dc, seal(this.key, blob, permSlot(dc)))
    return blob
  }

  setTemp(dc: number, idx: number, key: Uint8Array | null, expires: number) {
    return this.inner.setTemp(dc, idx, key && seal(this.key, key, tempSlot(dc, idx)), expires)
  }

  getTemp(dc: number, idx: number, now: number): Uint8Array | null {
    const blob = this.inner.getTemp(dc, idx, now)
    if (!blob) return null
    return isUnsealed(blob) ? blob : unseal(this.key, blob, tempSlot(dc, idx))
  }

  deleteByDc(dc: number) {
    return this.inner.deleteByDc(dc)
  }

  deleteAll() {
    return this.inner.deleteAll()
  }
}

// ---- the file itself -----------------------------------------------------------------------------

interface KeyRow {
  table: 'auth_keys' | 'temp_auth_keys'
  dc: number
  idx: number | null
  key: Uint8Array
}

const slotOf = (r: KeyRow) => (r.table === 'auth_keys' ? permSlot(r.dc) : tempSlot(r.dc, r.idx ?? 0))

function withDb<T>(path: string, fn: (db: Database) => T): T {
  const db = new Database(path)
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    return fn(db)
  } finally {
    db.close()
  }
}

function readKeyRows(path: string): KeyRow[] {
  if (!existsSync(path)) return []
  return withDb(path, db => {
    const tables = new Set(
      db.query<{ name: string }, []>("select name from sqlite_master where type = 'table'").all().map(t => t.name),
    )
    const rows: KeyRow[] = []
    if (tables.has('auth_keys')) {
      for (const r of db.query<{ dc: number; key: Uint8Array }, []>('select dc, key from auth_keys').all()) {
        rows.push({ table: 'auth_keys', dc: r.dc, idx: null, key: r.key })
      }
    }
    if (tables.has('temp_auth_keys')) {
      for (const r of db.query<{ dc: number; idx: number; key: Uint8Array }, []>('select dc, idx, key from temp_auth_keys').all()) {
        rows.push({ table: 'temp_auth_keys', dc: r.dc, idx: r.idx, key: r.key })
      }
    }
    return rows
  })
}

/**
 * Seals the rows an older version left unsealed, then scrubs the old bytes: secure_delete
 * zeroes what the update frees, VACUUM rewrites the file, and the WAL (which still holds the
 * old pages) is checkpointed and truncated.
 */
function sealRows(path: string, key: Buffer, rows: KeyRow[]): void {
  withDb(path, db => {
    db.exec('PRAGMA secure_delete = ON')
    const perm = db.prepare('update auth_keys set key = ? where dc = ?')
    const temp = db.prepare('update temp_auth_keys set key = ? where dc = ? and idx = ?')
    db.transaction(() => {
      for (const r of rows) {
        const sealed = seal(key, r.key, slotOf(r))
        if (r.table === 'auth_keys') perm.run(sealed, r.dc)
        else temp.run(sealed, r.dc, r.idx ?? 0)
      }
    })()
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    db.exec('VACUUM')
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  })
}

function removeSession(path: string): void {
  for (const f of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) rmSync(f, { force: true })
}

function decodeKey(encoded: string, where: string): Buffer {
  const key = Buffer.from(encoded, 'base64')
  if (key.length !== 32) throw new SessionLockedError(`The session key in ${where} is not 32 bytes of base64.`)
  return key
}

export interface OpenSessionOptions {
  /**
   * `tgmcp login`: when session.db can't be opened (its key is gone or different), delete it
   * and start over instead of failing. Nothing in it is usable without the key anyway.
   */
  fresh?: boolean
  log?: (msg: string) => void
}

/**
 * Gets the session key (creating it on first use), seals anything unsealed, checks every
 * sealed row opens, and returns mtcute storage for one client. Throws SessionLockedError when
 * a human has to log in again, and a plain Error when the keystore itself failed (worth a retry).
 */
export async function openSessionStorage(
  path: string,
  secrets: SecretStore,
  opts: OpenSessionOptions = {},
): Promise<ITelegramStorageProvider> {
  const log = opts.log ?? (() => {})
  let rows = readKeyRows(path)
  let encoded = await secrets.get('session-key')

  const sealed = rows.filter(r => !isUnsealed(r.key))
  const locked = (why: string) => {
    if (!opts.fresh) throw new SessionLockedError(`${why} Run \`tgmcp login\` to log in again.`)
    log(`session: ${why} Starting a fresh session.`)
    removeSession(path)
    rows = []
  }

  if (!encoded && sealed.length > 0) locked(`session.db is sealed, but its key is not in ${secrets.where}.`)
  let key: Buffer
  if (encoded) {
    key = decodeKey(encoded, secrets.where)
    const opens = (r: KeyRow) => {
      try {
        unseal(key, r.key, slotOf(r))
        return true
      } catch {
        return false
      }
    }
    if (!sealed.every(opens)) locked(`session.db was sealed with a different key than the one in ${secrets.where}.`)
  } else {
    encoded = randomBytes(32).toString('base64')
    await secrets.set('session-key', encoded)
    key = decodeKey(encoded, secrets.where)
    log(`session: created the session key in ${secrets.where}`)
  }

  const unsealed = rows.filter(r => isUnsealed(r.key))
  if (unsealed.length > 0) {
    sealRows(path, key, unsealed)
    log(`session: sealed ${unsealed.length} auth key(s) in session.db with the key from ${secrets.where}`)
  }

  const storage = new SqliteStorage(path)
  storage.driver.onLoad(db => {
    db.exec('PRAGMA secure_delete = ON')
    // mtcute prepares statements it never finalizes, so its plain close() leaves the file open
    // until they are garbage-collected. On Windows that open handle makes deleting or replacing
    // session.db fail with EBUSY. close(true) finalizes them and really closes the file.
    const bunDb = db as unknown as Database
    bunDb.close = Database.prototype.close.bind(bunDb, true)
  })
  return {
    driver: storage.driver,
    kv: storage.kv,
    peers: storage.peers,
    refMessages: storage.refMessages,
    authKeys: new SealedAuthKeys(storage.authKeys, key),
  }
}
