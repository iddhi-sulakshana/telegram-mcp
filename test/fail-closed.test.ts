import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Approvals } from '../src/daemon/approvals'
import { Service } from '../src/daemon/service'
import { SessionHub } from '../src/daemon/sessions'
import { ConfigStore } from '../src/shared/config'
import { FakeTelegram, LEO, TEAM_QA } from './fake-telegram'

const GOOD = {
  footer: '',
  chats: { leo: { id: LEO.id, username: 'leo_p', name: LEO.name }, qa: { id: TEAM_QA.id, name: 'Team QA' } },
  rules: { autoSend: ['leo'], requireApproval: ['qa'] },
}

function setup(initial: string) {
  const dir = mkdtempSync(join(tmpdir(), 'tgmcp-closed-'))
  const path = join(dir, 'config.json')
  writeFileSync(path, initial)
  const logs: string[] = []
  const store = new ConfigStore(path, m => logs.push(m))
  const tg = new FakeTelegram().add(LEO, TEAM_QA)
  const hub = new SessionHub()
  hub.attachProxy('s1', { label: 'one', channel: false, watches: [] }, { send() {} })
  const approvals = new Approvals()
  const svc = new Service({ store, tg, hub, approvals, eventsUrl: () => 'ws://x', log: m => logs.push(m) })
  const write = (config: unknown) => {
    writeFileSync(path, typeof config === 'string' ? config : JSON.stringify(config))
    store.reload()
  }
  return { store, tg, svc, logs, write, approvals }
}

describe('config.json invalid at start: fail closed', () => {
  test('every send, edit, delete and create is refused; reads still work; status and the log say why', async () => {
    const { store, tg, svc, logs } = setup('{ not json')
    expect(store.writesRefused()).toContain('config.json is invalid')
    // The stand-in config blocks anything off the lists, in case a path forgets to check.
    expect(store.get().defaultPolicy).toBe('block')
    for (const [tool, args] of [
      ['telegram_send_message', { to: LEO.id, text: 'hi' }],
      ['telegram_send_sticker', { to: LEO.id, chat: LEO.id, messageId: 1 }],
      ['telegram_edit_message', { chat: LEO.id, messageId: 1, text: 'x' }],
      ['telegram_delete_message', { chat: LEO.id, messageId: 1 }],
      ['telegram_create_topic', { chat: TEAM_QA.id, title: 't' }],
      ['telegram_create_chat', { type: 'supergroup', title: 'T' }],
      ['telegram_confirm_send', { approvalId: 'a_x' }],
    ] as const) {
      const r = await svc.call('s1', tool, args)
      expect(r.isError).toBe(true)
      expect(r.text).toContain('Refused')
    }
    expect(tg.sent).toHaveLength(0)
    expect(tg.created).toHaveLength(0)
    // Reading is harmless and helps the user see what is going on.
    expect((await svc.call('s1', 'telegram_read_messages', { chat: LEO.id })).isError).toBeFalsy()
    const status = (await svc.call('s1', 'telegram_status', {})).text
    expect(status).toContain('Writes: REFUSED')
    expect(status).toContain('config.json is invalid')
    expect(logs.some(l => l.includes('every send, edit, delete and create is refused'))).toBe(true)
    // An away reply or a page reply goes the same way out, and is refused there too.
    await expect(svc.sendAway(LEO.id, 'away')).rejects.toThrow('Refused')
    expect(tg.sent).toHaveLength(0)
  })

  test('sends work as soon as a valid config.json loads', async () => {
    const { store, tg, svc, logs, write } = setup(JSON.stringify({ rules: { autoSend: 'not a list' } }))
    expect(store.writesRefused()).not.toBeNull()
    expect((await svc.call('s1', 'telegram_send_message', { to: 'leo', text: 'hi' })).isError).toBe(true)
    write(GOOD)
    expect(store.writesRefused()).toBeNull()
    expect(store.error()).toBeNull()
    expect(logs.some(l => l.includes('valid again'))).toBe(true)
    const ok = await svc.call('s1', 'telegram_send_message', { to: 'leo', text: 'hi' })
    expect(ok.isError).toBeFalsy()
    expect(tg.sent).toHaveLength(1)
    expect((await svc.call('s1', 'telegram_status', {})).text).not.toContain('REFUSED')
  })

  test('an approval is refused while it refuses, and the draft keeps waiting', async () => {
    // A draft can't be made while it refuses; this checks the approval path holds on its own.
    const { svc, tg, approvals } = setup('{')
    const draft = approvals.create({
      sessionId: 's1', sessionLabel: 'one', chatId: LEO.id, chatLabel: LEO.name, chatDetail: '', username: 'leo_p',
      text: 'hi', parseMode: 'plain', reason: 'test', askedInUi: true, firstTime: false, nickname: 'leo', suggestedNickname: 'Leo',
    } as unknown as Parameters<Approvals['create']>[0])
    const r = await svc.decide(draft.id, true, 'menubar', null)
    expect(r.isError).toBe(true)
    expect(r.text).toContain('Refused')
    expect(approvals.peek(draft.id)).toBeDefined()
    expect(tg.sent).toHaveLength(0)
    // Dropping it is fine.
    expect((await svc.decide(draft.id, false, 'menubar', null)).isError).toBeFalsy()
  })
})

describe('a bad edit after a good start', () => {
  test('keeps the last good config, and sends still follow it', async () => {
    const { store, tg, svc, write } = setup(JSON.stringify(GOOD))
    expect(store.writesRefused()).toBeNull()
    write('{ broken')
    expect(store.error()).toContain('still using the previous version')
    expect(store.writesRefused()).toBeNull()
    expect(store.get().rules.autoSend).toEqual(['leo'])
    expect((await svc.call('s1', 'telegram_send_message', { to: 'leo', text: 'hi' })).isError).toBeFalsy()
    expect(tg.sent).toHaveLength(1)
    // qa still needs approval, as the last good config says.
    expect((await svc.call('s1', 'telegram_send_message', { to: 'qa', text: 'x' })).approval).toBeDefined()
  })
})

describe('/status', () => {
  test('a daemon started on a broken config.json says writes are refused, and stops once it is fixed', async () => {
    const { createDaemon } = await import('../src/daemon/main')
    const { getPaths } = await import('../src/shared/paths')
    const paths = getPaths(mkdtempSync(join(tmpdir(), 'tgmcp-closed-d-')))
    writeFileSync(paths.config, '{ "rules": ')
    const daemon = await createDaemon({ paths, port: 0, telegram: new FakeTelegram().add(LEO), log: () => {}, pageBotToken: null })
    const status = async () =>
      (await (await fetch(`http://127.0.0.1:${daemon.port}/status`, { headers: { authorization: `Bearer ${daemon.token}` } })).json()) as {
        config: { error: string | null; writesRefused: boolean }
      }
    expect((await status()).config).toMatchObject({ writesRefused: true })
    expect((await status()).config.error).toContain('refused')
    writeFileSync(paths.config, JSON.stringify(GOOD))
    daemon.store.reload()
    expect((await status()).config).toEqual({ path: paths.config, error: null, writesRefused: false } as never)
    await daemon.stop()
  })
})
