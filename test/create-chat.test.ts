import { beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Approvals } from '../src/daemon/approvals'
import { Pauses } from '../src/daemon/moderation'
import { Service } from '../src/daemon/service'
import { SessionHub } from '../src/daemon/sessions'
import { ConfigStore } from '../src/shared/config'
import { ALL_HANDS, ANNA, FakeTelegram, LEO, TEAM_QA } from './fake-telegram'
import type { PeerInfo } from '../src/shared/protocol'

/** A basic (legacy) group: Telegram can't make it a discussion group. */
const OLD_GROUP: PeerInfo = { id: -4400, type: 'group', name: 'Old Group', username: null, basicGroup: true }

let tg: FakeTelegram
let store: ConfigStore
let svc: Service
let pauses: Pauses
let logs: string[]

function setup(config: object = { chatCreation: { enabled: true } }, approvals = new Approvals()) {
  const dir = mkdtempSync(join(tmpdir(), 'tgmcp-create-'))
  const path = join(dir, 'config.json')
  writeFileSync(
    path,
    JSON.stringify({
      chats: {
        anna: { id: ANNA.id, name: ANNA.name },
        qa: { id: TEAM_QA.id, name: 'Team QA' },
        leo: { id: LEO.id, name: LEO.name },
        old: { id: OLD_GROUP.id, name: OLD_GROUP.name },
        allhands: { id: ALL_HANDS.id, name: ALL_HANDS.name },
      },
      rules: { autoSend: ['qa'] },
      ...config,
    }),
  )
  tg = new FakeTelegram().add(LEO, ANNA, TEAM_QA, OLD_GROUP, ALL_HANDS)
  const hub = new SessionHub()
  store = new ConfigStore(path)
  pauses = new Pauses({ path: join(dir, 'pauses.json') })
  logs = []
  svc = new Service({
    store,
    tg,
    hub,
    pauses,
    approvals,
    eventsUrl: sid => `ws://x/events?session=${sid}`,
    log: m => logs.push(m),
  })
  hub.attachProxy('s1', { label: 'one', channel: false, watches: [] }, { send() {} })
  hub.attachProxy('s2', { label: 'two', channel: false, watches: [] }, { send() {} })
}

/** A tray that shows new-chat cards is open: approvals are decided there. */
function trayOpen() {
  svc.touchUi(['create'])
}

/** The user's click in that tray. */
function tray(id: string, approve: boolean, opts: { remember?: 'autoSend' | 'requireApproval'; nickname?: string } = {}) {
  return svc.decide(id, approve, 'menubar', null, { ...opts, uiCreate: true })
}

