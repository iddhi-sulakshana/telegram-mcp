import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigStore, isListed, parseConfig, rawId, resolveRef, validateNickname } from '../src/shared/config'
import { USERNAME_RE } from '../src/shared/tools'

const config = parseConfig(
  JSON.stringify({
    chats: {
      leo: { id: 10, username: 'leo_p', name: 'Leo Perera', aliases: ['lp'] },
      leonardo: { id: 11, username: 'leonardo_s', name: 'Leonardo Silva' },
      qa: { id: -1001234567890, name: 'Team QA', topicId: 42 },
    },
    rules: { blocked: [5550001111], autoSend: ['leo', '@anna_k'], requireApproval: ['qa'] },
  }),
)

describe('resolveRef', () => {
  test('exact nickname, alias, full name, username, id', () => {
    expect(resolveRef(config, 'leo')).toMatchObject({ kind: 'entry', nickname: 'leo' })
    expect(resolveRef(config, 'LEO ')).toMatchObject({ kind: 'entry', nickname: 'leo' })
    expect(resolveRef(config, 'lp')).toMatchObject({ kind: 'entry', nickname: 'leo' })
    expect(resolveRef(config, 'leonardo silva')).toMatchObject({ kind: 'entry', nickname: 'leonardo' })
    expect(resolveRef(config, '@Leo_P')).toMatchObject({ kind: 'entry', nickname: 'leo' })
    expect(resolveRef(config, '-1001234567890')).toMatchObject({ kind: 'entry', nickname: 'qa' })
    expect(resolveRef(config, 11)).toMatchObject({ kind: 'entry', nickname: 'leonardo' })
  })

  test('unknowns stay unknown, with suggestions but never a guess', () => {
    const r = resolveRef(config, 'leon')
    expect(r.kind).toBe('unknown')
    if (r.kind === 'unknown') expect(r.suggestions.length).toBe(1)
    const p = resolveRef(config, 'perera')
    expect(p.kind).toBe('unknown')
  })

  test('raw usernames and ids that are not saved', () => {
    expect(resolveRef(config, '@someone')).toEqual({ kind: 'username', username: 'someone' })
    expect(resolveRef(config, '555')).toEqual({ kind: 'id', id: 555 })
    expect(resolveRef(config, 'me')).toEqual({ kind: 'self' })
  })
})

describe('lists', () => {
  test('blocked matches raw ids whatever the marking', () => {
    expect(rawId(-1005550001111)).toBe(5550001111)
    expect(isListed(config, 'blocked', { id: -1005550001111 })).toBe(true)
    expect(isListed(config, 'blocked', { id: 5550001111 })).toBe(true)
  })

  test('allow lists match exactly, by nickname or username', () => {
    expect(isListed(config, 'autoSend', { id: 10 })).toBe(true)
    expect(isListed(config, 'autoSend', { id: 11 })).toBe(false)
    expect(isListed(config, 'autoSend', { id: 99, username: 'Anna_K' })).toBe(true)
  })
})

describe('nicknames', () => {
  test('reject names that read as something else', () => {
    expect(validateNickname('leo')).toBeNull()
    expect(validateNickname('@leo')).not.toBeNull()
    expect(validateNickname('12345')).not.toBeNull()
    expect(validateNickname('me')).not.toBeNull()
    expect(validateNickname('  ')).not.toBeNull()
  })

  test('reject control characters, direction marks and line separators', () => {
    for (const bad of ['leo\u202e', 'le\u0085o', 'leo\u2028x', 'leo\u2029x', 'le\u200fo', 'le\u0007o', 'le\no']) {
      expect(validateNickname(bad)).not.toBeNull()
    }
    expect(validateNickname('Leo Perera-2')).toBeNull()
  })
})

describe('ConfigStore', () => {
  test('creates a default file, keeps unknown keys, re-reads before writing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tgmcp-'))
    const path = join(dir, 'config.json')
    const store = new ConfigStore(path)
    expect(store.get().footer).toContain('sᴇɴᴛ ᴠɪᴀ ᴄʟᴀᴜᴅᴇ')

    // A human edits the file directly; the store hasn't reloaded yet.
    const onDisk = JSON.parse(readFileSync(path, 'utf8'))
    onDisk.$comment = 'mine'
    onDisk.rules.autoSend = ['leo']
    writeFileSync(path, JSON.stringify(onDisk))

    store.update(c => {
      c.chats.leo = { id: 10, aliases: [] }
    })
    const after = JSON.parse(readFileSync(path, 'utf8'))
    expect(after.$comment).toBe('mine')
    expect(after.rules.autoSend).toEqual(['leo'])
    expect(after.chats.leo.id).toBe(10)
  })

  test('a broken edit keeps the last good config', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tgmcp-'))
    const path = join(dir, 'config.json')
    writeFileSync(path, JSON.stringify({ rules: { blocked: [5] } }))
    const store = new ConfigStore(path)
    writeFileSync(path, '{ not json')
    store.reload()
    expect(store.error()).toContain('invalid')
    expect(store.get().rules.blocked).toEqual([5])
  })

  test('old config without away parses with away disabled and the day and night schedules', () => {
    const c = parseConfig(JSON.stringify({ rules: { blocked: [5] } }))
    expect(c.away).toMatchObject({ enabled: false, quietMinutes: 30 })
    expect(c.away.schedules.map(s => [s.id, s.from, s.until, s.delaySeconds])).toEqual([
      ['day', '08:00', '21:00', 30],
      ['night', '21:00', '08:00', 0],
    ])
  })

  test('invalid away keeps the previous config', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tgmcp-'))
    const path = join(dir, 'config.json')
    writeFileSync(path, JSON.stringify({ away: { enabled: true } }))
    const store = new ConfigStore(path)
    writeFileSync(path, JSON.stringify({ away: { enabled: true, from: '25:00' } }))
    store.reload()
    expect(store.error()).toContain('config.json is invalid')
    expect(store.get().away.schedules.map(s => s.from)).toEqual(['18:00'])
  })
})

describe('chatCreation', () => {
  test('off unless turned on, in a new config and in the example', () => {
    expect(parseConfig('{}').chatCreation).toEqual({ enabled: false })
    expect(parseConfig(JSON.stringify({ chatCreation: { enabled: true } })).chatCreation.enabled).toBe(true)
    const example = parseConfig(readFileSync(join(import.meta.dir, '../config.example.json'), 'utf8'))
    expect(example.chatCreation.enabled).toBe(false)
  })
})

describe('USERNAME_RE', () => {
  test('Telegram\'s username rules', () => {
    for (const ok of ['acme_support', '@acme_support', 'Abcde', 'a1234', 'a_b_c_d']) expect(USERNAME_RE.test(ok)).toBe(true)
    for (const bad of ['abcd', '1abcde', '_abcde', 'abcde_', 'ab__cd', 'ab-cde', 'a'.repeat(33), '@@abcde', 'ab cde']) {
      expect(USERNAME_RE.test(bad)).toBe(false)
    }
    expect(USERNAME_RE.test('a'.repeat(32))).toBe(true)
  })
})
