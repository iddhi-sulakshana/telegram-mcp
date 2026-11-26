import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultHome, getPaths } from '../src/shared/paths'
import {
  FileSecretStore,
  KeychainSecretStore,
  ensureToken,
  ensureUiToken,
  keychainAccount,
  loadCredentials,
  openSecretStore,
  readToken,
  readUiToken,
  secretStoreKind,
  type KeystoreBackend,
} from '../src/shared/secrets'

const tempPaths = () => getPaths(mkdtempSync(join(tmpdir(), 'tgmcp-secrets-')))

/** Bun.secrets, minus the operating system. */
class FakeKeystore implements KeystoreBackend {
  items = new Map<string, string>()
  failing: string | null = null
  /** Simulates a keystore that accepts a write but returns something else. */
  corruptWrites = false
  async get(o: { service: string; name: string }) {
    if (this.failing) throw new Error(this.failing)
    return this.items.get(`${o.service}/${o.name}`) ?? null
  }
  async set(o: { service: string; name: string; value: string }) {
    if (this.failing) throw new Error(this.failing)
    this.items.set(`${o.service}/${o.name}`, this.corruptWrites ? 'garbage' : o.value)
  }
  async delete(o: { service: string; name: string }) {
    if (this.failing) throw new Error(this.failing)
    return this.items.delete(`${o.service}/${o.name}`)
  }
}

describe('where secrets go', () => {
  test('the default home uses bare names, any other home gets its own entries', () => {
    expect(keychainAccount('token', defaultHome())).toBe('token')
    expect(keychainAccount('token', `${defaultHome()}/`)).toBe('token')
    expect(keychainAccount('ui-token', defaultHome())).toBe('ui-token')
  })

  // POSIX: on Windows "/tmp/…" resolves against the current drive (as in the next test).
  test.skipIf(process.platform === 'win32')('the ui token gets its own entry per home, like the others', () => {
    expect(keychainAccount('ui-token', '/tmp/tgmcp-demo')).toBe('ui-token@/tmp/tgmcp-demo')
  })

  // POSIX: Windows resolves "/tmp/…" against the current drive, so the account reads "C:\\tmp\\…".
  test.skipIf(process.platform === 'win32')('another home gets its own entries', () => {
    expect(keychainAccount('session-key', '/tmp/tgmcp-demo')).toBe('session-key@/tmp/tgmcp-demo')
  })

  test('TELEGRAM_MCP_SECRET_STORE picks the store, and a typo is an error, not plain files', () => {
    expect(secretStoreKind({})).toBe('keychain')
    expect(secretStoreKind({ TELEGRAM_MCP_SECRET_STORE: 'keychain' })).toBe('keychain')
    expect(secretStoreKind({ TELEGRAM_MCP_SECRET_STORE: 'FILE' })).toBe('file')
    expect(() => secretStoreKind({ TELEGRAM_MCP_SECRET_STORE: 'files' })).toThrow('must be "keychain" or "file"')
    const paths = tempPaths()
    expect(openSecretStore(paths, {}).kind).toBe('keychain')
    expect(openSecretStore(paths, { TELEGRAM_MCP_SECRET_STORE: 'file' }).kind).toBe('file')
  })
})

describe('file store', () => {
  test('round trip, private files, delete', async () => {
    const paths = tempPaths()
    const files = new FileSecretStore(paths)
    expect(await files.get('token')).toBeNull()
    await files.set('token', 'abc')
    expect(await files.get('token')).toBe('abc')
    expect(files.present()).toEqual(['token'])
    expect(await files.delete('token')).toBe(true)
    expect(await files.delete('token')).toBe(false)
    expect(existsSync(paths.token)).toBe(false)
  })

  test('the ui token is its own file next to the token', async () => {
    const paths = tempPaths()
    const files = new FileSecretStore(paths)
    expect(files.path('ui-token')).toBe(join(paths.home, 'ui-token'))
    const bridge = await ensureToken(files)
    const ui = await ensureUiToken(files, bridge)
    expect(ui).toMatch(/^[0-9a-f]{48}$/)
    expect(ui).not.toBe(bridge)
    expect(files.present()).toEqual(['token', 'ui-token'])
    expect(await readUiToken(files)).toBe(ui)
    expect(await readToken(files)).toBe(bridge)
  })
})

describe('file store permissions', () => {
  // POSIX: Windows has no 0600 mode bits (stat reports 0666); there the file sits in the user's own profile.
  test.skipIf(process.platform === 'win32')('a secret file is private to its owner (0600)', async () => {
    const paths = tempPaths()
    await new FileSecretStore(paths).set('token', 'abc')
    expect(statSync(paths.token).mode & 0o777).toBe(0o600)
  })
})

