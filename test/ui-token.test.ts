import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createDaemon } from '../src/daemon/main'
import { isUiRoute } from '../src/daemon/server'
import { DaemonClient } from '../src/mcp/daemon-client'
import { getPaths } from '../src/shared/paths'
import { FileSecretStore } from '../src/shared/secrets'
import { FakeTelegram, LEO, TEAM_QA } from './fake-telegram'

/** Every route of the menu bar and tray apps, with a body that gets past auth. */
const UI_ROUTES: { method: 'GET' | 'POST'; path: string; body?: unknown }[] = [
  { method: 'GET', path: '/ui/state' },
  { method: 'GET', path: `/ui/avatars/${LEO.id}` },
  { method: 'POST', path: '/ui/approvals/a_nothere', body: { decision: 'deny' } },
  { method: 'POST', path: '/ui/bots/resume', body: {} },
  { method: 'POST', path: '/ui/contacts', body: { nickname: 'leo', autoReply: true } },
  { method: 'POST', path: '/ui/contacts/page', body: { nickname: 'leo', reason: 'test' } },
  { method: 'POST', path: '/ui/pages/test' },
  { method: 'POST', path: '/ui/pages/pg_nothere', body: { action: 'ack' } },
  { method: 'POST', path: '/ui/footer', body: { enabled: false } },
  { method: 'POST', path: '/ui/away', body: { enabled: false } },
  { method: 'POST', path: '/admin/reconnect' },
]

function openWs(url: string, headers?: Record<string, string>): Promise<WebSocket> {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url, headers ? { headers } : undefined)
    ws.onopen = () => res(ws)
    ws.onerror = () => rej(new Error(`could not open ${url}`))
  })
}

