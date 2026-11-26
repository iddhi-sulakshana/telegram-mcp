import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DeskStore } from '../src/daemon/desk-store'
import { SessionHub } from '../src/daemon/sessions'
import type { IncomingMessage, TgEvent } from '../src/shared/protocol'

const describeMsg = (m: IncomingMessage): Omit<TgEvent, 'seq' | 'watchIds'> => ({
  chatId: m.chatId,
  chatLabel: m.chat.name,
  fromId: m.from?.id ?? null,
  fromName: m.from?.name ?? '?',
  fromUsername: null,
  messageId: m.id,
  topicId: m.topicId,
  replyToId: null,
  text: m.text,
  media: null,
  date: m.date,
})

let nextId = 1
function msg(chatId: number, fromId: number, text: string, extra: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    id: nextId++,
    chatId,
    chat: { id: chatId, type: 'group', name: `chat ${chatId}`, username: null },
    from: { id: fromId, type: 'user', name: `user ${fromId}`, username: null },
    date: '2026-11-01T00:00:00Z',
    outgoing: false,
    text,
    media: null,
    replyToId: null,
    topicId: null,
    ...extra,
  }
}

const sink = () => {
  const got: string[] = []
  return { got, send: (d: string) => got.push(d) }
}

describe('SessionHub', () => {
  test('queues until something listens, then flushes to a Monitor', () => {
    const hub = new SessionHub()
    const proxy = sink()
    hub.attachProxy('s1', { label: 'a', channel: false, watches: [] }, proxy)
    hub.addWatch('s1', { chatId: -5, chatLabel: 'g' })
    hub.dispatch(msg(-5, 7, 'first'), describeMsg)
    expect(hub.pending('s1')).toBe(1)

    const monitor = sink()
    hub.attachMonitor('s1', monitor)
    expect(hub.pending('s1')).toBe(0)
    expect(monitor.got[0]).toContain('first')
    hub.dispatch(msg(-5, 7, 'second'), describeMsg)
    expect(monitor.got[1]).toContain('second')
  })

  test('channel mode pushes to the proxy', () => {
    const hub = new SessionHub()
    const proxy = sink()
    hub.attachProxy('s1', { label: 'a', channel: true, watches: [] }, proxy)
    hub.addWatch('s1', { chatId: -5, chatLabel: 'g' })
    hub.dispatch(msg(-5, 7, 'hello'), describeMsg)
    const events = proxy.got.map(g => JSON.parse(g)).filter(m => m.t === 'event')
    expect(events).toHaveLength(1)
    expect(events[0].event.text).toBe('hello')
  })

  test('filters by sender and topic, ignores outgoing', () => {
    const hub = new SessionHub()
    hub.attachProxy('s1', { label: 'a', channel: false, watches: [] }, sink())
    hub.addWatch('s1', { chatId: -5, chatLabel: 'g', fromId: 7, topicId: 3 })
    expect(hub.dispatch(msg(-5, 8, 'other sender', { topicId: 3 }), describeMsg)).toBe(0)
    expect(hub.dispatch(msg(-5, 7, 'other topic', { topicId: 4 }), describeMsg)).toBe(0)
    expect(hub.dispatch(msg(-5, 7, 'mine', { topicId: 3, outgoing: true }), describeMsg)).toBe(0)
    expect(hub.dispatch(msg(-5, 7, 'yes', { topicId: 3 }), describeMsg)).toBe(1)
  })

  test('a restarted daemon restores watches from the proxy hello', () => {
    const first = new SessionHub()
    const proxy = sink()
    first.attachProxy('s1', { label: 'a', channel: false, watches: [] }, proxy)
    first.addWatch('s1', { chatId: -5, chatLabel: 'g' })
    const synced = proxy.got.map(g => JSON.parse(g)).filter(m => m.t === 'watches').at(-1).watches

    const second = new SessionHub()
    second.attachProxy('s1', { label: 'a', channel: false, watches: synced }, sink())
    expect(second.isWatching('s1', -5)).toBe(true)
  })

  test('sessions expire after the grace period without a proxy', () => {
    let now = 0
    const hub = new SessionHub({ graceMs: 1000, now: () => now })
    const proxy = sink()
    hub.attachProxy('s1', { label: 'a', channel: false, watches: [] }, proxy)
    hub.detachProxy('s1', proxy)
    now = 500
    expect(hub.sweep()).toEqual([])
    now = 1500
    expect(hub.sweep()).toEqual(['s1'])
    expect(hub.has('s1')).toBe(false)
  })

  test('a Monitor that drops the frame (closed socket) loses nothing: the message waits for the next one', () => {
    const hub = new SessionHub()
    hub.attachProxy('s1', { label: 'a', channel: false, watches: [] }, sink())
    hub.addWatch('s1', { chatId: -5, chatLabel: 'g' })
    // Bun's ServerWebSocket.send returns 0 when the message was dropped.
    const dead = { got: [] as string[], send: (_d: string) => 0 }
    hub.attachMonitor('s1', dead)
    hub.dispatch(msg(-5, 7, 'not lost'), describeMsg)
    expect(hub.pending('s1')).toBe(1)
    // A dead Monitor no longer counts as listening.
    expect(hub.monitorCount('s1')).toBe(0)
    const live = sink()
    hub.attachMonitor('s1', live)
    expect(hub.pending('s1')).toBe(0)
    expect(live.got[0]).toContain('not lost')
  })

  test('a channel proxy that drops the frame loses nothing: it is sent again on the next hello', () => {
    const hub = new SessionHub()
    hub.attachProxy('s1', { label: 'a', channel: true, watches: [] }, { send: () => 0 })
    hub.addWatch('s1', { chatId: -5, chatLabel: 'g' })
    hub.dispatch(msg(-5, 7, 'kept'), describeMsg)
    expect(hub.pending('s1')).toBe(1)
    const again = sink()
    hub.attachProxy('s1', { label: 'a', channel: true, watches: [] }, again)
    const events = again.got.map(g => JSON.parse(g)).filter(m => m.t === 'event')
    expect(events.map(e => e.event.text)).toEqual(['kept'])
    expect(hub.pending('s1')).toBe(0)
  })

  test('backpressure (-1) counts as sent: Bun queued the frame', () => {
    const hub = new SessionHub()
    hub.attachProxy('s1', { label: 'a', channel: false, watches: [] }, sink())
    hub.addWatch('s1', { chatId: -5, chatLabel: 'g' })
    hub.attachMonitor('s1', { send: () => -1 })
    hub.dispatch(msg(-5, 7, 'queued by Bun'), describeMsg)
    expect(hub.pending('s1')).toBe(0)
  })

  test('queue is bounded', () => {
    const hub = new SessionHub({ maxQueue: 2 })
    hub.attachProxy('s1', { label: 'a', channel: false, watches: [] }, sink())
    hub.addWatch('s1', { chatId: -5, chatLabel: 'g' })
    for (const t of ['a', 'b', 'c']) hub.dispatch(msg(-5, 7, t), describeMsg)
    const { events, dropped } = hub.drain('s1')
    expect(events.map(e => e.text)).toEqual(['b', 'c'])
    expect(dropped).toBe(1)
  })

  describe('desks', () => {
    // Chat -5 belongs to the "desk" desk; chat -6 to none.
    const deskFor = (chat: { id: number }) => (chat.id === -5 ? 'desk' : null)
    const base = { chatId: -5, chatLabel: 'g', fromId: 1, fromName: 'me', fromUsername: null, messageId: 1, topicId: null, replyToId: null, text: '', media: null, date: '' }

    test('a desk chat reaches only the desk session, even when others watch it', () => {
      const hub = new SessionHub({ deskFor })
      const other = sink()
      const desk = sink()
      hub.attachProxy('s1', { label: 'a', channel: false, watches: [] }, other)
      hub.attachProxy('d_desk', { label: 'b', channel: false, watches: [], desk: 'desk' }, desk)
      hub.addWatch('s1', { chatId: -5, chatLabel: 'g' })
      hub.addWatch('d_desk', { chatId: -5, chatLabel: 'g' })
      expect(hub.dispatch(msg(-5, 7, 'for the desk'), describeMsg)).toBe(1)
      expect(hub.pending('s1')).toBe(0)
      expect(hub.pending('d_desk')).toBe(1)
    })

    test('chats outside every desk still reach every watcher', () => {
      const hub = new SessionHub({ deskFor })
      hub.attachProxy('s1', { label: 'a', channel: false, watches: [] }, sink())
      hub.attachProxy('d_desk', { label: 'b', channel: false, watches: [], desk: 'desk' }, sink())
      hub.addWatch('s1', { chatId: -6, chatLabel: 'h' })
      hub.addWatch('d_desk', { chatId: -6, chatLabel: 'h' })
      expect(hub.dispatch(msg(-6, 7, 'everyone'), describeMsg)).toBe(2)
    })

    test('the latest proxy to speak for a desk gets its events; the older one is no longer current', () => {
      const hub = new SessionHub({ deskFor })
      const first = sink()
      const second = sink()
      hub.attachProxy('d_desk', { label: 'one', channel: true, watches: [], desk: 'desk' }, first)
      hub.addWatch('d_desk', { chatId: -5, chatLabel: 'g' })
      hub.attachProxy('d_desk', { label: 'two', channel: true, watches: [], desk: 'desk' }, second)
      expect(hub.isCurrentProxy('d_desk', first)).toBe(false)
      expect(hub.isCurrentProxy('d_desk', second)).toBe(true)
      // The new proxy keeps the desk's watches.
      expect(hub.isWatching('d_desk', -5)).toBe(true)
      hub.dispatch(msg(-5, 7, 'latest'), describeMsg)
      const events = (s: { got: string[] }) => s.got.map(g => JSON.parse(g)).filter(m => m.t === 'event')
      expect(events(first)).toHaveLength(0)
      expect(events(second)).toHaveLength(1)
      // The older proxy closing doesn't take the desk offline.
      hub.detachProxy('d_desk', first)
      expect(hub.snapshot().find(s => s.id === 'd_desk')?.connected).toBe(true)
    })

    test("the newest-started proxy holds the desk; it closes the older one's Monitors, and an older one can't take it back", () => {
      const hub = new SessionHub({ deskFor })
      const closed: string[] = []
      const monitor = (name: string) => ({ got: [] as string[], send(d: string) { this.got.push(d) }, close: () => closed.push(name) })
      const older = sink()
      hub.attachProxy('d_desk', { label: 'old', channel: false, watches: [], desk: 'desk', startedAt: 100 }, older)
      hub.addWatch('d_desk', { chatId: -5, chatLabel: 'g' })
      const oldMonitor = monitor('old')
      hub.attachMonitor('d_desk', oldMonitor)
      const oldEpoch = hub.eventsEpoch('d_desk')

      const newer = sink()
      expect(hub.attachProxy('d_desk', { label: 'new', channel: false, watches: [], desk: 'desk', startedAt: 200 }, newer)).toBe(true)
      expect(closed).toEqual(['old'])
      expect(hub.monitorCount('d_desk')).toBe(0)
      // The Monitor URL changes with the holder, so the old session's copy no longer opens the stream.
      expect(hub.eventsEpoch('d_desk')).not.toBe(oldEpoch)

      // The older proxy reconnects (say, after a daemon blip): it does not get the desk back.
      expect(hub.attachProxy('d_desk', { label: 'old', channel: false, watches: [], desk: 'desk', startedAt: 100 }, older)).toBe(false)
      expect(hub.isCurrentProxy('d_desk', older)).toBe(false)
      expect(hub.isCurrentProxy('d_desk', newer)).toBe(true)
      const newMonitor = monitor('new')
      hub.attachMonitor('d_desk', newMonitor)
      hub.dispatch(msg(-5, 7, 'to the newer one'), describeMsg)
      expect(newMonitor.got).toHaveLength(1)
      expect(oldMonitor.got).toHaveLength(0)

      // Once the newer one is gone, an older one may hold the desk again.
      hub.detachProxy('d_desk', newer)
      expect(hub.attachProxy('d_desk', { label: 'old', channel: false, watches: [], desk: 'desk', startedAt: 100 }, older)).toBe(true)
      expect(closed).toEqual(['old', 'new'])
    })

    test('an ordinary session is always its own current proxy', () => {
      const hub = new SessionHub({ deskFor })
      const p = sink()
      hub.attachProxy('s1', { label: 'a', channel: false, watches: [] }, p)
      expect(hub.isCurrentProxy('s1', p)).toBe(true)
    })

    test('only the desk session makes a desk chat live', () => {
      const hub = new SessionHub({ deskFor })
      hub.attachProxy('s1', { label: 'a', channel: false, watches: [] }, sink())
      hub.addWatch('s1', { chatId: -5, chatLabel: 'g' })
      hub.attachMonitor('s1', sink())
      expect(hub.handledLive(-5)).toBe(false)
      hub.attachProxy('d_desk', { label: 'b', channel: false, watches: [], desk: 'desk' }, sink())
      hub.addWatch('d_desk', { chatId: -5, chatLabel: 'g' })
      hub.attachMonitor('d_desk', sink())
      expect(hub.handledLive(-5)).toBe(true)
    })

    test('/reply in a desk chat goes to the desk session, never to another handler', () => {
      const hub = new SessionHub({ deskFor })
      hub.attachProxy('s1', { label: 'a', channel: false, watches: [] }, sink())
      hub.attachMonitor('s1', sink())
      hub.setReplyHandler('s1', true)
      // No desk session listening: nobody takes it.
      expect(hub.startTakeover(-5, 60_000, base)).toBeNull()
      hub.attachProxy('d_desk', { label: 'b', channel: false, watches: [], desk: 'desk' }, sink())
      hub.attachMonitor('d_desk', sink())
      expect(hub.startTakeover(-5, 60_000, base)).toBe('d_desk')
      // Other chats still go to the /reply handler.
      expect(hub.startTakeover(-6, 60_000, { ...base, chatId: -6 })).toBe('s1')
    })

    describe('on disk', () => {
      const path = () => join(mkdtempSync(join(tmpdir(), 'tgmcp-desks-')), 'desks.json')

      test("a restarted daemon knows the desk's watches before its proxy is back, and queues for it", () => {
        const file = path()
        const first = new SessionHub({ deskFor, desks: new DeskStore(file) })
        first.attachProxy('d_desk', { label: 'b', channel: false, watches: [], desk: 'desk' }, sink())
        first.addWatch('d_desk', { chatId: -5, chatLabel: 'g' })
        first.dispatch(msg(-5, 7, 'before the restart'), describeMsg)

        const second = new SessionHub({ deskFor, desks: new DeskStore(file) })
        expect(second.isWatching('d_desk', -5)).toBe(true)
        expect(second.deskOf('d_desk')).toBe('desk')
        expect(second.dispatch(msg(-5, 7, 'during the restart'), describeMsg)).toBe(1)

        const third = new SessionHub({ deskFor, desks: new DeskStore(file) })
        const monitor = sink()
        third.attachProxy('d_desk', { label: 'b2', channel: false, watches: [], desk: 'desk' }, sink())
        third.attachMonitor('d_desk', monitor)
        expect(monitor.got.map(f => f.split('\n').at(-1))).toEqual(['> before the restart', '> during the restart'])
        expect(third.pending('d_desk')).toBe(0)
        // Delivered is gone from disk too.
        expect(new SessionHub({ deskFor, desks: new DeskStore(file) }).pending('d_desk')).toBe(0)
      })

      test('a message the desk already got is not delivered twice (a catch-up replay)', () => {
        const file = path()
        const first = new SessionHub({ deskFor, desks: new DeskStore(file) })
        first.attachProxy('d_desk', { label: 'b', channel: false, watches: [], desk: 'desk' }, sink())
        first.addWatch('d_desk', { chatId: -5, chatLabel: 'g' })
        const m = msg(-5, 7, 'once')
        expect(first.dispatch(m, describeMsg)).toBe(1)
        expect(first.dispatch(m, describeMsg)).toBe(0)
        const second = new SessionHub({ deskFor, desks: new DeskStore(file) })
        expect(second.dispatch(m, describeMsg)).toBe(0)
        expect(second.lastSeen('d_desk', -5)).toBe(m.id)
        expect(second.pending('d_desk')).toBe(1)
      })

      test('after a restart, a catch-up hands over the gap even when a newer message arrived live first', () => {
        const file = path()
        const first = new SessionHub({ deskFor, desks: new DeskStore(file) })
        first.attachProxy('d_desk', { label: 'b', channel: false, watches: [], desk: 'desk' }, sink())
        first.addWatch('d_desk', { chatId: -5, chatLabel: 'g' })
        first.dispatch(msg(-5, 7, 'seen', { id: 100 }), describeMsg)

        const hub = new SessionHub({ deskFor, desks: new DeskStore(file) })
        // The catch-up starts where desks.json was at start, not at the newest message since.
        expect(hub.catchUpFrom('d_desk', -5)).toBe(100)
        hub.dispatch(msg(-5, 7, 'live', { id: 105 }), describeMsg)
        expect(hub.catchUpFrom('d_desk', -5)).toBe(100)
        // The history then has 101..105: the missed ones go over, the live one isn't repeated.
        for (const id of [101, 102, 105]) hub.dispatch(msg(-5, 7, `history ${id}`, { id }), describeMsg)
        expect(hub.dispatch(msg(-5, 7, 'old', { id: 99 }), describeMsg)).toBe(0)
        expect(hub.drain('d_desk').events.map(e => e.text)).toEqual(['seen', 'live', 'history 101', 'history 102'])
        expect(hub.lastSeen('d_desk', -5)).toBe(105)
      })

      test("a desk chat's message no session heard (paused, off autoReply, not watched) is never handed over later", () => {
        const file = path()
        const hub = new SessionHub({ deskFor, desks: new DeskStore(file) })
        hub.attachProxy('d_desk', { label: 'b', channel: false, watches: [], desk: 'desk' }, sink())
        // Not watched: dispatch hands nothing, but the desk has seen it.
        expect(hub.dispatch(msg(-5, 7, 'unwatched', { id: 200 }), describeMsg)).toBe(0)
        // Paused or off autoReply: the daemon never dispatches it, only notes it.
        hub.observe(msg(-5, 7, 'paused', { id: 201 }))
        hub.addWatch('d_desk', { chatId: -5, chatLabel: 'g' })
        expect(hub.dispatch(msg(-5, 7, 'unwatched', { id: 200 }), describeMsg)).toBe(0)
        expect(hub.dispatch(msg(-5, 7, 'paused', { id: 201 }), describeMsg)).toBe(0)
        // After a restart neither is above the catch-up's starting point.
        expect(new SessionHub({ deskFor, desks: new DeskStore(file) }).catchUpFrom('d_desk', -5)).toBe(201)
        // Chats on no desk are not noted.
        hub.observe(msg(-6, 7, 'elsewhere', { id: 300 }))
        expect(hub.lastSeen('d_desk', -6)).toBeNull()
      })

      test('a desk taken out of config.json is not restored, and is forgotten once its proxy is gone', () => {
        const file = path()
        let configured = ['desk', 'old']
        const deskConfigured = (name: string) => configured.includes(name)
        const first = new SessionHub({ deskFor, desks: new DeskStore(file), deskConfigured })
        for (const desk of ['desk', 'old']) {
          first.attachProxy(`d_${desk}`, { label: desk, channel: false, watches: [], desk }, sink())
          first.addWatch(`d_${desk}`, { chatId: -5, chatLabel: 'g' })
        }
        configured = ['desk']
        const second = new SessionHub({ deskFor, desks: new DeskStore(file), deskConfigured })
        expect(second.has('d_desk')).toBe(true)
        expect(second.has('d_old')).toBe(false)

        let now = 0
        const third = new SessionHub({ deskFor, desks: new DeskStore(file), deskConfigured: () => true, graceMs: 1000, now: () => now })
        const p = sink()
        third.attachProxy('d_gone', { label: 'g', channel: false, watches: [], desk: 'gone' }, p)
        third.detachProxy('d_gone', p)
        now = 10_000
        // Still configured: kept. Taken out: swept like an ordinary session, and gone from desks.json.
        expect(third.sweep()).toEqual([])
        const fourth = new SessionHub({ deskFor, desks: new DeskStore(file), deskConfigured: name => name !== 'gone', graceMs: 1000, now: () => now })
        const p2 = sink()
        fourth.attachProxy('d_gone', { label: 'g', channel: false, watches: [], desk: 'gone' }, p2)
        fourth.detachProxy('d_gone', p2)
        now = 20_000
        expect(fourth.sweep()).toEqual(['d_gone'])
        expect(new SessionHub({ deskFor, desks: new DeskStore(file) }).has('d_gone')).toBe(false)
      })

      test('takeover and moderation notices are not kept across a restart (they belong to the run that sent them)', () => {
        const file = path()
        const hub = new SessionHub({ deskFor, desks: new DeskStore(file) })
        hub.attachProxy('d_desk', { label: 'b', channel: false, watches: [], desk: 'desk' }, sink())
        hub.addWatch('d_desk', { chatId: -5, chatLabel: 'g' })
        hub.dispatch(msg(-5, 7, 'kept'), describeMsg)
        hub.moderate(-5, { ...base, moderation: { action: 'pause', all: false, until: 'later', minutes: 30 } }, false)
        expect(hub.pending('d_desk')).toBe(2)
        expect(new SessionHub({ deskFor, desks: new DeskStore(file) }).drain('d_desk').events.map(e => e.text)).toEqual(['kept'])
      })

      test('a save that failed is tried again; with a delay, saves are batched and flush() writes at once', () => {
        const saved: number[] = []
        let fail = true
        const store = Object.assign(new DeskStore(path()), {
          save: (desks: Map<string, { queue: unknown[] }>) => {
            if (fail) return false
            saved.push(desks.get('desk')!.queue.length)
            return true
          },
        }) as unknown as DeskStore
        const hub = new SessionHub({ deskFor, desks: store, saveDelayMs: 60_000 })
        hub.attachProxy('d_desk', { label: 'b', channel: false, watches: [], desk: 'desk' }, sink())
        hub.addWatch('d_desk', { chatId: -5, chatLabel: 'g' })
        for (const t of ['a', 'b', 'c']) hub.dispatch(msg(-5, 7, t), describeMsg)
        // Batched: nothing written yet.
        expect(saved).toEqual([])
        hub.flush()
        expect(saved).toEqual([])
        fail = false
        hub.flush()
        expect(saved).toEqual([3])
        // Nothing changed since: no write.
        hub.flush()
        expect(saved).toEqual([3])
      })

      test('ordinary sessions are not written to disk', () => {
        const file = path()
        const hub = new SessionHub({ deskFor, desks: new DeskStore(file) })
        hub.attachProxy('s1', { label: 'a', channel: false, watches: [] }, sink())
        hub.addWatch('s1', { chatId: -6, chatLabel: 'h' })
        expect(new SessionHub({ deskFor, desks: new DeskStore(file) }).has('s1')).toBe(false)
      })

      test('a broken desks.json is set aside and the daemon starts with no desk state', () => {
        const file = path()
        writeFileSync(file, '{ not json')
        const logs: string[] = []
        const hub = new SessionHub({ deskFor, desks: new DeskStore(file, m => logs.push(m)) })
        expect(hub.has('d_desk')).toBe(false)
        expect(logs.some(l => l.includes('desks.json'))).toBe(true)
        expect(existsSync(`${file}.bad`)).toBe(true)
      })

      test("a desk's queue on disk is bounded too", () => {
        const file = path()
        const hub = new SessionHub({ deskFor, desks: new DeskStore(file), deskMaxQueue: 2 })
        hub.attachProxy('d_desk', { label: 'b', channel: false, watches: [], desk: 'desk' }, sink())
        hub.addWatch('d_desk', { chatId: -5, chatLabel: 'g' })
        for (const t of ['a', 'b', 'c']) hub.dispatch(msg(-5, 7, t), describeMsg)
        const { events, dropped } = new SessionHub({ deskFor, desks: new DeskStore(file) }).drain('d_desk')
        expect(events.map(e => e.text)).toEqual(['b', 'c'])
        expect(dropped).toBe(1)
      })
    })

    test('a desk chat listed by @username: /reply and handledLive find the desk too', () => {
      const byName = (chat: { id: number; username?: string | null }) => (chat.username === 'anna_k' ? 'desk' : null)
      const hub = new SessionHub({ deskFor: byName })
      const anna = { id: 77, username: 'anna_k' }
      hub.attachProxy('s1', { label: 'a', channel: false, watches: [] }, sink())
      hub.addWatch('s1', { chatId: 77, chatLabel: 'Anna' })
      hub.attachMonitor('s1', sink())
      hub.setReplyHandler('s1', true)
      expect(hub.handledLive(anna)).toBe(false)
      expect(hub.startTakeover(anna, 60_000, { ...base, chatId: 77 })).toBeNull()
      hub.attachProxy('d_desk', { label: 'b', channel: false, watches: [], desk: 'desk' }, sink())
      hub.addWatch('d_desk', { chatId: 77, chatLabel: 'Anna' })
      hub.attachMonitor('d_desk', sink())
      expect(hub.handledLive(anna)).toBe(true)
      expect(hub.startTakeover(anna, 60_000, { ...base, chatId: 77 })).toBe('d_desk')
    })

    test('a desk session is never swept', () => {
      let now = 0
      const hub = new SessionHub({ graceMs: 1000, now: () => now, deskFor })
      const p = sink()
      hub.attachProxy('d_desk', { label: 'b', channel: false, watches: [], desk: 'desk' }, p)
      hub.addWatch('d_desk', { chatId: -5, chatLabel: 'g' })
      hub.detachProxy('d_desk', p)
      now = 10_000
      expect(hub.sweep()).toEqual([])
      expect(hub.isWatching('d_desk', -5)).toBe(true)
      expect(hub.deskOf('d_desk')).toBe('desk')
    })
  })

  describe('handledLive', () => {
    const ANNA_ID = 4242
    const watch = { chatId: ANNA_ID, chatLabel: 'Anna' }

    test('a watch with a Monitor is live', () => {
      const hub = new SessionHub()
      hub.attachProxy('s1', { label: 'a', channel: false, watches: [] }, sink())
      hub.addWatch('s1', watch)
      hub.attachMonitor('s1', sink())
      expect(hub.handledLive(ANNA_ID)).toBe(true)
    })

    test('a watch without a Monitor is not live', () => {
      const hub = new SessionHub()
      hub.attachProxy('s1', { label: 'a', channel: false, watches: [] }, sink())
      hub.addWatch('s1', watch)
      expect(hub.handledLive(ANNA_ID)).toBe(false)
    })

    test('a channel session with its proxy is live', () => {
      const hub = new SessionHub()
      const proxy = sink()
      hub.attachProxy('s1', { label: 'a', channel: true, watches: [] }, proxy)
      hub.addWatch('s1', watch)
      expect(hub.handledLive(ANNA_ID)).toBe(true)
      hub.detachProxy('s1', proxy)
      expect(hub.handledLive(ANNA_ID)).toBe(false)
    })

    test('a takeover is live', () => {
      const hub = new SessionHub()
      hub.attachProxy('s1', { label: 'a', channel: false, watches: [] }, sink())
      hub.attachMonitor('s1', sink())
      hub.setReplyHandler('s1', true)
      const base = { chatId: ANNA_ID, chatLabel: 'Anna', fromId: 1, fromName: 'me', fromUsername: null, messageId: 1, topicId: null, replyToId: null, text: '', media: null, date: '' }
      expect(hub.startTakeover(ANNA_ID, 60_000, base)).toBe('s1')
      expect(hub.handledLive(ANNA_ID)).toBe(true)
    })
  })
})