describe('keychain store', () => {
  // POSIX: the account carries the resolved home, which on Windows is "C:\\tmp\\x", not "/tmp/x".
  test.skipIf(process.platform === 'win32')('stores under service telegram-mcp, account named after the secret and home', async () => {
    const kc = new FakeKeystore()
    const store = new KeychainSecretStore('/tmp/x', { backend: kc })
    await store.set('token', 't1')
    expect([...kc.items.keys()]).toEqual(['telegram-mcp/token@/tmp/x'])
    expect(await store.get('token')).toBe('t1')
    expect(await store.delete('token')).toBe(true)
    expect(await store.get('token')).toBeNull()
  })

  test('moves plain files from an older version into the keystore and deletes them', async () => {
    const paths = tempPaths()
    writeFileSync(paths.token, 'old-token\n')
    writeFileSync(paths.credentials, JSON.stringify({ apiId: 12345, apiHash: 'feedface' }, null, 2))
    const kc = new FakeKeystore()
    const store = new KeychainSecretStore(paths.home, { backend: kc, legacy: new FileSecretStore(paths) })

    expect(await ensureToken(store)).toBe('old-token') // same token, so running proxies keep working
    expect(await loadCredentials(store)).toEqual({ apiId: 12345, apiHash: 'feedface' })
    expect(existsSync(paths.token)).toBe(false)
    expect(existsSync(paths.credentials)).toBe(false)
    expect(kc.items.get(`telegram-mcp/${keychainAccount('token', paths.home)}`)).toBe('old-token')
  })

  test('a keystore that fails leaves the plain file alone and says how to opt out', async () => {
    const paths = tempPaths()
    writeFileSync(paths.token, 'old-token\n')
    const kc = new FakeKeystore()
    kc.failing = 'User interaction is not allowed.'
    const store = new KeychainSecretStore(paths.home, { backend: kc, legacy: new FileSecretStore(paths), platform: 'darwin' })
    const err = await store.get('token').catch(e => e as Error)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toContain('macOS Keychain')
    expect((err as Error).message).toContain('TELEGRAM_MCP_SECRET_STORE=file')
    expect(existsSync(paths.token)).toBe(true)
  })

  test('a write that does not read back keeps the plain file', async () => {
    const paths = tempPaths()
    writeFileSync(paths.token, 'old-token\n')
    const kc = new FakeKeystore()
    kc.corruptWrites = true
    const store = new KeychainSecretStore(paths.home, { backend: kc, legacy: new FileSecretStore(paths) })
    await expect(store.get('token')).rejects.toThrow('reading it back')
    expect(existsSync(paths.token)).toBe(true)
  })

  test('ensureToken creates a token once and keeps it', async () => {
    const store = new KeychainSecretStore('/tmp/y', { backend: new FakeKeystore() })
    const a = await ensureToken(store)
    expect(a).toMatch(/^[0-9a-f]{48}$/)
    expect(await ensureToken(store)).toBe(a)
  })

  test('ensureUiToken creates its own token once, never equal to the bridge token', async () => {
    const kc = new FakeKeystore()
    const store = new KeychainSecretStore('/tmp/y', { backend: kc })
    const bridge = await ensureToken(store)
    const ui = await ensureUiToken(store, bridge)
    expect(ui).toMatch(/^[0-9a-f]{48}$/)
    expect(ui).not.toBe(bridge)
    expect(await ensureUiToken(store, bridge)).toBe(ui)
    expect(kc.items.get(`telegram-mcp/${keychainAccount('ui-token', '/tmp/y')}`)).toBe(ui)
    // One set to the bridge token's value is replaced.
    await store.set('ui-token', bridge)
    const fresh = await ensureUiToken(store, bridge)
    expect(fresh).not.toBe(bridge)
    expect(await readUiToken(store)).toBe(fresh)
  })

  test('the proxy path reads the bridge token and nothing else', async () => {
    const asked: string[] = []
    const kc = new FakeKeystore()
    const store = new KeychainSecretStore('/tmp/z', { backend: kc })
    await ensureUiToken(store, await ensureToken(store))
    const spy = {
      kind: store.kind,
      where: store.where,
      get: (n: Parameters<typeof store.get>[0]) => (asked.push(n), store.get(n)),
      set: store.set.bind(store),
      delete: store.delete.bind(store),
    }
    expect(await readToken(spy)).toMatch(/^[0-9a-f]{48}$/)
    expect(asked).toEqual(['token'])
  })
})
