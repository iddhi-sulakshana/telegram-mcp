import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defaultHome, type Paths } from './paths'

/**
 * The secrets, and where they live.
 *
 *   token        the local API secret for Claude sessions: the MCP proxies and `tgmcp call` show it
 *                to the daemon on /bridge (and the CLI on /status)
 *   ui-token     the menu bar and tray apps' own secret, for /ui/* and /admin/* (the CLI commands a
 *                person runs use it there too). The proxies never read it, and `token` doesn't
 *                open those routes, nor this one /bridge.
 *   credentials  api_id / api_hash from my.telegram.org, as JSON
 *   session-key  seals the Telegram auth keys inside session.db (see daemon/session-store.ts)
 *   page-bot     the Bot API token of your own pager bot (`tgmcp page setup`), if you set one up
 *
 * By default they go to the OS keystore through Bun.secrets: the login Keychain on macOS,
 * Credential Manager on Windows, libsecret (GNOME Keyring, KWallet) on Linux. Plain files are
 * only used when you ask for them with TELEGRAM_MCP_SECRET_STORE=file, for a machine without a
 * keystore (a headless Linux box, say). There is no silent fallback to files.
 */
export const SECRET_NAMES = ['token', 'ui-token', 'credentials', 'session-key', 'page-bot'] as const
export type SecretName = (typeof SECRET_NAMES)[number]

/** The Keychain "service" (Windows: target prefix, libsecret: the service attribute). */
export const KEYCHAIN_SERVICE = 'telegram-mcp'

export interface SecretStore {
  readonly kind: 'keychain' | 'file'
  /** Where the secrets are, for humans. */
  readonly where: string
  get(name: SecretName): Promise<string | null>
  set(name: SecretName, value: string): Promise<void>
  delete(name: SecretName): Promise<boolean>
}

export interface Credentials {
  apiId: number
  apiHash: string
}

export function keystoreName(platform: string = process.platform): string {
  if (platform === 'darwin') return 'the macOS Keychain'
  if (platform === 'win32') return 'Windows Credential Manager'
  return 'the Secret Service keyring (libsecret)'
}

/**
 * The account name of a secret. The default home uses the bare name ("token"), so the menu bar
 * app finds it without being told anything. Any other TELEGRAM_MCP_HOME (tests, a demo, a second
 * account) gets its own entries: "token@/tmp/tgmcp-demo".
 */
export function keychainAccount(name: SecretName, home: string): string {
  const h = resolve(home)
  return h === resolve(defaultHome()) ? name : `${name}@${h}`
}

// ---- files (TELEGRAM_MCP_SECRET_STORE=file, and what older versions left behind) ----------------

function fileFor(paths: Paths, name: SecretName): string {
  if (name === 'token') return paths.token
  if (name === 'ui-token') return paths.uiToken
  if (name === 'credentials') return paths.credentials
  if (name === 'page-bot') return paths.pageBot
  return paths.sessionKey
}

export class FileSecretStore implements SecretStore {
  readonly kind = 'file' as const
  readonly where: string

  constructor(private readonly paths: Paths) {
    this.where = `plain files in ${paths.home} (mode 0600)`
  }

  path(name: SecretName): string {
    return fileFor(this.paths, name)
  }

  async get(name: SecretName): Promise<string | null> {
    try {
      return readFileSync(this.path(name), 'utf8').trim() || null
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw e
    }
  }

  async set(name: SecretName, value: string): Promise<void> {
    const path = this.path(name)
    const tmp = `${path}.${process.pid}.tmp`
    writeFileSync(tmp, `${value}\n`, { mode: 0o600 })
    renameSync(tmp, path)
  }

  async delete(name: SecretName): Promise<boolean> {
    const path = this.path(name)
    if (!existsSync(path)) return false
    rmSync(path, { force: true })
    return true
  }

  /** The secret files that exist right now. */
  present(): SecretName[] {
    return SECRET_NAMES.filter(n => existsSync(this.path(n)))
  }
}

// ---- the OS keystore --------------------------------------------------------------------------

/** The part of Bun.secrets we use; tests pass a Map-backed fake. */
export interface KeystoreBackend {
  get(o: { service: string; name: string }): Promise<string | null>
  set(o: { service: string; name: string; value: string; persist?: 'local' | 'enterprise' }): Promise<void>
  delete(o: { service: string; name: string }): Promise<boolean>
}

function bunSecrets(): KeystoreBackend {
  const s = (globalThis as { Bun?: { secrets?: KeystoreBackend } }).Bun?.secrets
  if (!s) {
    throw new Error(
      'This Bun has no Bun.secrets (it arrived in Bun 1.2.21). Run `bun upgrade`, or set TELEGRAM_MCP_SECRET_STORE=file to keep secrets in plain files.',
    )
  }
  return s
}

export class KeychainSecretStore implements SecretStore {
  readonly kind = 'keychain' as const
  readonly where: string

