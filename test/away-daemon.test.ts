import { describe, expect, setSystemTime, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ANNA, FakeTelegram, LEO } from './fake-telegram'

const hhmm = (offsetMs: number) => {
  const d = new Date(Date.now() + offsetMs)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
const HOUR = 3_600_000
const settle = () => new Promise(r => setTimeout(r, 30))

async function daemonAway(
  away: object = { enabled: true, from: hhmm(-HOUR), until: hhmm(HOUR) },
  extra: object = {},
  tg = new FakeTelegram().add(LEO, ANNA),
) {
  const { createDaemon } = await import('../src/daemon/main')
  const { getPaths } = await import('../src/shared/paths')
  const paths = getPaths(mkdtempSync(join(tmpdir(), 'tgmcp-away-')))
  writeFileSync(paths.config, JSON.stringify({ footer: '', paging: { pageFrom: [ANNA.id] }, away, ...extra }))
  const daemon = await createDaemon({ paths, port: 0, telegram: tg, log: () => {}, pageBotToken: null })
  return { tg, daemon, paths }
}

describe('the away reply in the daemon', () => {
  test('a stranger gets the away reply and it shows in recent', async () => {
    const { tg, daemon } = await daemonAway()
    tg.emit(LEO.id, 'hi')
    await settle()
    expect(tg.sent).toHaveLength(1)
    expect(tg.sent[0]!.text).toContain('off the grid for the night')
    expect(daemon.service.uiState().recent[0]!.via).toBe('away')
    expect(daemon.service.uiState().away).toMatchObject({ enabled: true, active: true })
    // Our own reply is not "you speaking": a second message the same night gets nothing more (R6),
    // and another stranger still gets theirs.
    tg.emit(LEO.id, 'hello?')
    tg.emit(ANNA.id, 'hey')
    await settle()
    expect(tg.sent.map(s => s.chatId)).toEqual([LEO.id, ANNA.id])
    await daemon.stop()
  })

  test('a /page gets the page reply, not the away reply', async () => {
    const { tg, daemon } = await daemonAway()
    tg.emit(ANNA.id, '/page x')
    await settle()
    expect(tg.sent.map(s => s.text)).toEqual(["Paging Me now. I'll tell you when they've seen it."])
    await daemon.stop()
  })

  test('typing on your phone silences it', async () => {
    const { tg, daemon } = await daemonAway()
    tg.emit(LEO.id, 'yo', LEO.id, { outgoing: true })
    await settle()
    tg.emit(LEO.id, 'hi')
    await settle()
    expect(tg.sent).toHaveLength(0)
    await daemon.stop()
  })

  test('an old outgoing message replayed on catch-up counts at its own time', async () => {
    const { tg, daemon } = await daemonAway()
    tg.emit(LEO.id, 'yo', LEO.id, { outgoing: true, date: new Date(Date.now() - 2 * HOUR).toISOString() })
    // No usable date: counts as now.
    tg.emit(ANNA.id, 'yo', ANNA.id, { outgoing: true, date: 'not a date' })
    await settle()
    tg.emit(LEO.id, 'hi')
    tg.emit(ANNA.id, 'hi')
    await settle()
    expect(tg.sent.map(s => s.chatId)).toEqual([LEO.id])
    await daemon.stop()
  })

  test('a failing away send leaves watch dispatch and paging working', async () => {
    const tg = new FakeTelegram().add(LEO, ANNA)
    const real = tg.sendText.bind(tg)
    tg.sendText = async (...a: Parameters<typeof real>) => {
      if (a[1].includes('off the grid for the night')) throw new Error('FLOOD_WAIT')
      return real(...a)
    }
    const { daemon } = await daemonAway(undefined, { rules: { autoReply: [ANNA.id] } }, tg)
    // A stale watch (no Monitor): it doesn't silence the away reply (R8), but still gets the message.
    daemon.hub.attachProxy('s1', { label: 'a', channel: false, watches: [] }, { send: () => {} })
    daemon.hub.addWatch('s1', { chatId: ANNA.id, chatLabel: 'Anna' })
    tg.emit(ANNA.id, 'hi')
    await settle()
    expect(tg.sent).toEqual([])
    expect(daemon.hub.pending('s1')).toBe(1)
    // The same chat pages straight after, and gets the page reply.
    tg.emit(ANNA.id, '/page x')
    await settle()
    expect(tg.sent.map(s => s.text)).toEqual(["Paging Me now. I'll tell you when they've seen it."])
    expect(daemon.hub.pending('s1')).toBe(2)
    await daemon.stop()
  })
  describe('a schedule that waits for you', () => {
    const waitingAway = { enabled: true, schedules: [{ id: 'day', name: 'Daytime', from: hhmm(-HOUR), until: hhmm(HOUR), delaySeconds: 1, message: 'brb' }] }
    const wait = () => new Promise(r => setTimeout(r, 1_200))

    test('replies once the wait is over', async () => {
      const { tg, daemon } = await daemonAway(waitingAway)
      tg.emit(LEO.id, 'hi')
      await settle()
      expect(tg.sent).toEqual([])
      expect(daemon.service.uiState().away.waiting).toBe(1)
      await wait()
      expect(tg.sent.map(s => s.text)).toEqual(['brb'])
      await daemon.stop()
    })

    test('reading a chat on another device, or typing there, means no reply', async () => {
      const { tg, daemon } = await daemonAway(waitingAway)
      tg.emit(LEO.id, 'hi')
      await settle()
      tg.emitRead(LEO.id)
      tg.emit(ANNA.id, 'hey')
      await settle()
      tg.emit(LEO.id, 'on my way', LEO.id, { outgoing: true })
      await wait()
      expect(tg.sent).toEqual([])
      await daemon.stop()
    })

    test("Claude's sends and the away replies are not you", async () => {
      const { tg, daemon } = await daemonAway(waitingAway)
      tg.emit(LEO.id, 'hi')
      await settle()
      const own = await daemon.service.sendAway(ANNA.id, 'from the daemon')
      tg.emit(ANNA.id, 'from the daemon', ANNA.id, { outgoing: true, id: own.id })
      await wait()
      expect(tg.sent.map(s => [s.chatId, s.text])).toEqual([
        [ANNA.id, 'from the daemon'],
        [LEO.id, 'brb'],
      ])
      await daemon.stop()
    })
  })
})

describe('tgmcp away', () => {
  const cli = async (home: string, port: number, ...args: string[]) => {
    const p = Bun.spawn([process.execPath, resolve(import.meta.dir, '../src/cli.ts'), 'away', ...args], {
      env: { ...process.env, TELEGRAM_MCP_HOME: home, TELEGRAM_MCP_PORT: String(port) },
      stdout: 'pipe',
      stderr: 'ignore',
    })
    const out = await new Response(p.stdout).text()
    return { out, code: await p.exited }
  }

  test('the preview shows the message just saved, with the name from the daemon', async () => {
    const tg = new FakeTelegram().add(LEO, ANNA)
    tg.me = { ...tg.me, name: 'Chamodh Perera' }
    const { daemon, paths } = await daemonAway(undefined, {}, tg)
    const r = await cli(paths.home, daemon.port, 'message', 'Back', 'soon,', '{name}')
    expect(r.code).toBe(0)
    expect(r.out).toContain('Saved.')
    expect(r.out).toContain('  Back soon, Chamodh')
    expect(r.out).not.toContain('off the grid for the night')
    await daemon.stop()
  })

  test('without a daemon the preview keeps {name}', async () => {
    const { getPaths } = await import('../src/shared/paths')
    const paths = getPaths(mkdtempSync(join(tmpdir(), 'tgmcp-away-')))
    writeFileSync(paths.config, JSON.stringify({ footer: '\n\nF' }))
    const free = Bun.serve({ port: 0, fetch: () => new Response() })
    const port = free.port!
    free.stop(true)
    const r = await cli(paths.home, port, 'message', 'Out,', '{name}')
    expect(r.code).toBe(0)
    expect(r.out).toContain('  Out, {name}\n  \n  F')
  })

  test('a rejected change leaves config.json untouched', async () => {
    const { getPaths } = await import('../src/shared/paths')
    const paths = getPaths(mkdtempSync(join(tmpdir(), 'tgmcp-away-')))
    const original = '{ "footer": "",   "away": { "until": "07:00" } }'
    writeFileSync(paths.config, original)
    const r = await cli(paths.home, 1, 'hours', '07:00', '07:00')
    expect(r.code).toBe(1)
    expect(r.out).toContain("can't be the same time")
    expect(readFileSync(paths.config, 'utf8')).toBe(original)
  })
})

describe('POST /ui/away', () => {
  const call = (d: { port: number; token: string }, body: unknown, auth = true) =>
    fetch(`http://127.0.0.1:${d.port}/ui/away`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${d.token}` } : {}) },
      body: JSON.stringify(body),
    })

  test('edits the settings, rejects nothing-to-change, and needs the token', async () => {
    // An "until" with no schedule name goes to the schedule replying now, and /ui/state shows that one.
    // Pinned to local noon, inside Daytime (08:00-21:00) before and after the edit. Unpinned, between
    // 07:30 and 08:00 the edit moved Night's end to before now, so /ui/state then showed Daytime's 21:00.
    const noon = new Date()
    noon.setHours(12, 0, 0, 0)
    setSystemTime(noon)
    try {
      const { daemon } = await daemonAway({})
      const ok = await call(daemon, { until: '07:30' })
      expect(ok.status).toBe(200)
      const state = (await (await fetch(`http://127.0.0.1:${daemon.port}/ui/state`, { headers: { authorization: `Bearer ${daemon.token}` } })).json()) as {
        away: { until: string; schedules: { id: string; until: string }[] }
      }
      expect(state.away.until).toBe('07:30')
      expect(state.away.schedules.map(s => [s.id, s.until])).toEqual([
        ['day', '07:30'],
        ['night', '08:00'],
      ])
      const empty = await call(daemon, {})
      expect(empty.status).toBe(400)
      expect(((await empty.json()) as { text: string }).text).toContain('nothing to change')
      expect((await call(daemon, { until: '07:30' }, false)).status).toBe(401)
      await daemon.stop()
    } finally {
      setSystemTime()
    }
  })
})
