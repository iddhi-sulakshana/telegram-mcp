import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDaemon } from '../src/daemon/main'
import { DaemonClient } from '../src/mcp/daemon-client'
import { getPaths } from '../src/shared/paths'
import type { TgEvent } from '../src/shared/protocol'
import { ANNA, FakeTelegram, LEO } from './fake-telegram'

const CONFIG = {
  footer: '',
  chats: { leo: { id: LEO.id, username: 'leo_p', name: LEO.name }, anna: { id: ANNA.id, username: 'anna_k', name: ANNA.name } },
  rules: { autoReply: ['leo', 'anna'] },
  desks: { desk: { chats: ['leo'] } },
}

type Daemon = Awaited<ReturnType<typeof createDaemon>>
const cleanup: (() => unknown)[] = []
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c()
})

async function start(config: unknown = CONFIG, home = mkdtempSync(join(tmpdir(), 'tgmcp-desk-'))) {
  const paths = getPaths(home)
  writeFileSync(paths.config, JSON.stringify(config))
  const tg = new FakeTelegram().add(LEO, ANNA)
  const daemon: Daemon = await createDaemon({ paths, port: 0, telegram: tg, log: () => {}, pageBotToken: null })
  cleanup.push(() => daemon.stop())
  return { daemon, tg, paths }
}

async function connect(daemon: Daemon, opts: { sessionId: string; desk?: string }) {
  const events: TgEvent[] = []
  const client = new DaemonClient({
    target: () => ({ url: `ws://127.0.0.1:${daemon.port}/bridge`, token: daemon.token }),
    sessionId: opts.sessionId,
    label: opts.sessionId,
    channel: true,
    ...(opts.desk ? { desk: opts.desk } : {}),
    log: () => {},
  })
  client.onEvent = e => events.push(e)
  client.start()
  cleanup.push(() => client.close())
  const end = Date.now() + 5_000
  while (!client.connected && Date.now() < end) await Bun.sleep(10)
  // The hello is the first frame; a call after it is answered only once the daemon has read it.
  await client.call('telegram_status', {})
  return { client, events }
}

const settle = () => Bun.sleep(50)

