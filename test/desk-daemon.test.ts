import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDaemon } from '../src/daemon/main'
import { eventsKey } from '../src/daemon/server'
import { DaemonClient } from '../src/mcp/daemon-client'
import { getPaths } from '../src/shared/paths'
import type { TgEvent } from '../src/shared/protocol'
import { ANNA, FakeTelegram, LEO, TEAM_QA } from './fake-telegram'

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
  const tg = new FakeTelegram().add(LEO, ANNA, TEAM_QA)
  const daemon: Daemon = await createDaemon({ paths, port: 0, telegram: tg, log: () => {}, pageBotToken: null })
  cleanup.push(() => daemon.stop())
  return { daemon, tg, paths }
}

async function connect(daemon: Daemon, opts: { sessionId: string; desk?: string; startedAt?: number }) {
  const events: TgEvent[] = []
  const client = new DaemonClient({
    target: () => ({ url: `ws://127.0.0.1:${daemon.port}/bridge`, token: daemon.token }),
    sessionId: opts.sessionId,
    label: opts.sessionId,
    channel: true,
    ...(opts.desk ? { desk: opts.desk } : {}),
    ...(opts.startedAt !== undefined ? { startedAt: opts.startedAt } : {}),
    log: () => {},
  })
  client.onEvent = e => events.push(e)
  client.start()
  cleanup.push(() => client.close())
  const end = Date.now() + 5_000
  while (!client.connected && Date.now() < end) await Bun.sleep(10)
  // The hello is the first frame; a call after it is answered only once the daemon has read it.
  await client.call('telegram_status', {}).catch(() => {})
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

  test('an older proxy turned away from a desk gets no catch-up and none of its calls work', async () => {
    const { daemon, tg } = await start()
    let reads = 0
    const read = tg.getHistory.bind(tg)
    tg.getHistory = (chatId, opts) => {
      reads++
      return read(chatId, opts)
    }
    const newer = await connect(daemon, { sessionId: 's_desknew1', desk: 'desk', startedAt: 2_000 })
    await newer.client.call('telegram_watch', { chat: 'leo' })
    tg.emit(LEO.id, 'seen', LEO.id, { id: 6001 })
    await settle()
    const older = await connect(daemon, { sessionId: 's_deskold1', desk: 'desk', startedAt: 1_000 })
    await settle()
    for (const [tool, args] of [
      ['telegram_status', {}],
      ['telegram_confirm_send', { approvalId: 'a_x' }],
      ['telegram_cancel_send', { approvalId: 'a_x' }],
    ] as const) {
      await expect(older.client.call(tool, args)).rejects.toThrow('desk "desk"')
    }
    // The newer one still holds it.
    expect((await newer.client.call('telegram_status', {})).result.text).toContain('Desk: desk')
    expect(reads).toBe(0)
  })

  test("a desk's Monitor key changes with its holder: the old session's Monitor URL is refused", async () => {
    const { daemon } = await start()
    const events = (key: string) => fetch(`http://127.0.0.1:${daemon.port}/events?session=d_desk&key=${key}`)
    await connect(daemon, { sessionId: 's_deskone1', desk: 'desk' })
    const oldKey = eventsKey(daemon.token, 'd_desk', daemon.hub.eventsEpoch('d_desk'))
    // The right key gets as far as the upgrade (400: a plain fetch is not a WebSocket).
    expect((await events(oldKey)).status).toBe(400)
    // A key made the ordinary way, without the desk's epoch, never opens a desk's stream.
    expect((await events(eventsKey(daemon.token, 'd_desk'))).status).toBe(401)
    await connect(daemon, { sessionId: 's_desktwo2', desk: 'desk' })
    expect((await events(oldKey)).status).toBe(401)
    expect((await events(eventsKey(daemon.token, 'd_desk', daemon.hub.eventsEpoch('d_desk')))).status).toBe(400)
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
    // Caught up from history, and marked so: the desk can tell they are not live.
    expect(after.events.map(e => e.caughtUp)).toEqual([true, true])
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

  test('a draft made before its chat joined a desk is refused when approved; old watches there say they hear nothing', async () => {
    const { daemon, tg, paths } = await start({ ...CONFIG, desks: {} })
    const plain = await connect(daemon, { sessionId: 's_plainone' })
    await plain.client.call('telegram_watch', { chat: 'anna' })
    // leo is on autoReply but not watched, so a send waits for approval.
    const draft = (await plain.client.call('telegram_send_message', { to: 'leo', text: 'waiting' })).result
    expect(draft.approval).toBeDefined()
    writeFileSync(paths.config, JSON.stringify({ ...CONFIG, desks: { desk: { chats: ['leo', 'anna'] } } }))
    daemon.store.reload()
    const r = await daemon.service.decide(draft.approval!.id, true, 'menubar', null)
    expect(r.isError).toBe(true)
    expect(r.text).toContain('desk "desk"')
    expect(tg.sent).toHaveLength(0)
    expect((await plain.client.call('telegram_status', {})).result.text).toContain('belongs to desk "desk"')
  })

  test("another session can't ask to link a desk's supergroup as a new channel's discussion group", async () => {
    const { daemon } = await start({
      ...CONFIG,
      chatCreation: { enabled: true },
      chats: { ...CONFIG.chats, qa: { id: TEAM_QA.id, name: TEAM_QA.name } },
      desks: { desk: { chats: ['leo', 'qa'] } },
    })
    daemon.service.touchUi(['create'])
    const plain = await connect(daemon, { sessionId: 's_plainone' })
    const r = (await plain.client.call('telegram_create_chat', { type: 'channel', title: 'News', discussion: { kind: 'existing', chat: 'qa' } }))
      .result
    expect(r.isError).toBe(true)
    expect(r.text).toContain('desk "desk"')
  })

  test('a desk that config.json does not list is ignored: the proxy is an ordinary session', async () => {
    const { daemon } = await start()
    const other = await connect(daemon, { sessionId: 's_othernm1', desk: 'other' })
    const status = (await other.client.call('telegram_status', {})).result.text
    expect(status).toContain('This session: s_othernm1')
    expect(status).not.toContain('Desk:')
    expect(daemon.hub.has('d_other')).toBe(false)
  })

  test("a hello that names a desk's session id, or any odd id, without --desk is turned away", async () => {
    const { daemon } = await start()
    for (const sessionId of ['d_desk', 'anything', 's_TOOLONG123']) {
      const ws = new WebSocket(`ws://127.0.0.1:${daemon.port}/bridge`, { headers: { authorization: `Bearer ${daemon.token}` } } as never)
      const closed = new Promise<number>(resolve => (ws.onclose = e => resolve(e.code)))
      await new Promise(resolve => (ws.onopen = resolve))
      ws.send(JSON.stringify({ t: 'hello', sessionId, label: 'x', channel: false, watches: [] }))
      expect(await closed).toBe(1008)
    }
    expect(daemon.hub.has('d_desk')).toBe(false)
    expect(daemon.hub.has('anything')).toBe(false)
  })

  test("a moderator's /bots command in the history is noted, never handed to the desk", async () => {
    const config = { ...CONFIG, moderation: { enabled: true, moderators: [LEO.id] } }
    const home = mkdtempSync(join(tmpdir(), 'tgmcp-desk-bots-'))
    const a = await start(config, home)
    const before = await connect(a.daemon, { sessionId: 's_deskone1', desk: 'desk' })
    await before.client.call('telegram_watch', { chat: 'leo' })
    a.tg.emit(LEO.id, 'handled', LEO.id, { id: 7001 })
    await settle()
    before.client.close()
    await a.daemon.stop()

    const b = await start(config, home)
    const at = (id: number, text: string) => ({
      id, chatId: LEO.id, date: new Date().toISOString(), from: LEO, outgoing: false, text, media: null, replyToId: null, topicId: null,
    })
    b.tg.history.set(LEO.id, [at(7001, 'handled'), at(7002, '/bots stop'), at(7003, 'missed')])
    const after = await connect(b.daemon, { sessionId: 's_desktwo2', desk: 'desk' })
    await settle()
    expect(after.events.map(e => e.text)).toEqual(['missed'])
    expect(b.daemon.hub.lastSeen('d_desk', LEO.id)).toBe(7003)
  })

  test('a catch-up while Telegram is not connected waits, says so, and runs on a later hello', async () => {
    const home = mkdtempSync(join(tmpdir(), 'tgmcp-desk-offline-'))
    const a = await start(CONFIG, home)
    const before = await connect(a.daemon, { sessionId: 's_deskone1', desk: 'desk' })
    await before.client.call('telegram_watch', { chat: 'leo' })
    a.tg.emit(LEO.id, 'handled', LEO.id, { id: 8001 })
    await settle()
    before.client.close()
    await a.daemon.stop()

    const logs: string[] = []
    const paths = getPaths(home)
    const tg = new FakeTelegram().add(LEO, ANNA)
    tg.phase = 'connecting'
    tg.history.set(LEO.id, [
      { id: 8002, chatId: LEO.id, date: new Date().toISOString(), from: LEO, outgoing: false, text: 'missed', media: null, replyToId: null, topicId: null },
    ])
    const b = await createDaemon({ paths, port: 0, telegram: tg, log: m => logs.push(m), pageBotToken: null })
    cleanup.push(() => b.stop())
    b.hub.attachProxy('d_desk', { label: 'x', channel: false, watches: [], desk: 'desk', startedAt: 1 }, { send: () => 1 })
    expect(await b.service.catchUpDesk('d_desk', 50)).toBe(0)
    expect(logs.some(l => l.includes('no catch-up yet'))).toBe(true)
    tg.phase = 'connected'
    expect(await b.service.catchUpDesk('d_desk', 50)).toBe(1)
    expect(b.hub.drain('d_desk').events.map(e => e.text)).toEqual(['missed'])
  })

  test("a hello with odd fields can't spoil desks.json: the label is made one line, bad watches are dropped", async () => {
    const home = mkdtempSync(join(tmpdir(), 'tgmcp-desk-hello-'))
    const { daemon } = await start(CONFIG, home)
    const ws = new WebSocket(`ws://127.0.0.1:${daemon.port}/bridge`, { headers: { authorization: `Bearer ${daemon.token}` } } as never)
    await new Promise(resolve => (ws.onopen = resolve))
    const welcome = new Promise(resolve => (ws.onmessage = resolve))
    ws.send(
      JSON.stringify({
        t: 'hello',
        sessionId: 's_oddhello',
        desk: 'desk',
        label: 'two\nlines',
        channel: 'yes',
        watches: [{ id: 'w_ok', chatId: LEO.id, chatLabel: 'Leo', createdAt: 0 }, { id: 5 }, 'nope'],
      }),
    )
    await welcome
    const s = daemon.hub.snapshot().find(x => x.id === 'd_desk')!
    expect(s.label).toBe('two lines')
    expect(s.channel).toBe(false)
    expect(s.watches.map(w => w.id)).toEqual(['w_ok'])
    ws.close()
    daemon.hub.flush()
    // The file it wrote loads cleanly.
    const logs: string[] = []
    const { SessionHub } = await import('../src/daemon/sessions')
    const { DeskStore } = await import('../src/daemon/desk-store')
    const again = new SessionHub({ desks: new DeskStore(join(home, 'desks.json'), m => logs.push(m)) })
    expect(again.watches('d_desk').map(w => w.id)).toEqual(['w_ok'])
    expect(logs).toEqual([])
  })

  test('telegram_get_events hands over at most 200 at a time and says how many wait', async () => {
    const { daemon, tg } = await start()
    daemon.hub.attachProxy('d_desk', { label: 'x', channel: false, watches: [], desk: 'desk', startedAt: 1 }, { send: () => 1 })
    daemon.hub.addWatch('d_desk', { chatId: LEO.id, chatLabel: 'Leo' })
    for (let i = 0; i < 250; i++) tg.emit(LEO.id, `m${i}`, LEO.id, { id: 9000 + i })
    const first = await daemon.service.call('d_desk', 'telegram_get_events', {})
    expect(first.text.match(/^Telegram message from/gm)).toHaveLength(200)
    expect(first.text).toContain('50 more waiting')
    const second = await daemon.service.call('d_desk', 'telegram_get_events', {})
    expect(second.text.match(/^Telegram message from/gm)).toHaveLength(50)
    expect(second.text).not.toContain('more waiting')
  })

  test('a desk name that is not valid is ignored: the proxy is an ordinary session', async () => {
    const { daemon } = await start()
    const odd = await connect(daemon, { sessionId: 's_oddname1', desk: 'Not A Desk' })
    const status = (await odd.client.call('telegram_status', {})).result.text
    expect(status).toContain('This session: s_oddname1')
    expect(status).not.toContain('Desk:')
  })
})
