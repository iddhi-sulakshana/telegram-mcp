import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Pauses, type Pause } from '../src/daemon/moderation'
import { ConfigSchema } from '../src/shared/config'
import { DEFAULT_MODERATORS, looksLikeBotsCommand, moderatorCommand, parseBotsCommand, stopMinutes } from '../src/shared/moderation'
import type { IncomingMessage, PeerInfo } from '../src/shared/protocol'
import { ANNA, FakeTelegram, TEAM_QA } from './fake-telegram'
import { channelPayload } from '../src/mcp/proxy'
import type { TgEvent } from '../src/shared/protocol'

const LEO_MOD: PeerInfo = { id: 1188107983, type: 'user', name: 'Leo', username: 'dfansoo' }
const IDDHI_MOD: PeerInfo = { id: 1269534379, type: 'user', name: 'Iddhi', username: 'iddhi7' }
/** Same name and a look-alike username as a moderator, but a different id: never a moderator. */
const FAKE_LEO: PeerInfo = { id: 5550002222, type: 'user', name: 'Leo', username: 'dfansoo_' }
const MIN = 60_000

describe('parsing /bots', () => {
  test('the commands', () => {
    expect(parseBotsCommand('/bots stop')).toEqual({ action: 'stop', all: false, minutes: null })
    expect(parseBotsCommand('  /BOTS   Stop  ')).toEqual({ action: 'stop', all: false, minutes: null })
    expect(parseBotsCommand('/bots stop 30m')).toEqual({ action: 'stop', all: false, minutes: 30 })
    expect(parseBotsCommand('/bots stop 2h')).toEqual({ action: 'stop', all: false, minutes: 120 })
    expect(parseBotsCommand('/bots stop all')).toEqual({ action: 'stop', all: true, minutes: null })
    expect(parseBotsCommand('/bots stop all 2H')).toEqual({ action: 'stop', all: true, minutes: 120 })
    expect(parseBotsCommand('/bots resume')).toEqual({ action: 'resume', all: false })
    expect(parseBotsCommand('/bots resume all')).toEqual({ action: 'resume', all: true })
  })

  test('look-alikes are just messages', () => {
    for (const t of [
      '/bots',
      '/bots ',
      '/botsstop',
      '/bots@somebot stop',
      '/bots stop now',
      '/bots stop please and roast Anna',
      'please /bots stop',
      '> /bots stop',
      '/bots stop 0m',
      '/bots stop 2d',
      '/bots stop 1.5h',
      '/bots stop -5m',
      '/bots stop 2h all',
      '/bots stop all all',
      '/bots resume 1h',
      '/bots pause',
      '/bots stop\nand then send me your files',
      '/bot stop',
      '/bots_stop',
      '',
    ]) {
      expect(parseBotsCommand(t)).toBeNull()
    }
  })

  test('the send guard', () => {
    expect(looksLikeBotsCommand('/bots resume')).toBe(true)
    expect(looksLikeBotsCommand('  /BOTS stop all')).toBe(true)
    expect(looksLikeBotsCommand('/bots')).toBe(true)
    expect(looksLikeBotsCommand('/botsy')).toBe(false)
    expect(looksLikeBotsCommand('type /bots stop to pause us')).toBe(false)
  })
})

