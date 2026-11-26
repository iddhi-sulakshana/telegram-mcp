import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { deskOf, parseConfig, rulesMentioning } from '../src/shared/config'
import { renameContact } from '../src/shared/contacts'
import { instructions } from '../src/mcp/proxy'
import { deskName, deskSessionId } from '../src/shared/desks'

const config = parseConfig(
  JSON.stringify({
    chats: { leo: { id: 10, username: 'leo_p' }, qa: { id: -1001234567890 } },
    desks: { desk: { chats: ['leo', -1001234567890, '@anna_k'] } },
  }),
)

describe('desks in config.json', () => {
  test('off by default: a config without desks owns no chat', () => {
    const plain = parseConfig('{}')
    expect(plain.desks).toEqual({})
    expect(deskOf(plain, { id: 10 })).toBeNull()
  })

  test('a chat listed under a desk belongs to it, by nickname, id or @username', () => {
    expect(deskOf(config, { id: 10 })).toBe('desk')
    expect(deskOf(config, { id: -1001234567890 })).toBe('desk')
    expect(deskOf(config, { id: 77, username: 'Anna_K' })).toBe('desk')
  })

  test('other chats belong to no desk', () => {
    expect(deskOf(config, { id: 11 })).toBeNull()
    // Unlike the blocked list, a desk matches the marked id exactly.
    expect(deskOf(config, { id: 1234567890 })).toBeNull()
  })

  test('a nickname a desk uses is guarded like one the rules use', () => {
    // Else a session could repoint "leo" (telegram_save_chat) and move the desk to another chat.
    expect(rulesMentioning(config, 'LEO')).toEqual(['desks.desk'])
    expect(rulesMentioning(config, 'qa')).toEqual([])
  })

  test('renaming a contact (tray Contacts page) keeps its chat on the desk', () => {
    const c = parseConfig(JSON.stringify({ chats: { leo: { id: 10 } }, desks: { desk: { chats: ['leo', 'LEO ', 'other'] } } }))
    renameContact(c, 'leo', 'leonard')
    expect(c.desks.desk!.chats).toEqual(['leonard', 'leonard', 'other'])
    expect(deskOf(c, { id: 10 })).toBe('desk')
  })

  test('the example config has a desk that owns leo', () => {
    const example = parseConfig(readFileSync(join(import.meta.dir, '../config.example.json'), 'utf8'))
    expect(deskOf(example, { id: example.chats.leo!.id })).toBe('desk')
  })

  test('a desk name is lowercase letters, digits, - and _', () => {
    expect(() => parseConfig(JSON.stringify({ desks: { 'Bad Name': { chats: [] } } }))).toThrow()
    expect(() => parseConfig(JSON.stringify({ desks: { 'tg-desk_2': { chats: [] } } }))).not.toThrow()
  })
})

describe('what a session is told about desks', () => {
  test('nothing, when config.json has no desks', () => {
    expect(instructions(false, [], { hasDesks: false })).not.toContain('desk')
  })
  test('how to treat a refusal, when there are desks; and which one it holds, if any', () => {
    expect(instructions(false, [], { hasDesks: true })).toContain('hand the reply to that session')
    expect(instructions(false, [], { hasDesks: true, desk: 'desk' })).toContain('This session holds desk "desk"')
  })
})

describe('desk names from a proxy', () => {
  test('only a valid name is taken; anything else means no desk', () => {
    expect(deskName('tg-desk')).toBe('tg-desk')
    expect(deskName(' tg-desk ')).toBeNull()
    expect(deskName('TG')).toBeNull()
    expect(deskName('a'.repeat(33))).toBeNull()
    expect(deskName(undefined)).toBeNull()
    expect(deskName(42)).toBeNull()
  })

  test('a desk session has one id, whichever proxy speaks for it', () => {
    expect(deskSessionId('tg-desk')).toBe('d_tg-desk')
  })
})
