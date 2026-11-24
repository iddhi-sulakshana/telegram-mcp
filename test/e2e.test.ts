import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { createDaemon } from '../src/daemon/main'
import { eventsKey } from '../src/daemon/server'
import { getPaths } from '../src/shared/paths'
import { ANNA, FakeTelegram, TEAM_QA, LEO } from './fake-telegram'

/**
 * The real thing minus Telegram: the daemon on a random port with a fake Telegram, and the
 * actual `tgmcp mcp` proxy spawned over stdio the way Claude Code spawns it.
 */

const home = mkdtempSync(join(tmpdir(), 'tgmcp-e2e-'))
const paths = getPaths(home)
writeFileSync(
  paths.config,
  JSON.stringify({
    footer: '\n\n✨ sᴇɴᴛ ᴠɪᴀ ᴄʟᴀᴜᴅᴇ',
    guides: ['Be brief.'],
    chats: {
      leo: { id: LEO.id, username: 'leo_p', name: LEO.name },
      anna: { id: ANNA.id, username: 'anna_k', name: ANNA.name },
      qa: { id: TEAM_QA.id, name: 'Team QA' },
    },
    rules: { autoSend: ['leo'], requireApproval: ['qa'], autoReply: ['anna', 'leo'] },
  }),
)

const silent = () => {}
let tg = new FakeTelegram().add(LEO, ANNA, TEAM_QA)
let daemon: Awaited<ReturnType<typeof createDaemon>>
let port = 0

async function spawnProxy(extraArgs: string[] = [], onElicit?: () => 'accept' | 'decline') {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve(import.meta.dir, '../src/cli.ts'), 'mcp', ...extraArgs],
    env: { ...(process.env as Record<string, string>), TELEGRAM_MCP_HOME: home, TELEGRAM_MCP_PORT: String(port) },
    stderr: 'ignore',
  })
  const client = new Client({ name: 'test', version: '0' }, { capabilities: onElicit ? { elicitation: {} } : {} })
  if (onElicit) client.setRequestHandler(ElicitRequestSchema, async () => ({ action: onElicit() }))
  await client.connect(transport)
  return client
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean }
  return { text: r.content.map(c => c.text).join('\n'), isError: r.isError ?? false }
}

function nextFrame(ws: WebSocket, ms = 5_000): Promise<string> {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('no frame')), ms)
    ws.addEventListener('message', ev => {
      clearTimeout(t)
      res(String(ev.data))
    }, { once: true })
  })
}

function openWs(url: string, headers?: Record<string, string>): Promise<WebSocket> {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url, headers ? { headers } : undefined)
    ws.onopen = () => res(ws)
    ws.onerror = () => rej(new Error(`could not open ${url}`))
  })
}

async function until(check: () => boolean | Promise<boolean>, ms = 8_000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return
    await Bun.sleep(50)
  }
  throw new Error('timed out waiting')
}

beforeAll(async () => {
  daemon = await createDaemon({ paths, port: 0, telegram: tg, log: silent })
  port = daemon.port
})
afterAll(async () => {
  await daemon?.stop()
})