describe('desk sessions through the daemon', () => {
  test('a proxy started with a desk is that desk; its chats reach only it', async () => {
    const { daemon, tg } = await start()
    const plain = await connect(daemon, { sessionId: 's_plainone' })
    const desk = await connect(daemon, { sessionId: 's_deskone1', desk: 'desk' })
    for (const c of [plain, desk]) {
      expect((await c.client.call('telegram_watch', { chat: 'anna' })).result.isError).toBeFalsy()
    }
    expect((await desk.client.call('telegram_watch', { chat: 'leo' })).result.isError).toBeFalsy()
    const status = (await desk.client.call('telegram_status', {})).result.text
    expect(status).toContain('This session: d_desk')
    expect(status).toContain('Desk: desk')

    tg.emit(LEO.id, 'to the desk only')
    tg.emit(ANNA.id, 'to everyone')
    await settle()
    expect(desk.events.map(e => e.text)).toEqual(['to the desk only', 'to everyone'])
    expect(plain.events.map(e => e.text)).toEqual(['to everyone'])
  })

  test('a second proxy for the same desk takes it over; the first one is refused from then on', async () => {
    const { daemon, tg } = await start()
    const first = await connect(daemon, { sessionId: 's_deskone1', desk: 'desk' })
    await first.client.call('telegram_watch', { chat: 'leo' })
    const second = await connect(daemon, { sessionId: 's_desktwo2', desk: 'desk' })
    // It keeps the desk's watch without watching again.
    expect((await second.client.call('telegram_status', {})).result.text).toContain('Leo Perera')
    await expect(first.client.call('telegram_status', {})).rejects.toThrow('desk "desk"')
    tg.emit(LEO.id, 'after the move')
    await settle()
    expect(first.events).toHaveLength(0)
    expect(second.events.map(e => e.text)).toEqual(['after the move'])
  })

  test("other sessions can't send, edit, delete, make topics or watch in a desk's chat; the desk can", async () => {
    const { daemon, tg } = await start()
    const plain = await connect(daemon, { sessionId: 's_plainone' })
    const desk = await connect(daemon, { sessionId: 's_deskone1', desk: 'desk' })
    for (const [tool, args] of [
      ['telegram_send_message', { to: 'leo', text: 'hi' }],
      ['telegram_send_sticker', { to: 'leo', fromChat: 'anna', messageId: 1 }],
      ['telegram_create_topic', { chat: 'leo', title: 't' }],
      ['telegram_watch', { chat: 'leo' }],
    ] as const) {
      const r = (await plain.client.call(tool, args)).result
      expect(r.isError).toBe(true)
      expect(r.text).toContain('desk "desk"')
    }
    expect(tg.sent).toHaveLength(0)
    // Chats outside the desk are untouched.
    expect((await plain.client.call('telegram_watch', { chat: 'anna' })).result.isError).toBeFalsy()
    // The desk follows the usual rules: leo is autoReply, so it sends once it watches.
    await desk.client.call('telegram_watch', { chat: 'leo' })
    const sent = (await desk.client.call('telegram_send_message', { to: 'leo', text: 'from the desk' })).result
    expect(sent.isError).toBeFalsy()
    expect(tg.sent.map(s => s.text)).toEqual(['from the desk'])
  })

  test("once a chat joins a desk, another session can't edit or delete what it sent there before", async () => {
    const { daemon, tg, paths } = await start({ ...CONFIG, desks: {} })
    const plain = await connect(daemon, { sessionId: 's_plainone' })
    await plain.client.call('telegram_watch', { chat: 'leo' })
    const sent = (await plain.client.call('telegram_send_message', { to: 'leo', text: 'before the desk' })).result
    expect(sent.isError).toBeFalsy()
    expect(tg.sent).toHaveLength(1)
    const messageId = Number(/message #(\d+)/.exec(sent.text)![1])
    writeFileSync(paths.config, JSON.stringify(CONFIG))
    daemon.store.reload()
    for (const [tool, args] of [
      ['telegram_edit_message', { chat: 'leo', messageId, text: 'changed' }],
      ['telegram_delete_message', { chat: 'leo', messageId }],
    ] as const) {
      const r = (await plain.client.call(tool, args)).result
      expect(r.isError).toBe(true)
      expect(r.text).toContain('desk "desk"')
    }
  })

  test('a daemon restart loses no desk message and delivers none twice', async () => {
    const home = mkdtempSync(join(tmpdir(), 'tgmcp-desk-restart-'))
    const a = await start(CONFIG, home)
    const before = await connect(a.daemon, { sessionId: 's_deskone1', desk: 'desk' })
    await before.client.call('telegram_watch', { chat: 'leo' })
    // The Claude session goes away (a restart, /mcp), then a message comes in.
    before.client.close()
    await settle()
    a.tg.emit(LEO.id, 'while the session was away', LEO.id, { id: 2001 })
    await a.daemon.stop()

    const b = await start(CONFIG, home)
    // Telegram's catch-up runs as soon as the daemon starts, before any proxy is back.
    b.tg.emit(LEO.id, 'while the daemon was down', LEO.id, { id: 2002 })
    const after = await connect(b.daemon, { sessionId: 's_desktwo2', desk: 'desk' })
    await settle()
    expect(after.events.map(e => e.text)).toEqual(['while the session was away', 'while the daemon was down'])
    // The same message again (a replayed update) is not delivered twice.
    b.tg.emit(LEO.id, 'while the daemon was down', LEO.id, { id: 2002 })
    b.tg.emit(LEO.id, 'new', LEO.id, { id: 2003 })
    await settle()
    expect(after.events.map(e => e.text)).toEqual(['while the session was away', 'while the daemon was down', 'new'])
  })

  test("when the desk comes back, messages Telegram never replayed are caught up from the chat's history", async () => {
    const home = mkdtempSync(join(tmpdir(), 'tgmcp-desk-gap-'))
    const a = await start(CONFIG, home)
    const before = await connect(a.daemon, { sessionId: 's_deskone1', desk: 'desk' })
    await before.client.call('telegram_watch', { chat: 'leo' })
    await before.client.call('telegram_watch', { chat: 'anna' })
    a.tg.emit(LEO.id, 'handled', LEO.id, { id: 3001 })
    a.tg.emit(ANNA.id, 'anna handled', ANNA.id, { id: 3002 })
    await settle()
    expect(before.events.map(e => e.text)).toEqual(['handled', 'anna handled'])
    before.client.close()
    await a.daemon.stop()

    // A long outage: Telegram's own catch-up gave nothing back, but the chats' history has the messages.
    const b = await start(CONFIG, home)
    const at = (id: number, chatId: number, text: string, outgoing = false) => ({
      id, chatId, date: new Date().toISOString(), from: outgoing ? b.tg.me : b.tg.peers.get(chatId)!, outgoing, text,
      media: null, replyToId: null, topicId: null,
    })
    b.tg.history.set(LEO.id, [at(3001, LEO.id, 'handled'), at(3003, LEO.id, 'missed 1'), at(3004, LEO.id, 'my reply', true), at(3005, LEO.id, 'missed 2')])
    // anna is not the desk's own chat: other sessions may watch it, so it is never replayed from history.
    b.tg.history.set(ANNA.id, [at(3002, ANNA.id, 'anna handled'), at(3006, ANNA.id, 'anna missed')])
    const after = await connect(b.daemon, { sessionId: 's_desktwo2', desk: 'desk' })
    await settle()
    expect(after.events.map(e => e.text)).toEqual(['missed 1', 'missed 2'])
    // Coming back again finds nothing new.
    after.client.close()
    await settle()
    const again = await connect(b.daemon, { sessionId: 's_deskthr3', desk: 'desk' })
    await settle()
    expect(again.events).toHaveLength(0)
  })

  test('the catch-up fills the gap even when a newer message came in live before the desk was back', async () => {
    const home = mkdtempSync(join(tmpdir(), 'tgmcp-desk-race-'))
    const a = await start(CONFIG, home)
    const before = await connect(a.daemon, { sessionId: 's_deskone1', desk: 'desk' })
    await before.client.call('telegram_watch', { chat: 'leo' })
    a.tg.emit(LEO.id, 'handled', LEO.id, { id: 3001 })
    await settle()
    before.client.close()
    await a.daemon.stop()

    const b = await start(CONFIG, home)
    const at = (id: number, text: string) => ({
      id, chatId: LEO.id, date: new Date().toISOString(), from: LEO, outgoing: false, text, media: null, replyToId: null, topicId: null,
    })
    b.tg.history.set(LEO.id, [at(3001, 'handled'), at(3003, 'missed 1'), at(3005, 'missed 2'), at(3007, 'live after restart')])
    b.tg.emit(LEO.id, 'live after restart', LEO.id, { id: 3007 })
    let reads = 0
    const read = b.tg.getHistory.bind(b.tg)
    b.tg.getHistory = (chatId, opts) => {
      reads++
      return read(chatId, opts)
    }
    const after = await connect(b.daemon, { sessionId: 's_desktwo2', desk: 'desk' })
    await settle()
    expect(after.events.map(e => e.text)).toEqual(['live after restart', 'missed 1', 'missed 2'])
    expect(reads).toBe(1)
    // Once per daemon run: a reconnect reads no history again.
    after.client.close()
    await settle()
    await connect(b.daemon, { sessionId: 's_deskthr3', desk: 'desk' })
    await settle()
    expect(reads).toBe(1)
  })

  test('a message the desk never heard live (its chat was off autoReply) is not caught up after a restart', async () => {
    const home = mkdtempSync(join(tmpdir(), 'tgmcp-desk-gated-'))
    const a = await start(CONFIG, home)
    const before = await connect(a.daemon, { sessionId: 's_deskone1', desk: 'desk' })
    await before.client.call('telegram_watch', { chat: 'leo' })
    a.tg.emit(LEO.id, 'handled', LEO.id, { id: 4001 })
    await settle()
    // The owner takes leo off autoReply for a while: sessions must not hear what is said meanwhile.
    writeFileSync(join(home, 'config.json'), JSON.stringify({ ...CONFIG, rules: { autoReply: ['anna'] } }))
    a.daemon.store.reload()
    a.tg.emit(LEO.id, 'said while off autoReply', LEO.id, { id: 4002 })
    await settle()
    expect(before.events.map(e => e.text)).toEqual(['handled'])
    writeFileSync(join(home, 'config.json'), JSON.stringify(CONFIG))
    a.daemon.store.reload()
    before.client.close()
    await a.daemon.stop()

    const b = await start(CONFIG, home)
    const at = (id: number, text: string) => ({
      id, chatId: LEO.id, date: new Date().toISOString(), from: LEO, outgoing: false, text, media: null, replyToId: null, topicId: null,
    })
    b.tg.history.set(LEO.id, [at(4001, 'handled'), at(4002, 'said while off autoReply'), at(4003, 'missed')])
    const after = await connect(b.daemon, { sessionId: 's_desktwo2', desk: 'desk' })
    await settle()
    expect(after.events.map(e => e.text)).toEqual(['missed'])
  })

  test('a desk name that is not valid is ignored: the proxy is an ordinary session', async () => {
    const { daemon } = await start()
    const odd = await connect(daemon, { sessionId: 's_oddname1', desk: 'Not A Desk' })
    const status = (await odd.client.call('telegram_status', {})).result.text
    expect(status).toContain('This session: s_oddname1')
    expect(status).not.toContain('Desk:')
  })
})