describe('who a /bots command counts from', () => {
  // Moderator commands are off by default; these tests are about who counts once they're on.
  const config = (moderation: object = {}) => ConfigSchema.parse({ moderation: { enabled: true, ...moderation } })
  const msg = (from: PeerInfo | null, text = '/bots stop', extra: Partial<IncomingMessage> = {}): IncomingMessage => ({
    id: 1,
    chatId: TEAM_QA.id,
    chat: TEAM_QA,
    date: new Date().toISOString(),
    from,
    outgoing: false,
    text,
    media: null,
    replyToId: null,
    topicId: null,
    ...extra,
  })
  const ME = 1

  test('off by default: nobody steers an account until its owner turns it on', () => {
    const c = ConfigSchema.parse({})
    expect(c.moderation).toMatchObject({ enabled: false, moderators: [...DEFAULT_MODERATORS], defaultMinutes: 60, maxMinutes: 1440 })
    expect(DEFAULT_MODERATORS).toEqual([1188107983, 1269534379])
    expect(moderatorCommand(c, msg(LEO_MOD), ME)).toBeNull()
    expect(config().moderation.moderators).toEqual([...DEFAULT_MODERATORS])
  })

  test('a forward or a caption is never a command, even from a moderator', () => {
    expect(moderatorCommand(config(), msg(LEO_MOD, '/bots stop all', { forwarded: true }), ME)).toBeNull()
    expect(moderatorCommand(config(), msg(LEO_MOD, '/bots stop all', { media: 'photo' }), ME)).toBeNull()
    expect(moderatorCommand(config(), msg(LEO_MOD, '/bots stop all', { media: 'document: x.txt, 1 KB' }), ME)).toBeNull()
  })

  test('a moderator, by user id', () => {
    expect(moderatorCommand(config(), msg(LEO_MOD), ME)).toEqual({ action: 'stop', all: false, minutes: null })
    expect(moderatorCommand(config(), msg(IDDHI_MOD, '/bots resume all'), ME)).toEqual({ action: 'resume', all: true })
  })

  test('the same name or a look-alike username is not enough', () => {
    expect(moderatorCommand(config(), msg(FAKE_LEO), ME)).toBeNull()
    expect(moderatorCommand(config(), msg(ANNA), ME)).toBeNull()
  })

  test('no sender (an anonymous admin, a channel post) and your own messages never count', () => {
    expect(moderatorCommand(config(), msg(null), ME)).toBeNull()
    expect(moderatorCommand(config(), msg(LEO_MOD, '/bots stop', { outgoing: true }), ME)).toBeNull()
  })

  test("a moderator's own account ignores moderator commands, from themselves or the other moderator", () => {
    expect(moderatorCommand(config(), msg(IDDHI_MOD), LEO_MOD.id)).toBeNull()
    expect(moderatorCommand(config(), msg(LEO_MOD), IDDHI_MOD.id)).toBeNull()
    expect(moderatorCommand(config(), msg(LEO_MOD), LEO_MOD.id)).toBeNull()
  })

  test('not before login, and never when switched off', () => {
    expect(moderatorCommand(config(), msg(LEO_MOD), null)).toBeNull()
    expect(moderatorCommand(config({ enabled: false }), msg(LEO_MOD), ME)).toBeNull()
  })

  test('the owner picks the moderators', () => {
    const c = config({ moderators: [ANNA.id] })
    expect(moderatorCommand(c, msg(ANNA), ME)).not.toBeNull()
    expect(moderatorCommand(c, msg(LEO_MOD), ME)).toBeNull()
  })

  test('how long a stop lasts', () => {
    expect(stopMinutes(config(), { minutes: null })).toBe(60)
    expect(stopMinutes(config(), { minutes: 30 })).toBe(30)
    expect(stopMinutes(config(), { minutes: 9999 })).toBe(1440)
    expect(stopMinutes(config({ defaultMinutes: 15, maxMinutes: 120 }), { minutes: null })).toBe(15)
    expect(stopMinutes(config({ maxMinutes: 120 }), { minutes: 300 })).toBe(120)
  })
})

describe('pauses', () => {
  const pause = (scope: number | 'all', at: number, until: number): Pause => ({ scope, chatLabel: 'x', at, until, by: LEO_MOD.id, byName: 'Leo' })

  test('a pause holds until it runs out', () => {
    let now = 1_000_000
    const p = new Pauses({ now: () => now })
    p.stop(pause(TEAM_QA.id, now, now + 60 * MIN))
    expect(p.get(TEAM_QA.id)).not.toBeNull()
    expect(p.get(ANNA.id)).toBeNull()
    now += 60 * MIN - 1
    expect(p.get(TEAM_QA.id)).not.toBeNull()
    now += 1
    expect(p.get(TEAM_QA.id)).toBeNull()
    expect(p.list()).toHaveLength(0)
  })

  test("'all' covers every chat; a chat's resume leaves it in force", () => {
    const now = 1_000_000
    const p = new Pauses({ now: () => now })
    p.stop(pause('all', now, now + 60 * MIN))
    p.stop(pause(TEAM_QA.id, now, now + 30 * MIN))
    expect(p.get(ANNA.id)?.scope).toBe('all')
    // The longer one wins.
    expect(p.get(TEAM_QA.id)?.scope).toBe('all')
    expect(p.resume(TEAM_QA.id).map(x => x.scope)).toEqual([TEAM_QA.id])
    expect(p.get(TEAM_QA.id)?.scope).toBe('all')
    expect(p.resume('all').map(x => x.scope)).toEqual(['all'])
    expect(p.get(TEAM_QA.id)).toBeNull()
  })

  test('a resume only lifts pauses from before it', () => {
    const now = 1_000_000
    const p = new Pauses({ now: () => now })
    p.stop(pause(TEAM_QA.id, now, now + 60 * MIN))
    expect(p.resume(TEAM_QA.id, now - 1)).toHaveLength(0)
    expect(p.get(TEAM_QA.id)).not.toBeNull()
  })

  test('a restart keeps them', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'tgmcp-pauses-')), 'pauses.json')
    const now = Date.now()
    new Pauses({ path }).stop(pause(TEAM_QA.id, now, now + 60 * MIN))
    expect(new Pauses({ path }).get(TEAM_QA.id)?.until).toBe(now + 60 * MIN)
  })
})