describe('proxy <-> daemon', () => {
  test('lists the tools and reports status', async () => {
    const client = await spawnProxy()
    const { tools } = await client.listTools()
    expect(tools.map(t => t.name)).toContain('telegram_send_message')
    expect(tools).toHaveLength(25)
    const inst = client.getInstructions() ?? ''
    expect(inst).toContain('Be brief.')
    const s = await call(client, 'telegram_status')
    expect(s.text).toContain('Telegram: connected')
    await client.close()
  })

  test('the proxy only forwards the listed tools, never the internal calls', async () => {
    // Before any menu bar test: with no app polling, the draft below waits for confirm_send, not the app.
    const client = await spawnProxy()
    const draft = await call(client, 'telegram_send_message', { to: 'qa', text: 'QA please' })
    const id = /Approval id: (\S+)/.exec(draft.text)?.[1]
    expect(id).toBeDefined()
    const sent = tg.sent.length
    for (const name of ['__decide', '__await_approval', 'constructor', 'no_such_tool']) {
      const r = await call(client, name, { approvalId: id, approve: true, remember: 'autoSend' })
      expect(r.isError).toBe(true)
      expect(r.text).toContain('Unknown tool')
    }
    expect(tg.sent.length).toBe(sent)
    await call(client, 'telegram_cancel_send', { approvalId: id })
    await client.close()
  })

  test('approval goes through the client dialog: decline sends nothing, accept sends', async () => {
    let answer: 'accept' | 'decline' = 'decline'
    let asked = 0
    const client = await spawnProxy([], () => {
      asked++
      return answer
    })
    const no = await call(client, 'telegram_send_message', { to: 'qa', text: 'QA please' })
    expect(asked).toBe(1)
    expect(no.text).toContain('Declined in the Claude Code dialog')
    expect(tg.sent).toHaveLength(0)

    answer = 'accept'
    const yes = await call(client, 'telegram_send_message', { to: 'qa', text: 'QA please' })
    expect(asked).toBe(2)
    expect(yes.text).toContain('Approved in the Claude Code dialog')
    expect(tg.sent.at(-1)).toMatchObject({ chatId: TEAM_QA.id, text: 'QA please\n\n✨ sᴇɴᴛ ᴠɪᴀ ᴄʟᴀᴜᴅᴇ' })

    const auto = await call(client, 'telegram_send_message', { to: 'leo', text: 'hi' })
    expect(asked).toBe(2) // autoSend: no dialog
    expect(auto.text).toContain('Sent to')
    await client.close()
  })

  test('an edit and a delete where sending needs approval go through the dialog too', async () => {
    const client = new Client({ name: 'test', version: '0' }, { capabilities: { elicitation: {} } })
    const asked: { message: string; fields: string[] }[] = []
    let answer: 'accept' | 'decline' = 'accept'
    client.setRequestHandler(ElicitRequestSchema, async req => {
      const p = req.params as { message: string; requestedSchema: { properties: Record<string, unknown> } }
      asked.push({ message: p.message, fields: Object.keys(p.requestedSchema.properties) })
      return { action: answer }
    })
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [resolve(import.meta.dir, '../src/cli.ts'), 'mcp'],
        env: { ...(process.env as Record<string, string>), TELEGRAM_MCP_HOME: home, TELEGRAM_MCP_PORT: String(port) },
        stderr: 'ignore',
      }),
    )
    const sent = await call(client, 'telegram_send_message', { to: 'qa', text: 'wrong link' })
    const id = Number(/message #(\d+)/.exec(sent.text)![1])
    const footer = '\n\n✨ sᴇɴᴛ ᴠɪᴀ ᴄʟᴀᴜᴅᴇ'

    answer = 'decline'
    const no = await call(client, 'telegram_edit_message', { chat: 'qa', messageId: id, text: 'right link' })
    expect(no.text).toBe(`Declined in the Claude Code dialog: message #${id} in Team QA [qa] was not edited.`)
    expect(asked.at(-1)).toEqual({
      message: `Edit this Telegram message?\n\nIn: Team QA [qa] (Team QA · id ${TEAM_QA.id} · group · forum), message #${id}\nAsking because this chat is on the requireApproval list.\n\nNow:\nwrong link${footer}\n\nNew:\nright link${footer}`,
      fields: [],
    })

    answer = 'accept'
    const yes = await call(client, 'telegram_edit_message', { chat: 'qa', messageId: id, text: 'right link' })
    expect(yes.text).toBe(`Approved in the Claude Code dialog. Edited message #${id} in Team QA [qa].`)
    expect(tg.edits.at(-1)).toMatchObject({ chatId: TEAM_QA.id, messageId: id, text: `right link${footer}` })

    const del = await call(client, 'telegram_delete_message', { chat: 'qa', messageId: id })
    expect(asked.at(-1)!.message).toBe(
      `Delete this Telegram message for everyone?\n\nIn: Team QA [qa] (Team QA · id ${TEAM_QA.id} · group · forum), message #${id}\nAsking because this chat is on the requireApproval list.\n\nright link${footer}`,
    )
    expect(del.text).toBe(`Approved in the Claude Code dialog. Deleted message #${id} in Team QA [qa].`)
    expect(tg.deleted.at(-1)).toEqual({ chatId: TEAM_QA.id, messageId: id })
    await client.close()
  })

  test('a topic is created where sending is automatic and refused where it needs approval', async () => {
    const client = await spawnProxy()
    const made = await call(client, 'telegram_create_topic', { chat: 'leo', title: 'KYC' })
    expect(made.isError).toBe(false)
    const topic = tg.topics.at(-1)!
    expect(topic).toMatchObject({ chatId: LEO.id, title: 'KYC' })
    expect(made.text).toContain(`topic id ${topic.id}`)

    const listed = await call(client, 'telegram_list_topics', { chat: 'leo' })
    expect(listed.isError).toBe(false)
    expect(listed.text).toContain(`topic ${topic.id} · KYC`)

    const before = tg.topics.length
    const refused = await call(client, 'telegram_create_topic', { chat: 'qa', title: 'KYC' })
    expect(refused.isError).toBe(true)
    expect(refused.text).toContain('requireApproval')
    expect(tg.topics.length).toBe(before)
    await client.close()
  })

  test('without a dialog the model gets an approval id to confirm', async () => {
    const before = tg.sent.length
    const client = await spawnProxy()
    const r = await call(client, 'telegram_send_message', { to: 'qa', text: 'x' })
    const id = /Approval id: (a_\w+)/.exec(r.text)?.[1]
    expect(id).toBeDefined()
    expect(tg.sent.length).toBe(before)
    const ok = await call(client, 'telegram_confirm_send', { approvalId: id })
    expect(ok.isError).toBe(false)
    expect(tg.sent.length).toBe(before + 1)
    await client.close()
  })

  test("a bridge posing as the session can't answer its dialog without the draft's key", async () => {
    // Before the menu bar tests: no app is polling, so the draft is the dialog's to decide.
    const before = tg.sent.length
    const client = await spawnProxy()
    const draft = await call(client, 'telegram_send_message', { to: 'qa', text: 'QA please' })
    const id = /Approval id: (a_\w+)/.exec(draft.text)?.[1]
    expect(id).toBeDefined()
    // The session id is no secret: the Monitor URL carries it.
    const watch = await call(client, 'telegram_watch', { chat: 'anna' })
    const sid = new URL(/ws:\/\/\S+/.exec(watch.text)![0]).searchParams.get('session')!

    const { DaemonClient } = await import('../src/mcp/daemon-client')
    const intruder = new DaemonClient({
      target: async () => ({ url: `ws://127.0.0.1:${port}/bridge`, token: daemon.token }),
      sessionId: sid,
      label: 'intruder',
      channel: false,
      log: silent,
    })
    intruder.start()
    for (const dialogKey of [undefined, 'f'.repeat(64)]) {
      const { result } = await intruder.call('__decide', { approvalId: id, dialogKey, approve: true, remember: 'autoSend' })
      expect(result.isError).toBe(true)
      expect(result.text).toContain('still waiting')
    }
    intruder.close()
    expect(tg.sent.length).toBe(before)

    await call(client, 'telegram_unwatch', { all: true })
    expect((await call(client, 'telegram_cancel_send', { approvalId: id })).isError).toBe(false)
    await client.close()
  })

  test('tgmcp call refuses the proxy\'s internal calls before reaching the daemon', () => {
    for (const name of ['__decide', '__await_approval', '__anything']) {
      const r = Bun.spawnSync({
        cmd: [process.execPath, resolve(import.meta.dir, '../src/cli.ts'), 'call', name, '{"approvalId":"a_x","approve":true}'],
        env: { ...(process.env as Record<string, string>), TELEGRAM_MCP_HOME: home, TELEGRAM_MCP_PORT: String(port) },
      })
      expect(r.exitCode).toBe(1)
      expect(r.stderr.toString()).toContain('internal to the MCP proxy')
    }
  })

  test('watch -> Monitor websocket gets each message; survives a daemon restart', async () => {
    const client = await spawnProxy()
    const w = await call(client, 'telegram_watch', { chat: 'anna' })
    const url = /ws\.url: (\S+)/.exec(w.text)?.[1]
    expect(url).toBeDefined()

    let ws = await openWs(url!)
    const first = nextFrame(ws)
    tg.emit(ANNA.id, 'are you there?')
    expect(await first).toContain('are you there?')

    // Kill the daemon and start a fresh one on the same port (as launchd would).
    await daemon.stop()
    tg = new FakeTelegram().add(LEO, ANNA, TEAM_QA)
    daemon = await createDaemon({ paths, port, telegram: tg, log: silent })

    // The proxy reconnects on its own and restores its watch.
    await until(() => daemon.hub.isWatching(daemon.hub.summary()[0]?.id ?? '', ANNA.id))
    ws = await openWs(url!)
    const second = nextFrame(ws)
    tg.emit(ANNA.id, 'still here after restart')
    expect(await second).toContain('still here after restart')

    // Tools keep working through the same MCP connection.
    const s = await call(client, 'telegram_status')
    expect(s.text).toContain('Watches:')
    expect(s.text).toContain('Anna K')
    ws.close()
    await client.close()
  })

  test('messages queue when nothing listens, and tool results say so', async () => {
    const client = await spawnProxy()
    await call(client, 'telegram_watch', { chat: 'leo' })
    tg.emit(LEO.id, 'queued one')
    const any = await call(client, 'telegram_get_rules')
    expect(any.text).toContain('1 watched message(s) waiting')
    const e = await call(client, 'telegram_get_events')
    expect(e.text).toContain('queued one')
    await client.close()
  })

  test('channel mode pushes notifications into the session', async () => {
    const client = await spawnProxy(['--channel'])
    const got: { content: string; meta: Record<string, string> }[] = []
    client.setNotificationHandler(
      z.object({
        method: z.literal('notifications/claude/channel'),
        params: z.object({ content: z.string(), meta: z.record(z.string(), z.string()) }),
      }),
      async n => {
        got.push(n.params)
      },
    )
    const w = await call(client, 'telegram_watch', { chat: 'leo' })
    expect(w.text).toContain('<channel>')
    tg.emit(LEO.id, 'pushed!')
    await until(() => got.length > 0)
    expect(got[0]!.content).toBe('> pushed!')
    expect(got[0]!.meta).toMatchObject({ chat: 'leo', chat_id: String(LEO.id), from: 'Leo Perera' })
    await client.close()
  })

  test('the session survives the daemon being down at first', async () => {
    await daemon.stop()
    const client = await spawnProxy()
    expect((await client.listTools()).tools.length).toBe(25)
    tg = new FakeTelegram().add(LEO, ANNA, TEAM_QA)
    daemon = await createDaemon({ paths, port, telegram: tg, log: silent })
    const s = await call(client, 'telegram_status')
    expect(s.text).toContain('Telegram: connected')
    await client.close()
  })

  test('first message from the dialog: the choice and nickname are saved', async () => {
    tg.add({ id: 70, type: 'user', name: 'Nimal Silva', username: 'nimal_s' })
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve(import.meta.dir, '../src/cli.ts'), 'mcp'],
      env: { ...(process.env as Record<string, string>), TELEGRAM_MCP_HOME: home, TELEGRAM_MCP_PORT: String(port) },
      stderr: 'ignore',
    })
    const client = new Client({ name: 'test', version: '0' }, { capabilities: { elicitation: {} } })
    let schema: Record<string, unknown> = {}
    client.setRequestHandler(ElicitRequestSchema, async req => {
      schema = (req.params as { requestedSchema: { properties: Record<string, unknown> } }).requestedSchema.properties
      return { action: 'accept', content: { next_time: 'autoSend', nickname: 'nimal' } }
    })
    await client.connect(transport)
    const r = await call(client, 'telegram_send_message', { to: '@nimal_s', text: 'hello' })
    expect(Object.keys(schema).sort()).toEqual(['next_time', 'nickname'])
    expect(r.text).toContain('Saved as "nimal" and whitelisted')
    const again = await call(client, 'telegram_send_message', { to: 'nimal', text: 'second' })
    expect(again.text).toContain('Sent to')
    await client.close()
  })

  test('menu bar approvals: the tool call waits for the click', async () => {
    const token = daemon.token
    const ui = (path: string, init?: RequestInit) =>
      fetch(`http://127.0.0.1:${port}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } })
    // The menu bar app polls; that is what makes approvals go to it instead of the dialog.
    let dialogs = 0
    const client = await spawnProxy([], () => {
      dialogs++
      return 'decline'
    })
    await ui('/ui/state')
    const before = tg.sent.length

    const pending = call(client, 'telegram_send_message', { to: 'qa', text: 'from the menu bar' })
    let id = ''
    await until(async () => {
      const s = (await (await ui('/ui/state')).json()) as { approvals: { id: string; text: string }[] }
      id = s.approvals[0]?.id ?? ''
      return id !== ''
    })
    const res = await ui(`/ui/approvals/${id}`, { method: 'POST', body: JSON.stringify({ decision: 'approve' }) })
    expect(res.status).toBe(200)
    const out = await pending
    expect(out.text).toContain('Approved in the menu bar')
    expect(dialogs).toBe(0)
    expect(tg.sent.length).toBe(before + 1)

    const state = (await (await ui('/ui/state')).json()) as { recent: { text: string; via: string }[] }
    expect(state.recent[0]).toMatchObject({ via: 'menubar' })
    expect(state.recent[0]!.text).toStartWith('from the menu bar')

    const again = await ui(`/ui/approvals/${id}`, { method: 'POST', body: JSON.stringify({ decision: 'deny' }) })
    expect(again.status).toBe(409)
    await client.close()
  })

  test('creating a chat: the call waits for the menu bar, then makes the channel and its group', async () => {
    // A menu bar or tray app new enough to show new-chat cards says so on every request.
    const headers = { authorization: `Bearer ${daemon.token}`, 'content-type': 'application/json', 'x-tgmcp-features': 'create' }
    const ui = (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${port}${path}`, { ...init, headers })
    const oldApp = (path: string) => fetch(`http://127.0.0.1:${port}${path}`, { headers: { authorization: `Bearer ${daemon.token}` } })
    const original = readFileSync(paths.config, 'utf8')
    writeFileSync(paths.config, JSON.stringify({ ...JSON.parse(original), chatCreation: { enabled: true } }))
    const client = await spawnProxy()
    try {
      await until(async () => (await call(client, 'telegram_status')).text.includes('Creating chats: on'))
      await ui('/ui/state')
      const pending = call(client, 'telegram_create_chat', {
        type: 'channel',
        title: 'Acme News',
        username: 'acme_news',
        discussion: { kind: 'new' },
      })
      let card: { id: string; action: string; to: string; text: string } | undefined
      await until(async () => {
        const s = (await (await ui('/ui/state')).json()) as { approvals: { id: string; action: string; to: string; text: string }[] }
        card = s.approvals.find(a => a.action === 'create')
        return card !== undefined
      })
      const seenByOldApp = (await (await oldApp('/ui/state')).json()) as { approvals: { action: string }[] }
      expect(seenByOldApp.approvals.some(a => a.action === 'create')).toBe(false)
      expect(card!.text).toContain('t.me/acme_news')
      expect(card!.text).toContain('Acme News Chat')
      expect(tg.created).toHaveLength(0)
      const res = await ui(`/ui/approvals/${card!.id}`, { method: 'POST', body: JSON.stringify({ decision: 'approve' }) })
      expect(res.status).toBe(200)
      const out = await pending
      expect(out.isError).toBe(false)
      expect(out.text).toContain('Created channel "Acme News"')
      expect(out.text).toContain('https://t.me/acme_news')
      expect(tg.created.map(c => c.type)).toEqual(['channel', 'supergroup'])
      expect(tg.links).toHaveLength(1)
    } finally {
      writeFileSync(paths.config, original)
      await until(async () => (await call(client, 'telegram_status')).text.includes('Creating chats: off'))
      await client.close()
    }
  })

  test('menu bar contacts: edits over http change what a session may do', async () => {
    const ui = (path: string, init?: RequestInit) =>
      fetch(`http://127.0.0.1:${port}${path}`, { ...init, headers: { authorization: `Bearer ${daemon.token}`, 'content-type': 'application/json' } })
    const edit = (body: object) => ui('/ui/contacts', { method: 'POST', body: JSON.stringify(body) })
    const contact = async (nick: string) =>
      ((await (await ui('/ui/state')).json()) as { contacts: { nickname: string; sendMode: string; autoReply: boolean }[] }).contacts.find(
        c => c.nickname === nick,
      )

    expect(await contact('anna')).toMatchObject({ sendMode: 'none', autoReply: true })
    expect((await fetch(`http://127.0.0.1:${port}/ui/contacts`, { method: 'POST', body: '{}' })).status).toBe(401)
    expect((await edit({ nickname: 'anna', sendMode: 'sometimes' })).status).toBe(400)
    expect((await edit({ nickname: 'anna' })).status).toBe(400)
    expect((await edit({ nickname: 'anna', rename: 'leo' })).status).toBe(409)

    const client = await spawnProxy()
    const before = tg.sent.length
    const res = await edit({ nickname: 'anna', sendMode: 'autoSend' })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { text: string }).text).toContain('always allow')
    expect((await call(client, 'telegram_send_message', { to: 'anna', text: 'hi' })).text).toContain('Sent to')
    expect(tg.sent.length).toBe(before + 1)

    expect(((await (await edit({ nickname: 'anna', rename: 'annie' })).json()) as { nickname: string }).nickname).toBe('annie')
    expect(await contact('annie')).toMatchObject({ sendMode: 'autoSend', autoReply: true })
    expect(await contact('anna')).toBeUndefined()

    // Put it back for the tests below.
    expect((await edit({ nickname: 'annie', sendMode: 'none', rename: 'anna' })).status).toBe(200)
    expect(await contact('anna')).toMatchObject({ sendMode: 'none', autoReply: true })
    await client.close()
  })

  test('a Monitor can connect before its proxy (right after a daemon restart)', async () => {
    const url = `ws://127.0.0.1:${port}/events?session=s_early123`
    const ws = await openWs(url, { authorization: `Bearer ${daemon.token}` })
    expect(daemon.hub.has('s_early123')).toBe(true)
    ws.close()
  })

  test('the Monitor URL carries a per-session key, never the token', async () => {
    const client = await spawnProxy()
    const r = await call(client, 'telegram_watch', { chat: 'anna' })
    const url = /ws:\/\/\S+/.exec(r.text)?.[0] ?? ''
    expect(url).toContain('key=')
    expect(url).not.toContain(daemon.token)
    const sid = new URL(url).searchParams.get('session')!
    expect(new URL(url).searchParams.get('key')).toBe(eventsKey(daemon.token, sid))
    const ws = await openWs(url)
    ws.close()
    // The key opens its own session only, and is no good for anything else.
    await expect(openWs(`ws://127.0.0.1:${port}/events?session=s_other123&key=${eventsKey(daemon.token, sid)}`)).rejects.toThrow()
    const status = await fetch(`http://127.0.0.1:${port}/status?token=${eventsKey(daemon.token, sid)}`)
    expect(status.status).toBe(401)
    await call(client, 'telegram_unwatch', { all: true })
    await client.close()
  })

  test('the token is only taken from the Authorization header, never from the URL', async () => {
    const t = daemon.token
    await expect(openWs(`ws://127.0.0.1:${port}/bridge?token=${t}`)).rejects.toThrow()
    await expect(openWs(`ws://127.0.0.1:${port}/events?session=s_query123&token=${t}`)).rejects.toThrow()
    expect((await fetch(`http://127.0.0.1:${port}/status?token=${t}`)).status).toBe(401)
    expect((await fetch(`http://127.0.0.1:${port}/ui/state?token=${t}`)).status).toBe(401)
    // The same token in the header works.
    const ws = await openWs(`ws://127.0.0.1:${port}/bridge`, { authorization: `Bearer ${t}` })
    ws.close()
    expect((await fetch(`http://127.0.0.1:${port}/status`, { headers: { authorization: `Bearer ${t}` } })).status).toBe(200)
  })

  test('rejects requests without the token', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/status`)
    expect(res.status).toBe(401)
    const health = await fetch(`http://127.0.0.1:${port}/health`)
    expect(health.status).toBe(200)
  })
})