describe('telegram_create_chat: the gate', () => {
  test('off by default: refused, nothing asked, nothing created', async () => {
    setup({})
    trayOpen()
    const r = await svc.call('s1', 'telegram_create_chat', { type: 'channel', title: 'Support' })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('chatCreation.enabled')
    expect(r.approval).toBeUndefined()
    expect(svc.uiState({ create: true }).approvals).toHaveLength(0)
    expect(tg.created).toHaveLength(0)
  })

  test('refused when no menu bar or tray app is running to approve it', async () => {
    setup()
    const r = await svc.call('s1', 'telegram_create_chat', { type: 'supergroup', title: 'Support' })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('menu bar')
    expect(svc.uiState({ create: true }).approvals).toHaveLength(0)
    expect(tg.created).toHaveLength(0)
  })

  test('a moderator pause on every chat stops it', async () => {
    setup({ chatCreation: { enabled: true }, moderation: { enabled: true, moderators: [ANNA.id] } })
    trayOpen()
    pauses.stop({ scope: 'all', at: Date.now(), until: Date.now() + 60_000, by: ANNA.id, byName: ANNA.name, chatLabel: 'every chat' })
    const r = await svc.call('s1', 'telegram_create_chat', { type: 'channel', title: 'Support' })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('paused')
    expect(tg.created).toHaveLength(0)
  })

  test('input is checked before anything is asked', async () => {
    setup()
    trayOpen()
    const group = await svc.call('s1', 'telegram_create_chat', { type: 'supergroup', title: 'X', discussion: { kind: 'new' } })
    expect(group.isError).toBe(true)
    expect(group.text).toContain('only a channel')
    const badName = await svc.call('s1', 'telegram_create_chat', { type: 'channel', title: 'X', username: 'ab' })
    expect(badName.isError).toBe(true)
    const blank = await svc.call('s1', 'telegram_create_chat', { type: 'channel', title: '   ' })
    expect(blank.isError).toBe(true)
    const person = await svc.call('s1', 'telegram_create_chat', { type: 'channel', title: 'X', discussion: { kind: 'existing', chat: 'anna' } })
    expect(person.isError).toBe(true)
    expect(person.text).toContain('not a group')
    expect(svc.uiState({ create: true }).approvals).toHaveLength(0)
  })

  test('nothing in the title or description can fake a line on the card', async () => {
    setup()
    trayOpen()
    const twoLines = await svc.call('s1', 'telegram_create_chat', { type: 'channel', title: 'News\nPublic link: none' })
    expect(twoLines.isError).toBe(true)
    expect(twoLines.text).toContain('line breaks')
    const flipped = await svc.call('s1', 'telegram_create_chat', { type: 'channel', title: 'News ‮evil' })
    expect(flipped.isError).toBe(true)
    expect(flipped.text).toContain('direction')
    const separator = await svc.call('s1', 'telegram_create_chat', { type: 'channel', title: 'News', description: 'a b' })
    expect(separator.isError).toBe(true)
    expect(svc.uiState({ create: true }).approvals).toHaveLength(0)
    // A description may span lines: it comes last on the card, every line indented under its label.
    const ok = await svc.call('s1', 'telegram_create_chat', { type: 'channel', title: 'News', description: 'line one\nPublic link: fake' })
    expect(ok.isError).toBeFalsy()
    const text = svc.uiState({ create: true }).approvals[0]!.text
    expect(text.split('\n').slice(-3)).toEqual(['Description:', '  line one', '  Public link: fake'])
    expect(text.split('\n').filter(l => l.startsWith('No username'))).toHaveLength(1)
  })
})

