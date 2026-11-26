import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AvatarCache, imageType } from '../src/daemon/avatars'
import { demoAvatar } from './demo-avatars'
import { ANNA, FakeTelegram, LEO, LEONARDO } from './fake-telegram'

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])
const HOUR = 3_600_000

function cache(fetch: (id: number) => Promise<Uint8Array | null>, now = { t: 1_000_000_000_000 }) {
  const dir = mkdtempSync(join(tmpdir(), 'tgmcp-avatars-'))
  const calls: number[] = []
  const c = new AvatarCache({
    dir,
    now: () => now.t,
    fetch: id => {
      calls.push(id)
      return fetch(id)
    },
  })
  return { c, dir, calls, now }
}

describe('the avatar cache', () => {
  test('fetches a photo once, then serves it from disk', async () => {
    const { c, dir, calls } = cache(async () => JPEG)
    const a = await c.get(LEO.id)
    expect(a?.type).toBe('image/jpeg')
    expect([...a!.bytes]).toEqual([...JPEG])
    expect(existsSync(join(dir, `${LEO.id}.jpg`))).toBe(true)
    expect((await c.get(LEO.id))?.tag).toBe(a!.tag)
    expect(calls).toEqual([LEO.id])
  })

  test('remembers a chat with no photo, without asking again', async () => {
    const { c, dir, calls } = cache(async () => null)
    expect(await c.get(ANNA.id)).toBeNull()
    expect(await c.get(ANNA.id)).toBeNull()
    expect(existsSync(join(dir, `${ANNA.id}.none`))).toBe(true)
    expect(calls).toEqual([ANNA.id])
  })

  test('asks again after a day, and a removed photo goes', async () => {
    let photo: Uint8Array | null = JPEG
    const now = { t: Date.now() }
    const { c, dir, calls } = cache(async () => photo, now)
    await c.get(LEO.id)
    photo = null
    now.t += 25 * HOUR
    expect(await c.get(LEO.id)).toBeNull()
    expect(existsSync(join(dir, `${LEO.id}.jpg`))).toBe(false)
    expect(calls).toEqual([LEO.id, LEO.id])
  })

  test('when Telegram fails, the old photo is kept and it waits before trying again', async () => {
    let fail = false
    const now = { t: Date.now() }
    const { c, calls } = cache(async () => {
      if (fail) throw new Error('reconnecting')
      return JPEG
    }, now)
    await c.get(LEO.id)
    fail = true
    now.t += 25 * HOUR
    expect((await c.get(LEO.id))?.type).toBe('image/jpeg')
    expect((await c.get(LEO.id))?.type).toBe('image/jpeg')
    expect(calls).toHaveLength(2) // the second ask, 0 minutes later, doesn't retry
    now.t += 11 * 60_000
    fail = false
    await c.get(LEO.id)
    expect(calls).toHaveLength(3)
  })

  test('two asks at once share one fetch, and fetches run one at a time', async () => {
    let running = 0
    let most = 0
    const { c, calls } = cache(async () => {
      most = Math.max(most, ++running)
      await new Promise(r => setTimeout(r, 10))
      running--
      return JPEG
    })
    await Promise.all([c.get(LEO.id), c.get(LEO.id), c.get(ANNA.id), c.get(LEONARDO.id)])
    expect(calls.sort()).toEqual([LEO.id, LEONARDO.id, ANNA.id].sort())
    expect(most).toBe(1)
  })

  test('labels PNG and JPEG', () => {
    expect(imageType(demoAvatar(0x2563eb, 0x7c3aed))).toBe('image/png')
    expect(imageType(JPEG)).toBe('image/jpeg')
  })
})

describe('GET /ui/avatars/:chatId', () => {
  async function daemon() {
    const { createDaemon } = await import('../src/daemon/main')
    const { getPaths } = await import('../src/shared/paths')
    const paths = getPaths(mkdtempSync(join(tmpdir(), 'tgmcp-avatar-api-')))
    writeFileSync(
      paths.config,
      JSON.stringify({
        footer: '',
        chats: { leo: { id: LEO.id, name: LEO.name, type: 'user' }, anna: { id: ANNA.id, name: ANNA.name, type: 'user' } },
      }),
    )
    const tg = new FakeTelegram().add(LEO, ANNA, LEONARDO)
    tg.photos.set(LEO.id, JPEG)
    const d = await createDaemon({ paths, port: 0, telegram: tg, log: () => {}, pageBotToken: null })
    const get = (path: string, headers: Record<string, string> = { authorization: `Bearer ${d.uiToken}` }) =>
      fetch(`http://127.0.0.1:${d.port}${path}`, { headers })
    return { d, tg, get }
  }

  test('serves a saved chat photo with the token, and 404 for one with none', async () => {
    const { d, tg, get } = await daemon()
    const r = await get(`/ui/avatars/${LEO.id}`)
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toBe('image/jpeg')
    expect([...new Uint8Array(await r.arrayBuffer())]).toEqual([...JPEG])
    const again = await get(`/ui/avatars/${LEO.id}`, { authorization: `Bearer ${d.uiToken}`, 'if-none-match': r.headers.get('etag')! })
    expect(again.status).toBe(304)
    expect((await get(`/ui/avatars/${ANNA.id}`)).status).toBe(404)
    expect(tg.photoCalls).toEqual([LEO.id, ANNA.id])
    await d.stop()
  })

  test('needs the token, and never asks Telegram about a chat the apps do not show', async () => {
    const { d, tg, get } = await daemon()
    expect((await get(`/ui/avatars/${LEO.id}`, {})).status).toBe(401)
    expect((await get(`/ui/avatars/${LEONARDO.id}`)).status).toBe(404)
    expect((await get('/ui/avatars/abc')).status).toBe(404)
    expect(tg.photoCalls).toEqual([])
    await d.stop()
  })
})