describe('two tokens: one for Claude sessions, one for the menu bar and tray apps', () => {
  const paths = getPaths(mkdtempSync(join(tmpdir(), 'tgmcp-uitoken-')))
  let d: Awaited<ReturnType<typeof createDaemon>>
  const base = () => `http://127.0.0.1:${d.port}`
  const req = (method: string, path: string, token: string | null, body?: unknown) =>
    fetch(`${base()}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(token === null ? {} : { authorization: `Bearer ${token}` }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })

  beforeAll(async () => {
    writeFileSync(
      paths.config,
      JSON.stringify({
        footer: '\n\nF',
        chats: { leo: { id: LEO.id, name: LEO.name, type: 'user' }, qa: { id: TEAM_QA.id, name: 'Team QA', type: 'group' } },
        rules: { requireApproval: ['qa'] },
      }),
    )
    d = await createDaemon({ paths, port: 0, telegram: new FakeTelegram().add(LEO, TEAM_QA), log: () => {}, pageBotToken: null })
  })
  afterAll(() => d.stop())

  test('the daemon makes a second token, kept next to the first', async () => {
    expect(d.uiToken).toMatch(/^[0-9a-f]{48}$/)
    expect(d.uiToken).not.toBe(d.token)
    const files = new FileSecretStore(paths)
    expect(await files.get('ui-token')).toBe(d.uiToken)
    expect(await files.get('token')).toBe(d.token)
  })

  test('isUiRoute: /ui/* and /admin/*, nothing else', () => {
    for (const p of ['/ui/state', '/ui/approvals/a_1', '/admin/reconnect', '/ui', '/admin', '/ui/'])
      expect(isUiRoute(p)).toBe(true)
    for (const p of ['/bridge', '/events', '/status', '/health', '/uix', '/administer', '//ui/state', '/UI/state'])
      expect(isUiRoute(p)).toBe(false)
  })

  for (const r of UI_ROUTES) {
    test(`${r.method} ${r.path}: the bridge token gets 403, no or a wrong token 401, the UI token gets in`, async () => {
      expect((await req(r.method, r.path, null, r.body)).status).toBe(401)
      expect((await req(r.method, r.path, 'f'.repeat(48), r.body)).status).toBe(401)
      expect((await req(r.method, r.path, '', r.body)).status).toBe(401)
      const bridge = await req(r.method, r.path, d.token, r.body)
      expect(bridge.status).toBe(403)
      expect(await bridge.text()).toContain('forbidden')
      const ui = await req(r.method, r.path, d.uiToken, r.body)
      expect([401, 403]).not.toContain(ui.status)
    })
  }

  test('an unknown /ui or /admin path is 404 for the UI token and 403 for the bridge token', async () => {
    expect((await req('GET', '/ui/nope', d.uiToken)).status).toBe(404)
    expect((await req('GET', '/admin/nope', d.uiToken)).status).toBe(404)
    expect((await req('GET', '/ui/nope', d.token)).status).toBe(403)
  })

  test('the bridge token changes nothing on the apps\' routes', async () => {
    const before = readFileSync(paths.config, 'utf8')
    expect((await req('POST', '/ui/footer', d.token, { footer: '\n\nchanged' })).status).toBe(403)
    expect((await req('POST', '/ui/contacts', d.token, { nickname: 'qa', sendMode: 'autoSend' })).status).toBe(403)
    expect((await req('POST', '/ui/away', d.token, { enabled: true })).status).toBe(403)
    expect(readFileSync(paths.config, 'utf8')).toBe(before)
  })

  test('a session\'s token cannot decide its own draft; the UI token can', async () => {
    const session = new DaemonClient({
      target: () => ({ url: `ws://127.0.0.1:${d.port}/bridge`, token: d.token }),
      sessionId: 's_uitok001',
      label: 'test',
      channel: false,
      log: () => {},
    })
    session.start()
    try {
      const draft = await session.call('telegram_send_message', { to: 'qa', text: 'needs a person' })
      const id = /Approval id: (a_\w+)/.exec(draft.result.text)?.[1]
      expect(id).toBeDefined()
      const viaBridge = await req('POST', `/ui/approvals/${id}`, d.token, { decision: 'approve', remember: 'autoSend' })
      expect(viaBridge.status).toBe(403)
      // Polling /ui/state with the bridge token is refused too, so it can't stand in for the app.
      expect((await req('GET', '/ui/state', d.token)).status).toBe(403)
      const state = (await (await req('GET', '/ui/state', d.uiToken)).json()) as { approvals: { id: string }[] }
      expect(state.approvals.map(a => a.id)).toContain(id!)
      const viaUi = await req('POST', `/ui/approvals/${id}`, d.uiToken, { decision: 'deny' })
      expect(viaUi.status).toBe(200)
    } finally {
      session.close()
    }
  })

  test('the UI token does not open /bridge, /status or /events', async () => {
    await expect(openWs(`ws://127.0.0.1:${d.port}/bridge`, { authorization: `Bearer ${d.uiToken}` })).rejects.toThrow()
    expect((await req('GET', '/bridge', d.uiToken)).status).toBe(403)
    expect((await req('GET', '/status', d.uiToken)).status).toBe(403)
    await expect(openWs(`ws://127.0.0.1:${d.port}/events?session=s_uitok002`, { authorization: `Bearer ${d.uiToken}` })).rejects.toThrow()
    // The bridge token still does.
    const ws = await openWs(`ws://127.0.0.1:${d.port}/bridge`, { authorization: `Bearer ${d.token}` })
    ws.close()
    expect((await req('GET', '/status', d.token)).status).toBe(200)
    expect((await req('GET', '/status', null)).status).toBe(401)
    expect((await req('GET', '/health', null)).status).toBe(200)
  })
})

describe('the MCP proxy and `tgmcp call` never read the UI token', () => {
  const src = resolve(import.meta.dir, '../src')
  const mentionsUiToken = /ui-token|uiToken|readUiToken|ensureUiToken/

  test('nothing under src/mcp names it', () => {
    const files = readdirSync(join(src, 'mcp')).filter(f => f.endsWith('.ts'))
    expect(files.length).toBeGreaterThan(0)
    for (const f of files) expect(readFileSync(join(src, 'mcp', f), 'utf8')).not.toMatch(mentionsUiToken)
  })

  test('the CLI reads it only in daemonFetch, and `call` uses the bridge token', () => {
    const cli = readFileSync(join(src, 'cli.ts'), 'utf8')
    const call = cli.slice(cli.indexOf("case 'call':"), cli.indexOf("case 'menubar':"))
    expect(call.length).toBeGreaterThan(0)
    expect(call).not.toMatch(mentionsUiToken)
    expect(call).toContain('readToken(secrets)')
    expect(cli.match(/readUiToken\(/g)).toHaveLength(1)
    const fetcher = cli.slice(cli.indexOf('async function daemonFetch'), cli.indexOf('async function daemonFetch') + 400)
    expect(fetcher).toContain('readUiToken(')
  })
})