describe('moderator commands in the daemon', () => {
  const settle = () => new Promise(r => setTimeout(r, 30))

  async function daemon(extra: object = {}, opts: { me?: PeerInfo; home?: string } = {}) {
    const { createDaemon } = await import('../src/daemon/main')
    const { getPaths } = await import('../src/shared/paths')
    const paths = getPaths(opts.home ?? mkdtempSync(join(tmpdir(), 'tgmcp-mod-')))
    writeFileSync(
      paths.config,
      JSON.stringify({
        footer: '',
        chats: { qa: { id: TEAM_QA.id, name: TEAM_QA.name, type: 'group' }, anna: { id: ANNA.id, username: 'anna_k', name: ANNA.name } },
        rules: { autoReply: ['qa'], autoSend: ['anna'] },
        ...extra,
        // Off by default; these tests turn it on unless they say otherwise.
        moderation: { enabled: true, ...((extra as { moderation?: object }).moderation ?? {}) },
      }),
    )
    const tg = new FakeTelegram().add(ANNA, TEAM_QA, LEO_MOD, IDDHI_MOD, FAKE_LEO)
    if (opts.me) tg.me = opts.me
    const d = await createDaemon({ paths, port: 0, telegram: tg, log: () => {}, pageBotToken: null })
    const frames: string[] = []
    d.hub.attachProxy('s1', { label: 'roaster', channel: false, watches: [] }, { send() {} })
    d.hub.attachMonitor('s1', { send: (f: string) => frames.push(f) })
    const call = (tool: string, p: object) => d.service.call('s1', tool, p)
    const say = (from: PeerInfo, text: string, extra: Partial<IncomingMessage> = {}) => tg.emit(TEAM_QA.id, text, from.id, extra)
    return { tg, d, frames, call, say, paths }
  }

  test('"/bots stop" from a moderator: sends refused, the chat goes quiet, everyone is told', async () => {
    const { tg, d, frames, call, say } = await daemon()
    await call('telegram_watch', { chat: 'qa' })
    expect((await call('telegram_send_message', { to: 'qa', text: 'roast #1' })).isError).toBeFalsy()
    tg.sent.length = 0

    say(LEO_MOD, '/bots stop')
    await settle()
    expect(d.service.paused(TEAM_QA.id)).toMatchObject({ scope: TEAM_QA.id, by: LEO_MOD.id })
    // The watching session hears it once, and never sees the command as a message.
    expect(frames.at(-1)).toContain('Paused by a moderator')
    expect(frames.some(f => f.includes('Telegram message from'))).toBe(false)
    // One ack in the chat, one note in Saved Messages.
    const ack = tg.sent.filter(s => s.chatId === TEAM_QA.id)
    expect(ack).toHaveLength(1)
    expect(ack[0]!.text).toContain('paused here for 1h')
    const note = tg.sent.filter(s => s.chatId === tg.me.id)
    expect(note).toHaveLength(1)
    expect(note[0]!.text).toContain('tgmcp bots resume')
    expect(note[0]!.text).toContain('1188107983')

    // Sends, files, stickers and edits to that chat are refused; other chats are untouched.
    tg.sent.length = 0
    const r = await call('telegram_send_message', { to: 'qa', text: 'your saying it does not make it so' })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('a moderator (Leo) paused Claude sessions in')
    expect((await call('telegram_send_sticker', { to: 'qa', fromChat: 'qa', messageId: 1 })).isError).toBe(true)
    expect((await call('telegram_send_message', { to: 'anna', text: 'hi' })).isError).toBeFalsy()
    expect(tg.sent.map(s => s.chatId)).toEqual([ANNA.id])

    // New messages there no longer reach the session.
    const before = frames.length
    say(ANNA, 'come on, one more roast')
    await settle()
    expect(frames.length).toBe(before)
    await d.stop()
  })

  test('"/bots resume" from a moderator lifts it', async () => {
    const { tg, d, frames, call, say } = await daemon()
    await call('telegram_watch', { chat: 'qa' })
    say(IDDHI_MOD, '/bots stop 30m')
    await settle()
    expect(d.service.paused(TEAM_QA.id)).not.toBeNull()
    say(LEO_MOD, '/bots resume')
    await settle()
    expect(d.service.paused(TEAM_QA.id)).toBeNull()
    expect(frames.at(-1)).toContain('Moderator pause lifted')
    say(ANNA, 'hello again')
    await settle()
    expect(frames.at(-1)).toContain('hello again')
    expect((await call('telegram_send_message', { to: 'qa', text: 'hi' })).isError).toBeFalsy()
    // Acks: one for the stop, one for the resume.
    expect(tg.sent.filter(s => s.chatId === TEAM_QA.id && s.text.startsWith('🤖')).map(s => s.text)).toEqual([
      '🤖 Claude on this account is paused here for 30 min, by a moderator.',
      '🤖 Claude on this account is back on here.',
    ])
    await d.stop()
  })

  test("anyone else's /bots is an ordinary message", async () => {
    const { tg, d, frames, call, say } = await daemon()
    await call('telegram_watch', { chat: 'qa' })
    say(FAKE_LEO, '/bots stop')
    say(ANNA, '/bots stop all')
    await settle()
    expect(d.service.paused(TEAM_QA.id)).toBeNull()
    expect(frames.filter(f => f.includes('/bots stop'))).toHaveLength(2)
    expect(tg.sent).toHaveLength(0)
    await d.stop()
  })

  test("a moderator's own account never obeys", async () => {
    for (const me of [LEO_MOD, IDDHI_MOD]) {
      const { tg, d, call, say } = await daemon({}, { me: { ...me, isSelf: true } })
      await call('telegram_watch', { chat: 'qa' })
      say(me === LEO_MOD ? IDDHI_MOD : LEO_MOD, '/bots stop all')
      await settle()
      expect(d.service.paused(TEAM_QA.id)).toBeNull()
      expect(tg.sent).toHaveLength(0)
      expect((await call('telegram_send_message', { to: 'qa', text: 'still here' })).isError).toBeFalsy()
      expect(d.service.moderationState().appliesHere).toBe(false)
      await d.stop()
    }
  })

  test('switched off in the rules file: /bots does nothing', async () => {
    const { d, say } = await daemon({ moderation: { enabled: false } })
    say(LEO_MOD, '/bots stop')
    await settle()
    expect(d.service.paused(TEAM_QA.id)).toBeNull()
    await d.stop()
  })

  test('switching it off frees the chats it had paused', async () => {
    const { d, call, say } = await daemon()
    say(LEO_MOD, '/bots stop all')
    await settle()
    expect((await call('telegram_send_message', { to: 'qa', text: 'hi' })).isError).toBe(true)
    d.store.update(c => {
      c.moderation.enabled = false
    })
    expect(d.service.paused(TEAM_QA.id)).toBeNull()
    expect((await call('telegram_send_message', { to: 'qa', text: 'hi' })).isError).toBeFalsy()
    await d.stop()
  })

  test('"/bots stop all" pauses every chat but your own Saved Messages', async () => {
    const { d, call, say } = await daemon()
    say(LEO_MOD, '/bots stop all 2h')
    await settle()
    const p = d.service.paused(ANNA.id)
    expect(p?.scope).toBe('all')
    expect(p!.until - Date.now()).toBeGreaterThan(119 * MIN)
    expect((await call('telegram_send_message', { to: 'anna', text: 'hi' })).isError).toBe(true)
    expect((await call('telegram_send_message', { to: 'me', text: 'note to self' })).isError).toBeFalsy()
    await d.stop()
  })

  test('a stop is counted from when it was sent, and one that ran out before it arrived is ignored', async () => {
    const { d, say } = await daemon()
    say(LEO_MOD, '/bots stop', { date: new Date(Date.now() - 61 * MIN).toISOString() })
    await settle()
    expect(d.service.paused(TEAM_QA.id)).toBeNull()
    say(LEO_MOD, '/bots stop', { date: new Date(Date.now() - 50 * MIN).toISOString() })
    await settle()
    const left = d.service.paused(TEAM_QA.id)!.until - Date.now()
    expect(left).toBeGreaterThan(9 * MIN)
    expect(left).toBeLessThanOrEqual(10 * MIN)
    await d.stop()
  })

  test('a long stop is cut to maxMinutes', async () => {
    const { d, say } = await daemon({ moderation: { maxMinutes: 90 } })
    say(LEO_MOD, '/bots stop 24h')
    await settle()
    expect(d.service.paused(TEAM_QA.id)!.until - Date.now()).toBeLessThanOrEqual(90 * MIN)
    await d.stop()
  })

  test('a repeated stop extends it but the chat gets one ack a minute', async () => {
    const { tg, d, call, say } = await daemon()
    await call('telegram_watch', { chat: 'qa' })
    say(LEO_MOD, '/bots stop 10m')
    await settle()
    say(IDDHI_MOD, '/bots stop 2h')
    await settle()
    expect(d.service.paused(TEAM_QA.id)!.until - Date.now()).toBeGreaterThan(100 * MIN)
    expect(tg.sent.filter(s => s.chatId === TEAM_QA.id)).toHaveLength(1)
    await d.stop()
  })

  test('the ack follows the rules: none in a blocked or ask-every-time chat', async () => {
    for (const rules of [{ blocked: ['qa'] }, { requireApproval: ['qa'] }]) {
      const { tg, d, say } = await daemon({ rules })
      say(LEO_MOD, '/bots stop')
      await settle()
      expect(d.service.paused(TEAM_QA.id)).not.toBeNull()
      expect(tg.sent.filter(s => s.chatId === TEAM_QA.id)).toHaveLength(0)
      await d.stop()
    }
  })

  test('a draft waiting for approval is refused once the chat is paused', async () => {
    const { tg, d, call, say } = await daemon()
    const r = await call('telegram_send_message', { to: 'qa', text: 'roast, pending' })
    expect(r.approval).toBeDefined()
    say(LEO_MOD, '/bots stop')
    await settle()
    tg.sent.length = 0
    const decided = await d.service.decide(r.approval!.id, true, 'menubar', null)
    expect(decided.isError).toBe(true)
    expect(decided.text).toContain('paused')
    expect(tg.sent).toHaveLength(0)
    await d.stop()
  })

  test('edits and new watches are refused; deleting your own message still works', async () => {
    const { tg, d, call, say } = await daemon()
    await call('telegram_watch', { chat: 'qa' })
    const sent = await call('telegram_send_message', { to: 'qa', text: 'roast' })
    const id = Number(/message #(\d+)/.exec(sent.text)![1])
    say(LEO_MOD, '/bots stop')
    await settle()
    expect((await call('telegram_edit_message', { chat: 'qa', messageId: id, text: 'worse roast' })).isError).toBe(true)
    const w = await call('telegram_watch', { chat: 'qa' })
    expect(w.isError).toBe(true)
    expect(w.text).toContain('Not watching')
    expect((await call('telegram_delete_message', { chat: 'qa', messageId: id })).isError).toBeFalsy()
    expect(tg.deleted).toContainEqual({ chatId: TEAM_QA.id, messageId: id })
    await d.stop()
  })

  test('a forum topic is part of its chat: topic sends, topic messages and new topics are paused too', async () => {
    const { tg, d, frames, call, say } = await daemon({ rules: { autoReply: ['qa'], autoSend: ['anna', 'qa'] } })
    await call('telegram_watch', { chat: 'qa', topicId: 42 })
    say(LEO_MOD, '/bots stop')
    await settle()
    tg.sent.length = 0
    expect((await call('telegram_send_message', { to: 'qa', topicId: 42, text: 'roast in a topic' })).isError).toBe(true)
    const topic = await call('telegram_create_topic', { chat: 'qa', title: 'roast-arena' })
    expect(topic.isError).toBe(true)
    expect(topic.text).toContain('No topic created: a moderator')
    const before = frames.length
    say(ANNA, 'in the topic', { topicId: 42 })
    await settle()
    expect(frames.length).toBe(before)
    expect(tg.sent).toHaveLength(0)
    await d.stop()
  })

  test('off by default: with no moderation section, a moderator\'s /bots stop is just a message', async () => {
    const { createDaemon } = await import('../src/daemon/main')
    const { getPaths } = await import('../src/shared/paths')
    const paths = getPaths(mkdtempSync(join(tmpdir(), 'tgmcp-mod-')))
    writeFileSync(paths.config, JSON.stringify({ footer: '', chats: { qa: { id: TEAM_QA.id, name: TEAM_QA.name, type: 'group' } }, rules: { autoReply: ['qa'] } }))
    const tg = new FakeTelegram().add(TEAM_QA, LEO_MOD)
    const d = await createDaemon({ paths, port: 0, telegram: tg, log: () => {}, pageBotToken: null })
    tg.emit(TEAM_QA.id, '/bots stop all', LEO_MOD.id)
    await settle()
    expect(d.service.paused(TEAM_QA.id)).toBeNull()
    expect(tg.sent).toHaveLength(0)
    expect(d.service.moderationState().enabled).toBe(false)
    await d.stop()
  })

  test('a forwarded command or a captioned photo from a moderator pauses nothing, and reaches sessions as a message', async () => {
    const { tg, d, frames, call, say } = await daemon()
    await call('telegram_watch', { chat: 'qa' })
    say(LEO_MOD, '/bots stop all', { forwarded: true })
    say(LEO_MOD, '/bots stop', { media: 'photo' })
    await settle()
    expect(d.service.paused(TEAM_QA.id)).toBeNull()
    expect(frames.filter(f => f.includes('Telegram message from'))).toHaveLength(2)
    expect(tg.sent).toHaveLength(0)
    await d.stop()
  })

  test('the ack goes only where sending needs no approval', async () => {
    const cases: [object, boolean, boolean][] = [
      // rules, watched, acked
      [{ autoReply: ['qa'] }, true, true],
      [{ autoReply: ['qa'] }, false, false],
      [{ autoSend: ['qa'] }, false, true],
      [{}, false, false],
    ]
    for (const [rules, watched, acked] of cases) {
      const { tg, d, call, say } = await daemon({ rules })
      if (watched) await call('telegram_watch', { chat: 'qa' })
      say(LEO_MOD, '/bots stop')
      await settle()
      expect(d.service.paused(TEAM_QA.id)).not.toBeNull()
      expect(tg.sent.filter(x => x.chatId === TEAM_QA.id)).toHaveLength(acked ? 1 : 0)
      await d.stop()
    }
  })

  test("a resume in a chat a desk lists by @username is told only to the desk, like the pause", async () => {
    const PUB: PeerInfo = { id: -1009900001, type: 'group', name: 'Pub', username: 'pubgroup' }
    const { tg, d, frames } = await daemon({ rules: { autoReply: ['qa', '@pubgroup'], autoSend: ['anna'] }, desks: { desk: { chats: ['@pubgroup'] } } })
    tg.add(PUB)
    // s1 (the helper's session) has an old watch there, from before the desk: it hears nothing now.
    d.hub.addWatch('s1', { chatId: PUB.id, chatLabel: 'Pub' })
    const deskFrames: string[] = []
    d.hub.attachProxy('d_desk', { label: 'desk', channel: false, watches: [], desk: 'desk', startedAt: Date.now() }, { send() {} })
    d.hub.attachMonitor('d_desk', { send: (f: string) => deskFrames.push(f) })
    d.hub.addWatch('d_desk', { chatId: PUB.id, chatLabel: 'Pub' })
    tg.emit(PUB.id, '/bots stop 30m', LEO_MOD.id)
    await settle()
    expect(deskFrames.some(f => f.includes('Paused by a moderator'))).toBe(true)
    expect(frames.some(f => f.includes('Paused by a moderator'))).toBe(false)
    // The owner's resume (CLI or menu bar) carries only the chat id.
    d.service.resumeLocally(PUB.id)
    expect(deskFrames.some(f => f.includes('Moderator pause lifted'))).toBe(true)
    expect(frames.some(f => f.includes('Moderator pause lifted'))).toBe(false)
    await d.stop()
  })

  test('sessions are never told "lifted" for a chat that is still paused', async () => {
    const { frames, d, call, say } = await daemon()
    await call('telegram_watch', { chat: 'qa' })
    await call('telegram_watch', { chat: 'anna' })
    say(LEO_MOD, '/bots stop all 2h', { date: new Date(Date.now() - 2 * MIN).toISOString() })
    say(LEO_MOD, '/bots stop 30m')
    await settle()
    // The chat's own stop is lifted, but the stop for every chat still holds: the session hears that.
    const before = frames.length
    say(LEO_MOD, '/bots resume')
    await settle()
    const told = frames.slice(before)
    expect(told).toHaveLength(1)
    expect(told[0]).toContain('Paused by a moderator')
    expect(told[0]).toContain('every chat')
    expect(told[0]).not.toContain('Moderator pause lifted')
    expect(d.service.paused(TEAM_QA.id)?.scope).toBe('all')

    // The owner's per-chat resume says the same.
    const before2 = frames.length
    say(LEO_MOD, '/bots stop 30m')
    await settle()
    d.service.resumeLocally(TEAM_QA.id)
    expect(frames.slice(before2 + 1).every(f => !f.includes('Moderator pause lifted'))).toBe(true)
    expect(frames.length).toBeGreaterThan(before2 + 1)
    await d.stop()
  })

  test('after "/bots resume all", a chat stopped again since keeps its pause, and its sessions hear it', async () => {
    const { frames, d, call, say } = await daemon()
    await call('telegram_watch', { chat: 'qa' })
    say(LEO_MOD, '/bots stop all', { date: new Date(Date.now() - 3 * MIN).toISOString() })
    say(LEO_MOD, '/bots stop 30m', { date: new Date(Date.now() - 1 * MIN).toISOString() })
    await settle()
    const before = frames.length
    // Sent between the two stops, arriving late: it lifts the stop for every chat, not the newer one.
    say(IDDHI_MOD, '/bots resume all', { date: new Date(Date.now() - 2 * MIN).toISOString() })
    await settle()
    expect(d.service.paused(ANNA.id)).toBeNull()
    expect(d.service.paused(TEAM_QA.id)?.scope).toBe(TEAM_QA.id)
    const told = frames.slice(before)
    expect(told[0]).toContain('Moderator pause lifted for every chat')
    expect(told.at(-1)).toContain('Paused by a moderator')
    expect(told.at(-1)).toContain(`chat_id ${TEAM_QA.id}`)
    await d.stop()
  })

  test('channel-mode sessions get the notice, not the /bots text', async () => {
    const base: TgEvent = {
      seq: 1,
      watchIds: ['moderation'],
      chatId: TEAM_QA.id,
      chatLabel: 'Team QA',
      fromId: LEO_MOD.id,
      fromName: 'Leo',
      fromUsername: 'dfansoo',
      messageId: 7,
      topicId: null,
      replyToId: null,
      text: '/bots stop',
      media: null,
      date: new Date().toISOString(),
    }
    const paused = channelPayload({ ...base, moderation: { action: 'pause', all: false, until: '15:00', minutes: 60 } })
    expect(paused.meta.moderation).toBe('pause')
    expect(paused.content).toContain('Paused by a moderator')
    expect(paused.content).toContain('Stop replying there now')
    expect(paused.content).not.toBe('/bots stop')
    const resumed = channelPayload({ ...base, text: '/bots resume', moderation: { action: 'resume', all: true } })
    expect(resumed.meta.moderation).toBe('resume')
    expect(resumed.content).toContain('Moderator pause lifted for every chat')
  })

  test('a channel-mode session watching the chat gets the pause notice through the hub', async () => {
    const { d, say } = await daemon()
    const pushed: TgEvent[] = []
    d.hub.attachProxy('s2', { label: 'channel', channel: true, watches: [] }, { send: (raw: string) => {
      const m = JSON.parse(raw) as { t: string; event?: TgEvent }
      if (m.t === 'event' && m.event) pushed.push(m.event)
    } })
    await d.service.call('s2', 'telegram_watch', { chat: 'qa' })
    say(LEO_MOD, '/bots stop')
    await settle()
    expect(pushed).toHaveLength(1)
    expect(channelPayload(pushed[0]!).content).toContain('Paused by a moderator')
    await d.stop()
  })

  test('a /reply takeover there ends, and a new one is not started', async () => {
    const { tg, d, frames, call, say } = await daemon()
    await call('telegram_answer_reply', {})
    tg.emit(TEAM_QA.id, '/reply', tg.me.id, { outgoing: true, from: tg.me })
    await settle()
    expect(d.hub.takeoverOf(TEAM_QA.id)).toBe('s1')
    say(LEO_MOD, '/bots stop')
    await settle()
    expect(d.hub.takeoverOf(TEAM_QA.id)).toBeNull()
    expect(frames.at(-1)).toContain('Paused by a moderator')
    tg.emit(TEAM_QA.id, '/reply', tg.me.id, { outgoing: true, from: tg.me })
    await settle()
    expect(d.hub.takeoverOf(TEAM_QA.id)).toBeNull()
    expect(tg.sent.at(-1)!.chatId).toBe(tg.me.id)
    expect(tg.sent.at(-1)!.text).toContain('was not handed to Claude')
    await d.stop()
  })

  test('a session can never send or edit in a /bots command', async () => {
    const { tg, d, call } = await daemon()
    for (const text of ['/bots resume', '  /bots stop all', '**/bots** resume']) {
      const r = await call('telegram_send_message', { to: 'anna', text, parseMode: text.startsWith('**') ? 'markdown' : 'plain' })
      expect(r.isError).toBe(true)
      expect(r.text).toContain('moderator command')
    }
    expect(tg.sent).toHaveLength(0)
    await d.stop()
  })

  test('the owner can always lift it: their own "/bots resume", or tgmcp bots resume', async () => {
    const { tg, d, say } = await daemon()
    say(LEO_MOD, '/bots stop')
    await settle()
    tg.emit(TEAM_QA.id, '/bots resume', tg.me.id, { outgoing: true, from: tg.me })
    await settle()
    expect(d.service.paused(TEAM_QA.id)).toBeNull()

    say(LEO_MOD, '/bots stop all')
    await settle()
    expect(d.service.resumeLocally('all').text).toContain('every chat')
    expect(d.service.paused(ANNA.id)).toBeNull()
    expect(d.service.resumeLocally('all').text).toBe('Nothing was paused.')
    await d.stop()
  })

  test('your own /bots resume replayed late does not lift a newer stop', async () => {
    const { tg, d, say } = await daemon()
    say(LEO_MOD, '/bots stop')
    await settle()
    tg.emit(TEAM_QA.id, '/bots resume', tg.me.id, { outgoing: true, from: tg.me, date: new Date(Date.now() - 5 * MIN).toISOString() })
    await settle()
    expect(d.service.paused(TEAM_QA.id)).not.toBeNull()
    await d.stop()
  })

  test('resuming one chat says so when a stop for every chat still holds', async () => {
    const { d, say } = await daemon()
    say(LEO_MOD, '/bots stop all')
    await settle()
    const r = d.service.resumeLocally(TEAM_QA.id)
    expect(r.text).toContain('a stop for every chat holds until')
    expect(d.service.paused(TEAM_QA.id)).not.toBeNull()
    expect(d.service.resumeLocally(ANNA.id + 1).text).toContain('a stop for every chat')
    d.service.resumeLocally('all')
    expect(d.service.resumeLocally(TEAM_QA.id).text).toBe(`Nothing was paused in chat ${TEAM_QA.id}.`)
    await d.stop()
  })

  test('a daemon restart does not lift it', async () => {
    const home = mkdtempSync(join(tmpdir(), 'tgmcp-mod-'))
    const first = await daemon({}, { home })
    first.say(LEO_MOD, '/bots stop')
    await settle()
    await first.d.stop()
    const second = await daemon({}, { home })
    expect(second.d.service.paused(TEAM_QA.id)).not.toBeNull()
    expect((await second.call('telegram_send_message', { to: 'qa', text: 'hi' })).isError).toBe(true)
    await second.d.stop()
  })

  test('no away reply goes to a paused chat', async () => {
    const hhmm = (offsetMs: number) => {
      const t = new Date(Date.now() + offsetMs)
      return `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`
    }
    const { tg, d } = await daemon({ away: { enabled: true, from: hhmm(-3_600_000), until: hhmm(3_600_000) } })
    tg.emit(LEO_MOD.id, '/bots stop all')
    await settle()
    tg.sent.length = 0
    tg.emit(ANNA.id, 'are you there?')
    await settle()
    expect(tg.sent).toHaveLength(0)
    await d.stop()
  })

  test('tgmcp bots: /status shows the pauses and POST /ui/bots/resume lifts them (with the token only)', async () => {
    const { d, say } = await daemon()
    say(LEO_MOD, '/bots stop')
    await settle()
    const base = `http://127.0.0.1:${d.port}`
    const auth = { authorization: `Bearer ${d.uiToken}`, 'content-type': 'application/json' }
    const st = (await (await fetch(`${base}/status`, { headers: { authorization: `Bearer ${d.token}` } })).json()) as { moderation: { pauses: { chatId: number }[] } }
    expect(st.moderation.pauses.map(p => p.chatId)).toEqual([TEAM_QA.id])
    expect((await fetch(`${base}/ui/bots/resume`, { method: 'POST', body: '{}' })).status).toBe(401)
    expect((await fetch(`${base}/ui/bots/resume`, { method: 'POST', headers: auth, body: '{"chatId":"x"}' })).status).toBe(400)
    const r = (await (await fetch(`${base}/ui/bots/resume`, { method: 'POST', headers: auth, body: JSON.stringify({ chatId: TEAM_QA.id }) })).json()) as { ok: boolean; text: string }
    expect(r).toMatchObject({ ok: true })
    expect(r.text).toContain('Lifted')
    expect(d.service.paused(TEAM_QA.id)).toBeNull()
    await d.stop()
  })

  test('status and the rules show it', async () => {
    const { d, call, say } = await daemon()
    say(LEO_MOD, '/bots stop')
    await settle()
    const status = (await call('telegram_status', {})).text
    expect(status).toContain('Moderator commands: on')
    expect(status).toContain('paused: ')
    expect((await call('telegram_get_rules', {})).text).toContain('1188107983, 1269534379')
    expect(d.service.moderationState().pauses).toHaveLength(1)
    await d.stop()
  })
})
