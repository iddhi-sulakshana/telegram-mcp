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

async function start(config: unknown = CONFIG) {
  const paths = getPaths(mkdtempSync(join(tmpdir(), 'tgmcp-desk-')))
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

  test('a desk name that is not valid is ignored: the proxy is an ordinary session', async () => {
    const { daemon } = await start()
    const odd = await connect(daemon, { sessionId: 's_oddname1', desk: 'Not A Desk' })
    const status = (await odd.client.call('telegram_status', {})).result.text
    expect(status).toContain('This session: s_oddname1')
    expect(status).not.toContain('Desk:')
  })
})
