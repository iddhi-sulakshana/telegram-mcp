import { afterEach, expect, test } from 'bun:test'
import { DaemonClient } from '../src/mcp/daemon-client'

let server: ReturnType<typeof Bun.serve> | null = null
let client: DaemonClient | null = null

afterEach(() => {
  client?.close()
  server?.stop(true)
  client = null
  server = null
})

test('the token goes in the Authorization header of the upgrade, never in the URL', async () => {
  const seen: { url: string; auth: string | null }[] = []
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req, srv) {
      seen.push({ url: req.url, auth: req.headers.get('authorization') })
      return srv.upgrade(req, { data: {} }) ? undefined : new Response('no', { status: 400 })
    },
    websocket: { message() {} },
  })
  const token = 'a'.repeat(64)
  client = new DaemonClient({
    target: () => ({ url: `ws://127.0.0.1:${server!.port}/bridge`, token }),
    sessionId: 's_abcdefgh',
    label: 'test',
    channel: false,
    log: () => {},
  })
  client.start()
  const end = Date.now() + 5_000
  while (!client.connected && Date.now() < end) await Bun.sleep(20)
  expect(client.connected).toBe(true)
  expect(seen).toHaveLength(1)
  expect(seen[0]!.url).not.toContain(token)
  expect(new URL(seen[0]!.url).search).toBe('')
  expect(seen[0]!.auth).toBe(`Bearer ${token}`)
})