  /**
   * `legacy` is the file store an older version used. A secret found only there is moved into
   * the keystore (checked by reading it back) and the file is deleted.
   */
  constructor(
    private readonly home: string,
    private readonly opts: { backend?: KeystoreBackend; legacy?: FileSecretStore; platform?: string } = {},
  ) {
    this.where = `${keystoreName(opts.platform)} (service "${KEYCHAIN_SERVICE}")`
  }

  #backend(): KeystoreBackend {
    return this.opts.backend ?? bunSecrets()
  }

  #id(name: SecretName) {
    return { service: KEYCHAIN_SERVICE, name: keychainAccount(name, this.home) }
  }

  #fail(action: string, name: SecretName, e: unknown): Error {
    const why = e instanceof Error ? e.message : String(e)
    return new Error(
      `Could not ${action} "${name}" in ${keystoreName(this.opts.platform)}: ${why}. ` +
        'If this machine has no keystore, set TELEGRAM_MCP_SECRET_STORE=file to keep secrets in plain files instead.',
    )
  }

  async #read(name: SecretName): Promise<string | null> {
    try {
      return (await this.#backend().get(this.#id(name))) || null
    } catch (e) {
      throw this.#fail('read', name, e)
    }
  }

  async get(name: SecretName): Promise<string | null> {
    const value = await this.#read(name)
    if (value !== null || !this.opts.legacy) return value
    const old = await this.opts.legacy.get(name)
    if (old === null) return null
    await this.set(name, old)
    return old
  }

  /** Writes, reads it back, and only then removes any plain-file copy. */
  async set(name: SecretName, value: string): Promise<void> {
    if (!value) throw new Error(`Refusing to store an empty ${name}.`)
    try {
      // "local": a secret for this computer only, never roamed with a Windows profile.
      await this.#backend().set({ ...this.#id(name), value, persist: 'local' })
    } catch (e) {
      throw this.#fail('save', name, e)
    }
    if ((await this.#read(name)) !== value) throw this.#fail('save', name, new Error('reading it back gave something else'))
    await this.opts.legacy?.delete(name)
  }

  async delete(name: SecretName): Promise<boolean> {
    let deleted: boolean
    try {
      deleted = await this.#backend().delete(this.#id(name))
    } catch (e) {
      throw this.#fail('delete', name, e)
    }
    const file = (await this.opts.legacy?.delete(name)) ?? false
    return deleted || file
  }
}

/** TELEGRAM_MCP_SECRET_STORE: "keychain" (the default) or "file". */
export function secretStoreKind(env: Record<string, string | undefined> = process.env): 'keychain' | 'file' {
  const raw = (env.TELEGRAM_MCP_SECRET_STORE ?? '').trim().toLowerCase()
  if (raw === '' || raw === 'keychain' || raw === 'keystore') return 'keychain'
  if (raw === 'file') return 'file'
  throw new Error(`TELEGRAM_MCP_SECRET_STORE must be "keychain" or "file", not "${raw}".`)
}

export function openSecretStore(paths: Paths, env: Record<string, string | undefined> = process.env): SecretStore {
  const files = new FileSecretStore(paths)
  return secretStoreKind(env) === 'file' ? files : new KeychainSecretStore(paths.home, { legacy: files })
}

// ---- the secrets themselves ---------------------------------------------------------------------

/** The shared secret for the local HTTP/WebSocket API. Created once; an existing one is kept. */
export async function ensureToken(store: SecretStore): Promise<string> {
  const existing = await store.get('token')
  if (existing) return existing
  const token = randomBytes(24).toString('hex')
  await store.set('token', token)
  return token
}

export function readToken(store: SecretStore): Promise<string | null> {
  return store.get('token')
}

/**
 * The menu bar and tray apps' token for /ui/* and /admin/*. Created once, like `token`, and never
 * the same value: one that matches `token` (copied by hand, say) is replaced.
 */
export async function ensureUiToken(store: SecretStore, bridgeToken: string): Promise<string> {
  const existing = await store.get('ui-token')
  if (existing && existing !== bridgeToken) return existing
  const token = randomBytes(24).toString('hex')
  await store.set('ui-token', token)
  return token
}

/** Only for what a person runs (the CLI's /ui/* and /admin/* calls); the MCP proxy never reads it. */
export function readUiToken(store: SecretStore): Promise<string | null> {
  return store.get('ui-token')
}

/** TELEGRAM_API_ID / TELEGRAM_API_HASH from the environment win; otherwise the secret store. */
export async function loadCredentials(store: SecretStore): Promise<Credentials | null> {
  const envId = Number(process.env.TELEGRAM_API_ID)
  const envHash = process.env.TELEGRAM_API_HASH
  if (envId && envHash) return { apiId: envId, apiHash: envHash }
  const text = await store.get('credentials')
  if (!text) return null
  try {
    const raw = JSON.parse(text) as { apiId?: unknown; apiHash?: unknown }
    const apiId = Number(raw.apiId)
    if (apiId && typeof raw.apiHash === 'string' && raw.apiHash) return { apiId, apiHash: raw.apiHash }
  } catch {}
  return null
}

export function saveCredentials(store: SecretStore, c: Credentials): Promise<void> {
  return store.set('credentials', JSON.stringify({ apiId: c.apiId, apiHash: c.apiHash }))
}