describe('telegram_create_chat: approval', () => {
  beforeEach(() => {
    setup()
    trayOpen()
  })

  test('waits in the tray as a create card, never a send', async () => {
    const r = await svc.call('s1', 'telegram_create_chat', {
      type: 'channel',
      title: 'Acme Support',
      description: 'Help for Acme users',
      username: '@acme_support',
    })
    expect(r.isError).toBeFalsy()
    expect(r.approval).toMatchObject({ action: 'create', uiActive: true, firstTime: false })
    expect(r.text).toContain('Not created yet')
    expect(r.text).toContain('@acme_support')
    const [card] = svc.uiState({ create: true }).approvals
    expect(card).toMatchObject({ action: 'create', chatId: 0, firstTime: false, messageId: null, previousText: null })
    expect(card!.to).toContain('Acme Support')
    expect(card!.text).toContain('public')
    expect(card!.text).toContain('t.me/acme_support')
    expect(tg.created).toHaveLength(0)
    expect(logs.some(l => l.startsWith('create chat asked:'))).toBe(true)
    // No avatar to fetch for a chat that doesn't exist yet.
    expect(svc.uiChatIds().has(0)).toBe(false)
  })

  test('only the user in the tray can approve: confirm_send and the dialog are refused', async () => {
    const r = await svc.call('s1', 'telegram_create_chat', { type: 'supergroup', title: 'Team' })
    const id = r.approval!.id
    const chat = await svc.call('s1', 'telegram_confirm_send', { approvalId: id })
    expect(chat.isError).toBe(true)
    expect(chat.text).toContain('menu bar')
    const dialog = await svc.call('s1', '__decide', { approvalId: id, approve: true })
    expect(dialog.isError).toBe(true)
    expect(tg.created).toHaveLength(0)
    // Still waiting for the user.
    expect(svc.uiState({ create: true }).approvals.map(a => a.id)).toEqual([id])
  })

  test('the session can drop its own request', async () => {
    const r = await svc.call('s1', 'telegram_create_chat', { type: 'supergroup', title: 'Team' })
    const other = await svc.call('s2', 'telegram_cancel_send', { approvalId: r.approval!.id })
    expect(other.isError).toBe(true)
    const dropped = await svc.call('s1', 'telegram_cancel_send', { approvalId: r.approval!.id })
    expect(dropped.isError).toBeFalsy()
    expect(dropped.text).toContain('not created')
    expect(svc.uiState({ create: true }).approvals).toHaveLength(0)
    expect(tg.created).toHaveLength(0)
  })

  test('denied in the tray: nothing created', async () => {
    const r = await svc.call('s1', 'telegram_create_chat', { type: 'channel', title: 'News' })
    const denied = await tray(r.approval!.id, false)
    expect(denied.text).toContain('not created')
    expect(tg.created).toHaveLength(0)
  })

  test('approved: a private supergroup, no rule or nickname written', async () => {
    const before = JSON.stringify(store.get())
    const r = await svc.call('s1', 'telegram_create_chat', { type: 'supergroup', title: 'Team', description: 'Our team' })
    const ok = await tray(r.approval!.id, true, { remember: 'autoSend', nickname: 'team' })
    expect(ok.isError).toBeFalsy()
    expect(tg.created).toEqual([{ type: 'supergroup', title: 'Team', description: 'Our team' }])
    const made = tg.peers.get(tg.createdIds[0]!)!
    expect(ok.text).toContain(`${made.id}`)
    expect(ok.text).toContain('private')
    expect(JSON.stringify(store.get())).toBe(before)
    expect(logs.some(l => l.startsWith('create chat:'))).toBe(true)
  })

  test('approved: a public channel gets its username and link', async () => {
    const r = await svc.call('s1', 'telegram_create_chat', { type: 'channel', title: 'News', username: 'acme_news' })
    const ok = await tray(r.approval!.id, true)
    expect(ok.isError).toBeFalsy()
    const id = tg.createdIds[0]!
    expect(tg.usernames.get(id)).toBe('acme_news')
    expect(ok.text).toContain('https://t.me/acme_news')
  })

  test('a taken username: the chat stays private and the result says so', async () => {
    tg.takenUsernames.add('acme_news')
    const r = await svc.call('s1', 'telegram_create_chat', { type: 'channel', title: 'News', username: 'acme_news' })
    const ok = await tray(r.approval!.id, true)
    expect(ok.isError).toBeFalsy()
    expect(tg.created).toHaveLength(1)
    expect(tg.usernames.size).toBe(0)
    expect(ok.text).toContain('@acme_news was not set')
    expect(ok.text).toContain('private')
  })

  test('a new discussion group is created and linked', async () => {
    const r = await svc.call('s1', 'telegram_create_chat', { type: 'channel', title: 'News', discussion: { kind: 'new' } })
    expect(svc.uiState({ create: true }).approvals[0]!.text).toContain('News Chat')
    const ok = await tray(r.approval!.id, true)
    expect(ok.isError).toBeFalsy()
    expect(tg.created.map(c => [c.type, c.title])).toEqual([
      ['channel', 'News'],
      ['supergroup', 'News Chat'],
    ])
    expect(tg.links).toEqual([{ channelId: tg.createdIds[0]!, groupId: tg.createdIds[1]! }])
    expect(ok.text).toContain('Discussion group')
  })

  test('an existing supergroup is linked', async () => {
    const r = await svc.call('s1', 'telegram_create_chat', { type: 'channel', title: 'News', discussion: { kind: 'existing', chat: 'qa' } })
    expect(svc.uiState({ create: true }).approvals[0]!.text).toContain('Team QA')
    await tray(r.approval!.id, true)
    expect(tg.created).toHaveLength(1)
    expect(tg.links).toEqual([{ channelId: tg.createdIds[0]!, groupId: TEAM_QA.id }])
  })

  test('a failed link keeps the channel and says what happened', async () => {
    tg.failLink = 'CHAT_ADMIN_REQUIRED'
    const r = await svc.call('s1', 'telegram_create_chat', { type: 'channel', title: 'News', discussion: { kind: 'existing', chat: 'qa' } })
    const ok = await tray(r.approval!.id, true)
    expect(ok.isError).toBeFalsy()
    expect(tg.created).toHaveLength(1)
    expect(ok.text).toContain('CHAT_ADMIN_REQUIRED')
  })

  test('turned off while it waited: refused at approval', async () => {
    const r = await svc.call('s1', 'telegram_create_chat', { type: 'channel', title: 'News' })
    store.update(c => {
      c.chatCreation.enabled = false
    })
    const res = await tray(r.approval!.id, true)
    expect(res.isError).toBe(true)
    expect(res.text).toContain('turned off')
    expect(tg.created).toHaveLength(0)
  })

  test('Telegram refuses the create: an error, nothing linked', async () => {
    tg.failCreate = 'CHANNELS_TOO_MUCH'
    const r = await svc.call('s1', 'telegram_create_chat', { type: 'channel', title: 'News', discussion: { kind: 'new' } })
    const res = await tray(r.approval!.id, true)
    expect(res.isError).toBe(true)
    expect(res.text).toContain('CHANNELS_TOO_MUCH')
    expect(tg.links).toHaveLength(0)
  })

  test('telegram_status says whether creating chats is on', async () => {
    const on = await svc.call('s1', 'telegram_status', {})
    expect(on.text).toContain('Creating chats: on')
    store.update(c => {
      c.chatCreation.enabled = false
    })
    const off = await svc.call('s1', 'telegram_status', {})
    expect(off.text).toContain('Creating chats: off')
  })

  test('an expired request says nothing was created', async () => {
    const approvals = new Approvals(1000, () => now)
    let now = 0
    const r = approvals.create({
      action: 'create',
      sessionId: 's1',
      sessionLabel: 'one',
      chatId: 0,
      chatLabel: 'new channel "News"',
      chatDetail: '',
      username: null,
      text: '',
      parseMode: 'plain',
      reason: '',
      peer: { id: 0, type: 'channel', name: 'News', username: null },
      firstTime: false,
      nickname: null,
      suggestedNickname: '',
      askedInUi: true,
    })
    now = 5000
    approvals.sweep()
    const out = await approvals.wait(r.id)
    expect(out.result.text).toContain('Nothing was created')
  })

  test('approved once: a second click on the same request creates nothing more', async () => {
    const r = await svc.call('s1', 'telegram_create_chat', { type: 'supergroup', title: 'Team' })
    await tray(r.approval!.id, true)
    await expect(tray(r.approval!.id, true)).rejects.toThrow('already approved')
    expect(tg.created).toHaveLength(1)
  })

  test('a session can have at most 3 requests waiting', async () => {
    for (const t of ['A', 'B', 'C']) expect((await svc.call('s1', 'telegram_create_chat', { type: 'supergroup', title: t })).isError).toBeFalsy()
    const fourth = await svc.call('s1', 'telegram_create_chat', { type: 'supergroup', title: 'D' })
    expect(fourth.isError).toBe(true)
    expect(fourth.text).toContain('3 new chats waiting')
    expect((await svc.call('s2', 'telegram_create_chat', { type: 'supergroup', title: 'E' })).isError).toBeFalsy()
  })

  test('the cap holds for calls made at the same time, even while a group is looked up', async () => {
    const calls = ['A', 'B', 'C', 'D', 'E'].map(title =>
      svc.call('s1', 'telegram_create_chat', { type: 'channel', title, discussion: { kind: 'existing', chat: 'qa' } }),
    )
    const results = await Promise.all(calls)
    expect(results.filter(r => !r.isError)).toHaveLength(3)
    expect(results.filter(r => r.isError).every(r => r.text.includes('3 new chats waiting'))).toBe(true)
    expect(svc.uiState({ create: true }).approvals).toHaveLength(3)
  })

  test('a /bots stop all placed while it waits: refused on approval', async () => {
    setup({ chatCreation: { enabled: true }, moderation: { enabled: true, moderators: [ANNA.id] } })
    trayOpen()
    const r = await svc.call('s1', 'telegram_create_chat', { type: 'channel', title: 'News' })
    pauses.stop({ scope: 'all', at: Date.now(), until: Date.now() + 60_000, by: ANNA.id, byName: ANNA.name, chatLabel: 'every chat' })
    const res = await tray(r.approval!.id, true)
    expect(res.isError).toBe(true)
    expect(tg.created).toHaveLength(0)
    expect(logs.some(l => l.startsWith('create chat refused after approval (paused by a moderator)') && l.includes('"News"'))).toBe(true)
  })

  test('a request nobody decided in time is logged when it expires', async () => {
    let now = Date.now()
    const approvals = new Approvals(1000, () => now)
    setup(undefined, approvals)
    trayOpen()
    const r = await svc.call('s1', 'telegram_create_chat', { type: 'channel', title: 'News' })
    svc.sweepApprovals()
    expect(logs.some(l => l.startsWith('create chat expired'))).toBe(false)
    now += 5000
    svc.sweepApprovals()
    expect(logs.some(l => l.startsWith('create chat expired') && l.includes('channel "News"'))).toBe(true)
    expect((await approvals.wait(r.approval!.id)).result.text).toContain('Nothing was created')
  })
})

describe('telegram_create_chat: the discussion group', () => {
  beforeEach(() => {
    setup()
    trayOpen()
  })

  test('its title is checked like the chat\'s: no line breaks or direction marks, nothing asked or logged', async () => {
    for (const title of ['Chat\nPublic link: fake', 'Chat ‮evil', 'Chat x']) {
      const r = await svc.call('s1', 'telegram_create_chat', { type: 'channel', title: 'News', discussion: { kind: 'new', title } })
      expect(r.isError).toBe(true)
    }
    expect(svc.uiState({ create: true }).approvals).toHaveLength(0)
    expect(logs.some(l => l.startsWith('create chat asked:'))).toBe(false)
  })

  test("an existing group's title is checked the same way before it goes on the card", async () => {
    const twoLines: PeerInfo = { id: -1009901, type: 'group', name: 'Group\nPublic link: https://t.me/x', username: null }
    const flipped: PeerInfo = { id: -1009902, type: 'group', name: 'Group ‮evil', username: null }
    tg.add(twoLines, flipped)
    for (const peer of [twoLines, flipped]) {
      const r = await svc.call('s1', 'telegram_create_chat', { type: 'channel', title: 'News', discussion: { kind: 'existing', chat: String(peer.id) } })
      expect(r.isError).toBe(true)
      expect(r.text).toContain('discussion group')
    }
    expect(svc.uiState({ create: true }).approvals).toHaveLength(0)
    expect(logs.some(l => l.startsWith('create chat asked:'))).toBe(false)
  })

  test('an existing group goes on the card by its checked title and id, without the saved nickname', async () => {
    // A nickname written by hand into config.json is never checked: it must not reach the card.
    store.update(c => {
      c.chats['qa\u202eevil'] = c.chats.qa!
      delete c.chats.qa
      c.rules.autoSend = ['qa\u202eevil']
    })
    const r = await svc.call('s1', 'telegram_create_chat', { type: 'channel', title: 'News', discussion: { kind: 'existing', chat: String(TEAM_QA.id) } })
    expect(r.isError).toBeFalsy()
    const text = svc.uiState({ create: true }).approvals[0]!.text
    expect(text).not.toContain('\u202e')
    expect(text.split('\n')).toContain(`Discussion group: "Team QA" (id ${TEAM_QA.id}), linked to it`)
  })

  test('a basic group is refused before anything is asked', async () => {
    const r = await svc.call('s1', 'telegram_create_chat', { type: 'channel', title: 'News', discussion: { kind: 'existing', chat: 'old' } })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('basic group')
    expect(svc.uiState({ create: true }).approvals).toHaveLength(0)
  })

  test('a blocked group is refused, and under defaultPolicy "block" so is a group on no list', async () => {
    store.update(c => {
      c.rules.blocked.push('qa')
    })
    const blocked = await svc.call('s1', 'telegram_create_chat', { type: 'channel', title: 'News', discussion: { kind: 'existing', chat: 'qa' } })
    expect(blocked.isError).toBe(true)
    expect(blocked.text).toContain('blocked')
    store.update(c => {
      c.rules.blocked = []
      c.defaultPolicy = 'block'
    })
    const unlisted = await svc.call('s1', 'telegram_create_chat', { type: 'channel', title: 'News', discussion: { kind: 'existing', chat: 'allhands' } })
    expect(unlisted.isError).toBe(true)
    // On a list it is fine.
    const listed = await svc.call('s1', 'telegram_create_chat', { type: 'channel', title: 'News', discussion: { kind: 'existing', chat: 'qa' } })
    expect(listed.isError).toBeFalsy()
  })

  test('blocked while it waited: refused on approval, nothing created', async () => {
    const r = await svc.call('s1', 'telegram_create_chat', { type: 'channel', title: 'News', discussion: { kind: 'existing', chat: 'qa' } })
    store.update(c => {
      c.rules.blocked.push('qa')
    })
    const res = await tray(r.approval!.id, true)
    expect(res.isError).toBe(true)
    expect(res.text).toContain('blocked now')
    expect(tg.created).toHaveLength(0)
    expect(tg.links).toHaveLength(0)
  })

  test('blocked by @username while it waited: refused on approval, nothing created', async () => {
    tg.add({ id: -1009903, type: 'group', name: 'Public Group', username: 'group' })
    const r = await svc.call('s1', 'telegram_create_chat', { type: 'channel', title: 'News', discussion: { kind: 'existing', chat: '@group' } })
    expect(r.isError).toBeFalsy()
    store.update(c => {
      c.rules.blocked.push('@group')
    })
    const res = await tray(r.approval!.id, true)
    expect(res.isError).toBe(true)
    expect(res.text).toContain('blocked now')
    expect(tg.created).toHaveLength(0)
    expect(tg.links).toHaveLength(0)
  })

  test('paused while it waited: refused on approval, nothing created', async () => {
    setup({ chatCreation: { enabled: true }, moderation: { enabled: true, moderators: [ANNA.id] } })
    trayOpen()
    const r = await svc.call('s1', 'telegram_create_chat', { type: 'channel', title: 'News', discussion: { kind: 'existing', chat: 'qa' } })
    pauses.stop({ scope: TEAM_QA.id, at: Date.now(), until: Date.now() + 60_000, by: ANNA.id, byName: ANNA.name, chatLabel: 'Team QA' })
    const res = await tray(r.approval!.id, true)
    expect(res.isError).toBe(true)
    expect(res.text).toContain('paused')
    expect(tg.created).toHaveLength(0)
    expect(logs.some(l => l.startsWith(`create chat refused after approval (discussion group ${TEAM_QA.id} paused`))).toBe(true)
  })
})

describe('telegram_create_chat: an app too old for new-chat cards', () => {
  test('with only an old app open, the request is refused', async () => {
    setup()
    svc.touchUi()
    const r = await svc.call('s1', 'telegram_create_chat', { type: 'channel', title: 'News' })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('too old')
  })

  test('an old app never sees the card and cannot approve it', async () => {
    setup()
    trayOpen()
    const r = await svc.call('s1', 'telegram_create_chat', { type: 'channel', title: 'News' })
    expect(svc.uiState().approvals).toHaveLength(0)
    expect(svc.uiState({ create: true }).approvals).toHaveLength(1)
    const old = await svc.decide(r.approval!.id, true, 'menubar', null)
    expect(old.isError).toBe(true)
    expect(old.text).toContain('too old')
    expect(tg.created).toHaveLength(0)
    // Still waiting for the new app.
    expect((await tray(r.approval!.id, true)).isError).toBeFalsy()
    expect(tg.created).toHaveLength(1)
  })
})
