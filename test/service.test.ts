import { beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Approvals } from '../src/daemon/approvals'
import { AwayResponder } from '../src/daemon/away'
import { PAGE_REASON_MAX, Service, describeMessage, pageReason } from '../src/daemon/service'
import { SessionHub } from '../src/daemon/sessions'
import { ConfigStore } from '../src/shared/config'
import { ANNA, FakeTelegram, TEAM_QA, ALL_HANDS, LEO, LEONARDO } from './fake-telegram'

const FOOTER = '\n\n✨ sᴇɴᴛ ᴠɪᴀ ᴄʟᴀᴜᴅᴇ'

let tg: FakeTelegram
let hub: SessionHub
let store: ConfigStore
let svc: Service
let path: string

function setup(config: object) {
  const dir = mkdtempSync(join(tmpdir(), 'tgmcp-'))
  path = join(dir, 'config.json')
  writeFileSync(path, JSON.stringify({ footer: FOOTER, ...config }))
  tg = new FakeTelegram().add(LEO, LEONARDO, ANNA, TEAM_QA, ALL_HANDS)
  hub = new SessionHub()
  store = new ConfigStore(path)
  svc = new Service({ store, tg, hub, approvals: new Approvals(), eventsUrl: sid => `ws://x/events?session=${sid}` })
  hub.attachProxy('s1', { label: 'one', channel: false, watches: [] }, { send() {} })
  hub.attachProxy('s2', { label: 'two', channel: false, watches: [] }, { send() {} })
  tg.onMessage(m => hub.dispatch(m, x => describeMessage(store, x)))
}

const baseConfig = {
  chats: {
    leo: { id: LEO.id, username: 'leo_p', name: LEO.name },
    leonardo: { id: LEONARDO.id, username: 'leonardo_s', name: LEONARDO.name },
    anna: { id: ANNA.id, username: 'anna_k', name: ANNA.name },
    qa: { id: TEAM_QA.id, name: 'Team QA', topicId: 42 },
    allhands: { id: ALL_HANDS.id, name: 'Company All-Hands' },
  },
  rules: { blocked: [5550001111], requireApproval: ['qa'], autoSend: ['leo', 'allhands'], autoReply: ['anna', 'leo', 'qa'] },
}

describe('sending', () => {
  beforeEach(() => setup(baseConfig))

  test('autoSend goes out at once with the footer exactly once', async () => {
    const r = await svc.call('s1', 'telegram_send_message', { to: 'leo', text: 'hi' })
    expect(r.isError).toBeFalsy()
    expect(tg.sent).toEqual([{ chatId: LEO.id, text: `hi${FOOTER}`, opts: { replyTo: undefined, topicId: undefined, parseMode: 'plain' } }])
    await svc.call('s1', 'telegram_send_message', { to: 'leo', text: `again${FOOTER}` })
    expect(tg.sent[1]!.text).toBe(`again${FOOTER}`)
  })

  test('blocked by raw id even though it is also on autoSend', async () => {
    const r = await svc.call('s1', 'telegram_send_message', { to: 'allhands', text: 'hi' })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('blocked')
    const byId = await svc.call('s1', 'telegram_send_message', { to: '-1005550001111', text: 'hi' })
    expect(byId.isError).toBe(true)
    expect(tg.sent).toHaveLength(0)
  })

  test('unknown names are refused with suggestions, never guessed', async () => {
    const r = await svc.call('s1', 'telegram_send_message', { to: 'leon', text: 'hi' })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('No saved chat called "leon"')
    expect(r.text).toContain('leonardo')
    expect(tg.sent).toHaveLength(0)
  })

  test('approval: draft, confirm once, only from the same session', async () => {
    const r = await svc.call('s1', 'telegram_send_message', { to: 'qa', text: 'please QA' })
    expect(r.approval).toBeDefined()
    expect(tg.sent).toHaveLength(0)
    const id = r.approval!.id

    const other = await svc.call('s2', 'telegram_confirm_send', { approvalId: id })
    expect(other.isError).toBe(true)
    expect(tg.sent).toHaveLength(0)

    const ok = await svc.call('s1', 'telegram_confirm_send', { approvalId: id })
    expect(ok.isError).toBeFalsy()
    expect(tg.sent).toHaveLength(1)
    expect(tg.sent[0]!.opts.topicId).toBe(42) // the nickname's default topic

    const twice = await svc.call('s1', 'telegram_confirm_send', { approvalId: id })
    expect(twice.isError).toBe(true)
    expect(tg.sent).toHaveLength(1)
  })

  test('confirm re-checks the rules: a chat blocked after drafting is not sent', async () => {
    const r = await svc.call('s1', 'telegram_send_message', { to: 'qa', text: 'x' })
    store.update(c => {
      c.rules.blocked.push('qa')
    })
    const ok = await svc.call('s1', 'telegram_confirm_send', { approvalId: r.approval!.id })
    expect(ok.isError).toBe(true)
    expect(tg.sent).toHaveLength(0)
  })

  test('autoReply sends only while this session watches the chat', async () => {
    const before = await svc.call('s1', 'telegram_send_message', { to: 'anna', text: 'x' })
    expect(before.approval).toBeDefined()
    await svc.call('s1', 'telegram_watch', { chat: 'anna' })
    const during = await svc.call('s1', 'telegram_send_message', { to: 'anna', text: 'y' })
    expect(during.approval).toBeUndefined()
    expect(tg.sent).toHaveLength(1)
    // Another session isn't watching, so it still needs approval.
    const s2 = await svc.call('s2', 'telegram_send_message', { to: 'anna', text: 'z' })
    expect(s2.approval).toBeDefined()
  })

  test('a nickname whose username changed is not sent to', async () => {
    tg.add({ ...LEO, username: 'leo_new' })
    const r = await svc.call('s1', 'telegram_send_message', { to: 'leo', text: 'x' })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('@leo_new')
    expect(tg.sent).toHaveLength(0)
    const read = await svc.call('s1', 'telegram_read_messages', { chat: 'leo' })
    expect(read.isError).toBeFalsy()
    expect(read.text).toContain('Warning')
  })

  test('a username that now belongs to a different id is refused', async () => {
    tg.uncached.add(LEO.id)
    tg.peers.delete(LEO.id)
    tg.add({ ...LEONARDO, id: 99, username: 'leo_p', name: 'Someone Else' })
    const r = await svc.call('s1', 'telegram_send_message', { to: 'leo', text: 'x' })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('Not using it')
    expect(tg.sent).toHaveLength(0)
  })
})

describe('saved chats', () => {
  beforeEach(() => setup(baseConfig))

  test('save by username stores id, username and name', async () => {
    tg.add({ id: 50, type: 'user', name: 'Nadia', username: 'nad' })
    const r = await svc.call('s1', 'telegram_save_chat', { nickname: 'Nad', chat: '@nad', aliases: ['nadia'] })
    expect(r.isError).toBeFalsy()
    const saved = JSON.parse(readFileSync(path, 'utf8')).chats.nad
    expect(saved).toMatchObject({ id: 50, username: 'nad', name: 'Nadia', type: 'user', aliases: ['nadia'] })
    const send = await svc.call('s1', 'telegram_send_message', { to: 'nadia', text: 'x' })
    expect(send.approval).toBeDefined() // in no list: default approve
  })

  test('will not repoint a nickname without overwrite', async () => {
    tg.add({ id: 51, type: 'user', name: 'Other', username: 'other' })
    const r = await svc.call('s1', 'telegram_save_chat', { nickname: 'leonardo', chat: '@other' })
    expect(r.isError).toBe(true)
    const ok = await svc.call('s1', 'telegram_save_chat', { nickname: 'leonardo', chat: '@other', overwrite: true })
    expect(ok.isError).toBeFalsy()
  })

  test('names used by the rules cannot be repointed, created or removed by a session', async () => {
    tg.add({ id: 51, type: 'user', name: 'Other', username: 'other' })
    const repoint = await svc.call('s1', 'telegram_save_chat', { nickname: 'leo', chat: '@other', overwrite: true })
    expect(repoint.isError).toBe(true)
    const remove = await svc.call('s1', 'telegram_remove_chat', { nickname: 'leo' })
    expect(remove.isError).toBe(true)
    store.update(c => {
      c.rules.autoSend.push('boss')
    })
    const sneaky = await svc.call('s1', 'telegram_save_chat', { nickname: 'x', chat: '@other', aliases: ['boss'] })
    expect(sneaky.isError).toBe(true)
    expect(JSON.parse(readFileSync(path, 'utf8')).chats.leo.id).toBe(LEO.id)
  })

  test('a nickname or alias that could break or flip a line is refused', async () => {
    tg.add({ id: 51, type: 'user', name: 'Other', username: 'other' })
    for (const nickname of ['boss\u202eevil', 'boss\u0085x', 'boss\u2028x']) {
      const r = await svc.call('s1', 'telegram_save_chat', { nickname, chat: '@other' })
      expect(r.isError).toBe(true)
    }
    const alias = await svc.call('s1', 'telegram_save_chat', { nickname: 'other', chat: '@other', aliases: ['x\u202ey'] })
    expect(alias.isError).toBe(true)
    expect(alias.text).toContain('Alias')
    expect(Object.values(JSON.parse(readFileSync(path, 'utf8')).chats).some((e: any) => e.id === 51)).toBe(false)
  })

  test('alias clashes are refused', async () => {
    tg.add({ id: 51, type: 'user', name: 'Other', username: 'other' })
    const r = await svc.call('s1', 'telegram_save_chat', { nickname: 'x', chat: '@other', aliases: ['leonardo'] })
    expect(r.isError).toBe(true)
  })
})

describe('watching', () => {
  beforeEach(() => setup(baseConfig))

  test('watch, receive via get_events, unwatch', async () => {
    const w = await svc.call('s1', 'telegram_watch', { chat: 'leo', note: 'waiting for the build link' })
    expect(w.text).toContain('Monitor')
    tg.emit(LEO.id, 'here you go')
    const e = await svc.call('s1', 'telegram_get_events', {})
    expect(e.text).toContain('here you go')
    expect(e.text).toContain('Leo Perera (@leo_p)')
    expect(e.text).toContain('[leo]')

    // Other sessions see nothing.
    expect((await svc.call('s2', 'telegram_get_events', {})).text).toBe('No new watched messages.')

    await svc.call('s1', 'telegram_unwatch', { all: true })
    tg.emit(LEO.id, 'after stop')
    expect((await svc.call('s1', 'telegram_get_events', {})).text).toBe('No new watched messages.')
  })

  test('from filter inside a group, with the nickname topic', async () => {
    tg.add({ id: 50, type: 'user', name: 'Nadia', username: 'nad' })
    await svc.call('s1', 'telegram_watch', { chat: 'qa', from: '@nad' })
    tg.emit(TEAM_QA.id, 'from someone else', LEO.id, { topicId: 42 })
    tg.emit(TEAM_QA.id, 'wrong topic', 50, { topicId: 1 })
    tg.emit(TEAM_QA.id, 'QA done', 50, { topicId: 42 })
    const e = await svc.call('s1', 'telegram_get_events', {})
    expect(e.text).toContain('QA done')
    expect(e.text).not.toContain('someone else')
    expect(e.text).not.toContain('wrong topic')
  })
})

test('invalid arguments come back as an error, not a crash', async () => {
  setup(baseConfig)
  const r = await svc.call('s1', 'telegram_send_message', { to: 'leo' })
  expect(r.isError).toBe(true)
  expect(r.text).toContain('Invalid arguments')
})

describe('autoReply subscriptions', () => {
  beforeEach(() => setup(baseConfig))

  test('only chats on the autoReply list can be watched', async () => {
    const r = await svc.call('s1', 'telegram_watch', { chat: 'leonardo' })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('not on the autoReply list')
    expect(hub.watches('s1')).toHaveLength(0)
  })

  test('every subscribed session gets every message', async () => {
    await svc.call('s1', 'telegram_watch', { chat: 'anna' })
    const second = await svc.call('s2', 'telegram_watch', { chat: 'anna' })
    expect(second.text).toContain('1 other session(s) also watch this chat')
    tg.emit(ANNA.id, 'hello both')
    expect((await svc.call('s1', 'telegram_get_events', {})).text).toContain('hello both')
    expect((await svc.call('s2', 'telegram_get_events', {})).text).toContain('hello both')
  })

  test('watching a requireApproval chat still asks before replying', async () => {
    const w = await svc.call('s1', 'telegram_watch', { chat: 'qa' })
    expect(w.text).toContain('stricter rule')
    const r = await svc.call('s1', 'telegram_send_message', { to: 'qa', text: 'x' })
    expect(r.approval).toBeDefined()
  })
})

describe('menu bar approvals and the sent log', () => {
  beforeEach(() => setup(baseConfig))

  test('the menu bar can approve any session\'s draft; waiters hear the outcome', async () => {
    svc.touchUi()
    const r = await svc.call('s1', 'telegram_send_message', { to: 'qa', text: 'QA please' })
    expect(r.approval?.uiActive).toBe(true)
    expect(r.text).toContain('menu bar')
    const waiting = svc.call('s1', '__await_approval', { approvalId: r.approval!.id })

    const state = svc.uiState()
    expect(state.approvals).toHaveLength(1)
    expect(state.approvals[0]).toMatchObject({ id: r.approval!.id, sessionLabel: 'one' })

    const decided = await svc.decide(r.approval!.id, true, 'menubar', null)
    expect(decided.text).toContain('Approved in the menu bar')
    expect((await waiting).text).toContain('Approved in the menu bar')
    expect(tg.sent).toHaveLength(1)
    expect(svc.uiState().approvals).toHaveLength(0)
  })

  test('a draft shown in the menu bar is decided there only: the dialog path is refused and it keeps waiting', async () => {
    svc.touchUi()
    const r = await svc.call('s1', 'telegram_send_message', { to: 'qa', text: 'QA please' })
    expect(r.approval?.uiActive).toBe(true)
    for (const approve of [true, false]) {
      const d = await svc.call('s1', '__decide', { approvalId: r.approval!.id, approve, remember: 'autoSend' })
      expect(d.isError).toBe(true)
      expect(d.text).toContain('menu bar')
    }
    expect(tg.sent).toHaveLength(0)
    expect(svc.uiState().approvals.map(a => a.id)).toEqual([r.approval!.id])
    expect(store.get().rules.autoSend).not.toContain('qa')
  })

  test('deny sends nothing and a second decision is refused', async () => {
    const r = await svc.call('s1', 'telegram_send_message', { to: 'qa', text: 'x' })
    expect(r.approval?.uiActive).toBe(false)
    const denied = await svc.decide(r.approval!.id, false, 'menubar', null)
    expect(denied.text).toContain('Declined in the menu bar')
    await expect(svc.decide(r.approval!.id, true, 'menubar', null)).rejects.toThrow('already declined')
    expect(tg.sent).toHaveLength(0)
  })

  test('recent sends, newest first, kept to the last 20', async () => {
    for (let i = 1; i <= 22; i++) await svc.call('s1', 'telegram_send_message', { to: 'leo', text: `m${i}` })
    const recent = svc.uiState().recent
    expect(recent).toHaveLength(20)
    expect(recent[0]!.text).toStartWith('m22')
    expect(recent[19]!.text).toStartWith('m3')
    expect(recent[0]).toMatchObject({ chatLabel: 'Leo Perera [leo]', via: 'auto', sessionLabel: 'one' })
  })
})

describe('first message to a new chat', () => {
  beforeEach(() => setup(baseConfig))
  const NEW = { id: 60, type: 'user' as const, name: 'Kasun Perera', username: 'kasun_p' }
  const saved = () => JSON.parse(readFileSync(path, 'utf8'))

  test('needs approval; "always allow" saves it and whitelists it', async () => {
    tg.add(NEW)
    const r = await svc.call('s1', 'telegram_send_message', { to: '@kasun_p', text: 'hi' })
    expect(r.approval).toMatchObject({ firstTime: true, nickname: null, suggestedNickname: 'kasun' })
    expect(r.text).toContain('First message to this chat')

    const ok = await svc.decide(r.approval!.id, true, 'menubar', null, { remember: 'autoSend' })
    expect(ok.text).toContain('Saved as "kasun" and whitelisted')
    expect(saved().chats.kasun).toMatchObject({ id: 60, username: 'kasun_p', name: 'Kasun Perera', type: 'user' })
    expect(saved().rules.autoSend).toContain('kasun')

    const next = await svc.call('s1', 'telegram_send_message', { to: 'kasun', text: 'again' })
    expect(next.approval).toBeUndefined()
    expect(tg.sent).toHaveLength(2)
  })

  test('"ask every time" saves it on requireApproval; later sends ask without the choice', async () => {
    tg.add(NEW)
    const r = await svc.call('s1', 'telegram_send_message', { to: '@kasun_p', text: 'hi' })
    await svc.decide(r.approval!.id, true, 'menubar', null, { remember: 'requireApproval', nickname: 'Kasun P' })
    expect(saved().chats['kasun p'].id).toBe(60)
    expect(saved().rules.requireApproval).toContain('kasun p')
    const next = await svc.call('s1', 'telegram_send_message', { to: 'kasun p', text: 'again' })
    expect(next.approval).toMatchObject({ firstTime: false })
  })

  test('no choice given defaults to ask every time; deny saves nothing', async () => {
    tg.add(NEW)
    const denied = await svc.call('s1', 'telegram_send_message', { to: '@kasun_p', text: 'x' })
    await svc.decide(denied.approval!.id, false, 'menubar', null, { remember: 'autoSend' })
    expect(saved().chats.kasun).toBeUndefined()
    expect(saved().rules.autoSend).not.toContain('kasun')

    const r = await svc.call('s1', 'telegram_send_message', { to: '@kasun_p', text: 'y' })
    await svc.call('s1', 'telegram_confirm_send', { approvalId: r.approval!.id })
    expect(saved().rules.requireApproval).toContain('kasun')
  })

  test('a session can never whitelist a chat by confirming in chat', async () => {
    tg.add(NEW)
    const r = await svc.call('s1', 'telegram_send_message', { to: '@kasun_p', text: 'y' })
    // An old client (or a talked-into-it model) still passing remember: it is ignored.
    const ok = await svc.call('s1', 'telegram_confirm_send', { approvalId: r.approval!.id, remember: 'autoSend' })
    expect(ok.isError).toBeFalsy()
    expect(tg.sent).toHaveLength(1)
    expect(saved().rules.autoSend).not.toContain('kasun')
    expect(saved().rules.requireApproval).toContain('kasun')
  })

  // The model cannot approve what the menu bar is asking the user.
  test('confirm_send is refused while the draft waits in the menu bar; the menu bar still decides', async () => {
    svc.touchUi()
    const r = await svc.call('s1', 'telegram_send_message', { to: 'qa', text: 'QA please' })
    expect(r.approval?.uiActive).toBe(true)
    expect(r.text).toContain('do not call telegram_confirm_send')

    const self = await svc.call('s1', 'telegram_confirm_send', { approvalId: r.approval!.id })
    expect(self.isError).toBe(true)
    expect(self.text).toContain('Only they can approve it')
    expect(tg.sent).toHaveLength(0)
    expect(svc.uiState().approvals).toHaveLength(1) // still waiting for the human

    await svc.decide(r.approval!.id, true, 'menubar', null)
    expect(tg.sent).toHaveLength(1)
  })

  test('a draft asked in chat cannot be confirmed once the menu bar comes up', async () => {
    const r = await svc.call('s1', 'telegram_send_message', { to: 'qa', text: 'x' })
    expect(r.approval?.uiActive).toBe(false)
    svc.touchUi()
    const self = await svc.call('s1', 'telegram_confirm_send', { approvalId: r.approval!.id })
    expect(self.isError).toBe(true)
    expect(tg.sent).toHaveLength(0)
  })

  test('the model may still cancel a draft the menu bar is showing', async () => {
    svc.touchUi()
    const r = await svc.call('s1', 'telegram_send_message', { to: 'qa', text: 'x' })
    const cancel = await svc.call('s1', 'telegram_cancel_send', { approvalId: r.approval!.id })
    expect(cancel.isError).toBeFalsy()
    expect(tg.sent).toHaveLength(0)
    expect(svc.uiState().approvals).toHaveLength(0)
  })

  test('a taken nickname falls back to a free one', async () => {
    tg.add({ id: 61, type: 'user', name: 'Leo Fernando', username: 'leo_f' })
    const r = await svc.call('s1', 'telegram_send_message', { to: '@leo_f', text: 'x' })
    expect(r.approval!.suggestedNickname).toBe('leo_f') // "leo" is taken
    const ok = await svc.decide(r.approval!.id, true, 'menubar', null, { remember: 'autoSend', nickname: 'leonardo' })
    expect(ok.text).toContain('"leonardo" was taken')
    expect(saved().chats.leo_f.id).toBe(61)
    expect(saved().chats.leonardo.id).toBe(LEONARDO.id)
  })

  test('an already saved chat keeps its nickname and just joins the list', async () => {
    const r = await svc.call('s1', 'telegram_send_message', { to: 'leonardo', text: 'x' })
    expect(r.approval).toMatchObject({ firstTime: true, nickname: 'leonardo' })
    await svc.decide(r.approval!.id, true, 'menubar', null, { remember: 'autoSend' })
    expect(saved().rules.autoSend).toContain('leonardo')
    expect(Object.keys(saved().chats).filter(k => saved().chats[k].id === LEONARDO.id)).toEqual(['leonardo'])
  })

  test('chats already on requireApproval are not "first time"', async () => {
    const r = await svc.call('s1', 'telegram_send_message', { to: 'qa', text: 'x' })
    expect(r.approval!.firstTime).toBe(false)
  })
})

describe('menu bar contacts', () => {
  beforeEach(() => setup(baseConfig))
  const onDisk = () => JSON.parse(readFileSync(path, 'utf8'))

  test('the state lists every saved chat with the rule that decides it', () => {
    const state = svc.uiState()
    expect(state.defaultPolicy).toBe('approve')
    const by = Object.fromEntries(state.contacts.map(c => [c.nickname, c]))
    expect(state.contacts.map(c => c.nickname)).toEqual(['allhands', 'anna', 'leo', 'leonardo', 'qa'])
    expect(by.leo).toMatchObject({ chatId: LEO.id, sendMode: 'autoSend', autoReply: true })
    expect(by.allhands).toMatchObject({ sendMode: 'blocked', autoReply: false })
    expect(by.qa).toMatchObject({ sendMode: 'requireApproval', autoReply: true, topicId: 42 })
    expect(by.leonardo).toMatchObject({ sendMode: 'none', policy: 'needs approval (default)' })
  })

  test('a sending rule change is saved and applies to the next send', async () => {
    const r = svc.editContact({ nickname: 'leo', sendMode: 'requireApproval' })
    expect(r).toMatchObject({ ok: true, nickname: 'leo' })
    expect(r.text).toContain('ask every time')
    expect(onDisk().rules.autoSend).toEqual(['allhands'])
    expect(onDisk().rules.requireApproval).toEqual(['qa', 'leo'])
    const send = await svc.call('s1', 'telegram_send_message', { to: 'leo', text: 'x' })
    expect(send.approval).toBeDefined()
    expect(tg.sent).toHaveLength(0)
  })

  test('auto-reply on and off decides who can be watched', async () => {
    expect(svc.editContact({ nickname: 'leonardo', autoReply: true }).ok).toBe(true)
    expect((await svc.call('s1', 'telegram_watch', { chat: 'leonardo' })).isError).toBeFalsy()
    expect(svc.editContact({ nickname: 'anna', autoReply: false }).text).toContain('auto-reply off')
    expect((await svc.call('s1', 'telegram_watch', { chat: 'anna' })).isError).toBe(true)
  })

  test('the reply text follows the sending rule that wins', () => {
    setup({ ...baseConfig, rules: { ...baseConfig.rules, autoReply: [] } })
    expect(svc.editContact({ nickname: 'qa', autoReply: true }).text).toBe(
      '"qa": auto-reply on: sessions may listen there, but their replies ask first (Ask every time wins).',
    )
    expect(svc.editContact({ nickname: 'qa', sendMode: 'blocked' }).text).toBe(
      `"qa": blocked: nothing is sent there; auto-reply on: sessions may listen there, but can't reply (blocked wins).`,
    )
    expect(svc.editContact({ nickname: 'qa', sendMode: 'autoSend' }).text).toBe('"qa": always allow: messages there send without asking.')
    expect(svc.editContact({ nickname: 'leonardo', rename: 'leo s' }).text).toBe('"leo s": renamed from "leonardo".')
  })

  test('renaming keeps the chat on its lists and frees the old name', async () => {
    const r = svc.editContact({ nickname: 'qa', rename: 'team-qa' })
    expect(r).toMatchObject({ ok: true, nickname: 'team-qa' })
    expect(r.text).toContain('renamed from "qa"')
    expect(onDisk().rules.requireApproval).toEqual(['team-qa'])
    expect(onDisk().rules.autoReply).toEqual(['anna', 'leo', 'team-qa'])
    expect((await svc.call('s1', 'telegram_send_message', { to: 'team-qa', text: 'x' })).approval).toBeDefined()
    expect((await svc.call('s1', 'telegram_send_message', { to: 'qa', text: 'x' })).isError).toBe(true)
  })

  test('no change writes nothing', () => {
    const text = readFileSync(path, 'utf8')
    expect(svc.editContact({ nickname: 'leo', sendMode: 'autoSend', autoReply: true, rename: 'leo' })).toMatchObject({
      ok: true,
      text: '"leo" already has that setting.',
    })
    expect(readFileSync(path, 'utf8')).toBe(text)
  })

  test('refusals leave the file alone', () => {
    const text = readFileSync(path, 'utf8')
    expect(svc.editContact({ nickname: 'nobody', sendMode: 'autoSend' })).toMatchObject({ ok: false, text: 'Not changed: No saved chat called "nobody".' })
    // Several changes are all-or-nothing: the bad rename also drops the sending change.
    const clash = svc.editContact({ nickname: 'anna', sendMode: 'blocked', rename: 'leo' })
    expect(clash.ok).toBe(false)
    expect(clash.text).toContain('already means leo')
    expect(readFileSync(path, 'utf8')).toBe(text)
  })

  test('a broken config.json is reported, not overwritten', () => {
    writeFileSync(path, '{ "rules": ')
    const r = svc.editContact({ nickname: 'leo', sendMode: 'blocked' })
    expect(r.ok).toBe(false)
    expect(readFileSync(path, 'utf8')).toBe('{ "rules": ')
  })
})

describe('paging from the Contacts page', () => {
  beforeEach(() => setup(baseConfig))
  const onDisk = () => JSON.parse(readFileSync(path, 'utf8'))

  test('"can page me" puts the person on paging.pageFrom by id', () => {
    const on = svc.editContact({ nickname: 'leo', pageFrom: true })
    expect(on).toMatchObject({ ok: true, text: '"leo": can page you: their "/page <reason>" rings your desktop.' })
    expect(onDisk().paging.pageFrom).toEqual([LEO.id])
    expect(svc.uiState().contacts.find(c => c.nickname === 'leo')).toMatchObject({ pageable: true, pageFrom: true })
    expect(svc.editContact({ nickname: 'leo', pageFrom: true }).text).toBe('"leo" already has that setting.')
    expect(svc.editContact({ nickname: 'leo', pageFrom: false }).text).toBe('"leo": can\'t page you.')
    expect(onDisk().paging.pageFrom).toEqual([])
  })

  test('a group can\'t be put on pageFrom', () => {
    const text = readFileSync(path, 'utf8')
    expect(svc.editContact({ nickname: 'qa', pageFrom: true })).toEqual({
      ok: false,
      text: 'Not changed: Only a person can page you, and "qa" is a group or channel.',
    })
    expect(readFileSync(path, 'utf8')).toBe(text)
  })

  test('the Page button sends "/page <reason>" as one line, without the footer, and logs it', async () => {
    const r = await svc.pageContact('leonardo', '  prod is down\n\nplease   look ')
    expect(r).toMatchObject({ ok: true })
    expect(r.text).toStartWith('Paged leonardo.')
    expect(tg.sent).toHaveLength(1)
    expect(tg.sent[0]).toMatchObject({ chatId: LEONARDO.id, text: '/page prod is down please look' })
    expect(svc.uiState().recent.at(-1)).toMatchObject({ chatId: LEONARDO.id, chatLabel: 'leonardo', via: 'menubar', sessionLabel: null })
  })

  test('no reason sends a bare /page', async () => {
    expect((await svc.pageContact('leo', '   ')).ok).toBe(true)
    expect(tg.sent[0]!.text).toBe('/page')
  })

  test('blocked chats, groups and unknown names are not paged', async () => {
    setup({ ...baseConfig, rules: { ...baseConfig.rules, blocked: ['anna'] } })
    expect(await svc.pageContact('anna', 'x')).toEqual({ ok: false, text: 'Not paged: "anna" is blocked (this chat is on the blocked list).' })
    expect((await svc.pageContact('qa', 'x')).text).toBe('Not paged: Only a person can be paged, and "qa" is a group or channel.')
    expect((await svc.pageContact('nobody', 'x')).text).toBe('Not paged: No saved chat called "nobody".')
    setup({ ...baseConfig, defaultPolicy: 'block' })
    expect((await svc.pageContact('leonardo', 'x')).ok).toBe(false) // on no list, and the default blocks
    expect(tg.sent).toHaveLength(0)
  })

  test('a contact whose username changed is not paged, and a block by the new @username applies', async () => {
    setup({ ...baseConfig, chats: { ...baseConfig.chats, anna: { id: ANNA.id, username: 'anna_old', name: ANNA.name } } })
    expect((await svc.pageContact('anna', 'x')).text).toContain('was @anna_old, but Telegram now says @anna_k')
    setup({ ...baseConfig, rules: { ...baseConfig.rules, blocked: ['@anna_k'] } })
    expect((await svc.pageContact('anna', 'x')).text).toBe('Not paged: "anna" is blocked (this chat is on the blocked list).')
    expect(tg.sent).toHaveLength(0)
  })

  test('a long reason is cut at a whole character', () => {
    const long = '🔥'.repeat(PAGE_REASON_MAX + 50)
    const cut = pageReason(long)
    expect(Array.from(cut)).toHaveLength(PAGE_REASON_MAX)
    expect(cut.endsWith('🔥…')).toBe(true)
    expect(pageReason('a\u202eb\u200fc')).toBe('a b c')
  })
})

describe('away in the service', () => {
  const hhmm = (offsetMs: number) => {
    const d = new Date(Date.now() + offsetMs)
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }
  const awayOn = { enabled: true, from: hhmm(-3_600_000), until: hhmm(3_600_000) }
  const onDisk = () => JSON.parse(readFileSync(path, 'utf8'))

  function withAway(config: object) {
    setup(config)
    const away: AwayResponder = new AwayResponder({
      config: () => store.get(),
      tg,
      hub,
      pages: () => [],
      record: r => svc.recordSent(r),
    })
    svc = new Service({ store, tg, hub, approvals: new Approvals(), eventsUrl: sid => `ws://x/events?session=${sid}`, away })
    hub.attachProxy('s1', { label: 'one', channel: false, watches: [] }, { send() {} })
    return away
  }

  test('a Claude send counts as you speaking', async () => {
    const away = withAway({ ...baseConfig, away: awayOn })
    await svc.call('s1', 'telegram_send_message', { to: 'leo', text: 'on it' })
    const m = { ...tg.emit(LEO.id, 'hi'), outgoing: false }
    expect(await away.onIncoming(m, false)).toBe('skipped')
  })

  test('the Page button is not you speaking', async () => {
    const away = withAway({ ...baseConfig, away: awayOn, paging: { pageFrom: [] } })
    const r = await svc.pageContact('leo', 'ping')
    expect(r.ok).toBe(true)
    expect(tg.sent).toHaveLength(1)
    const m = { ...tg.emit(LEO.id, 'hi'), outgoing: false }
    expect(await away.onIncoming(m, false)).toBe('sent')
  })

  test("the pager's fixed reply to the sender is not you speaking", async () => {
    const away = withAway({ ...baseConfig, away: awayOn })
    await svc.tellPageSender(LEO.id, 'Paging Chamodh now', null)
    expect(tg.sent).toHaveLength(1)
    const m = { ...tg.emit(LEO.id, 'hi'), outgoing: false }
    expect(await away.onIncoming(m, false)).toBe('sent')
  })

  test('editAway reports a broken config file instead of throwing', () => {
    setup(baseConfig)
    writeFileSync(path, '{ not json')
    expect(svc.editAway({ enabled: true }).ok).toBe(false)
  })

  test('editAway saves and validates', () => {
    setup(baseConfig)
    expect(svc.editAway({ enabled: true })).toMatchObject({ ok: true })
    expect(onDisk().away.enabled).toBe(true)
    const before = readFileSync(path, 'utf8')
    expect(svc.editAway({ from: 'x' }).ok).toBe(false)
    expect(readFileSync(path, 'utf8')).toBe(before)
  })

  test('editAway keeps a hand edit the store has not reloaded yet', () => {
    setup(baseConfig)
    writeFileSync(path, JSON.stringify({ footer: FOOTER, ...baseConfig, away: { message: 'typed by hand' } }))
    expect(svc.editAway({ enabled: true })).toMatchObject({ ok: true })
    expect(onDisk().away).toMatchObject({ enabled: true, schedules: [{ id: 'away', message: 'typed by hand' }] })
    // A patch that only fails against the fresh file is refused and the file kept.
    writeFileSync(path, JSON.stringify({ footer: FOOTER, ...baseConfig, away: { until: '07:00' } }))
    const before = readFileSync(path, 'utf8')
    expect(svc.editAway({ from: '07:00' })).toMatchObject({ ok: false, text: "Away: From and until can't be the same time." })
    expect(readFileSync(path, 'utf8')).toBe(before)
  })

  test('get_rules shows the away line', async () => {
    setup(baseConfig)
    const r = await svc.call('s1', 'telegram_get_rules', {})
    expect(r.text).toContain('Away auto-reply: off')
    expect(svc.uiState().away).toMatchObject({ enabled: false, active: false, nextChange: null })
  })
})

describe('editing a sent message', () => {
  beforeEach(() => setup(baseConfig))

  async function sentId(to: string, text = 'first'): Promise<number> {
    const r = await svc.call('s1', 'telegram_send_message', { to, text })
    return Number(/message #(\d+)/.exec(r.text)![1])
  }

  test('an autoSend chat gets the new text, with the footer once', async () => {
    const id = await sentId('leo')
    const r = await svc.call('s1', 'telegram_edit_message', { chat: 'leo', messageId: id, text: 'fixed' })
    expect(r.isError).toBeFalsy()
    expect(r.text).toContain(`Edited message #${id}`)
    expect(tg.edits).toEqual([{ chatId: LEO.id, messageId: id, text: `fixed${FOOTER}`, parseMode: 'plain' }])
  })

  test('after the footer changed, an edit that copied the old footer gets only the new one', async () => {
    const id = await sentId('leo')
    store.update(c => {
      c.footer = '\n\n— new'
    })
    const r = await svc.call('s1', 'telegram_edit_message', { chat: 'leo', messageId: id, text: `fixed${FOOTER}` })
    expect(r.isError).toBeFalsy()
    expect(tg.edits.at(-1)!.text).toBe('fixed\n\n— new')
    // And the next edit knows the footer is the new one now.
    await svc.call('s1', 'telegram_edit_message', { chat: 'leo', messageId: id, text: 'again\n\n— new' })
    expect(tg.edits.at(-1)!.text).toBe('again\n\n— new')
  })

  // The rule is checked at edit time: a chat that moved to Ask every time waits for a yes, one that
  // moved to Blocked is refused.
  test('a chat on ask every time waits for approval, showing the text now and the new text', async () => {
    const id = await sentId('leo')
    svc.editContact({ nickname: 'leo', sendMode: 'requireApproval' })
    svc.touchUi()
    const r = await svc.call('s1', 'telegram_edit_message', { chat: 'leo', messageId: id, text: 'fixed' })
    expect(r.isError).toBeFalsy()
    expect(r.text).toStartWith(`Not edited yet: needs the user's approval (this chat is on the requireApproval list). Approval id: ${r.approval!.id}`)
    expect(r.text).toContain(`first${FOOTER}`)
    expect(r.text).toContain('do not call telegram_confirm_send')
    expect(r.approval).toMatchObject({
      action: 'edit',
      messageId: id,
      previousText: `first${FOOTER}`,
      text: `fixed${FOOTER}`,
      uiActive: true,
      firstTime: false,
    })
    expect(svc.uiState().approvals).toEqual([
      expect.objectContaining({
        id: r.approval!.id,
        action: 'edit',
        messageId: id,
        previousText: `first${FOOTER}`,
        text: `fixed${FOOTER}`,
        to: 'Leo Perera [leo]',
        firstTime: false,
        sessionLabel: 'one',
      }),
    ])
    expect(tg.edits).toEqual([])
  })

  test('approving an edit in the menu bar makes it, and the waiting call hears so', async () => {
    const id = await sentId('leo')
    svc.editContact({ nickname: 'leo', sendMode: 'requireApproval' })
    svc.touchUi()
    const r = await svc.call('s1', 'telegram_edit_message', { chat: 'leo', messageId: id, text: 'fixed' })
    const waiting = svc.call('s1', '__await_approval', { approvalId: r.approval!.id })
    const decided = await svc.decide(r.approval!.id, true, 'menubar', null)
    expect(decided).toEqual({ text: `Approved in the menu bar. Edited message #${id} in Leo Perera [leo].` })
    expect(await waiting).toEqual(decided)
    expect(tg.edits).toEqual([{ chatId: LEO.id, messageId: id, text: `fixed${FOOTER}`, parseMode: 'plain' }])
    const rec = svc.uiState().recent[0]!
    expect(rec.text).toBe(`fixed${FOOTER}`)
    expect(rec.edited).toMatchObject({ by: 'one', original: `first${FOOTER}` })
    expect(svc.uiState().approvals).toEqual([])
  })

  test('denying an edit leaves the message as it was', async () => {
    const id = await sentId('leo')
    svc.editContact({ nickname: 'leo', sendMode: 'requireApproval' })
    const r = await svc.call('s1', 'telegram_edit_message', { chat: 'leo', messageId: id, text: 'fixed' })
    const denied = await svc.decide(r.approval!.id, false, 'menubar', null)
    expect(denied).toEqual({ text: `Declined in the menu bar: message #${id} in Leo Perera [leo] was not edited.` })
    expect(tg.edits).toEqual([])
    expect(svc.uiState().recent[0]).toMatchObject({ text: `first${FOOTER}` })
    expect(svc.uiState().recent[0]!.edited).toBeUndefined()
  })

  test('an edit nobody approves in time is not made', async () => {
    let now = 1_000_000
    const approvals = new Approvals(20 * 60_000, () => now)
    svc = new Service({ store, tg, hub, approvals, eventsUrl: () => 'ws://x' })
    const id = await sentId('leo')
    svc.editContact({ nickname: 'leo', sendMode: 'requireApproval' })
    const r = await svc.call('s1', 'telegram_edit_message', { chat: 'leo', messageId: id, text: 'fixed' })
    const waiting = svc.call('s1', '__await_approval', { approvalId: r.approval!.id })
    now += 21 * 60_000
    approvals.sweep()
    expect(await waiting).toEqual({
      text: `Nobody approved the edit of message #${id} in Leo Perera [leo] within 20 minutes. It was not edited.`,
      isError: true,
    })
    expect(tg.edits).toEqual([])
  })

  test('a chat blocked while the edit waited is refused when it is approved', async () => {
    const id = await sentId('leo')
    svc.editContact({ nickname: 'leo', sendMode: 'requireApproval' })
    const r = await svc.call('s1', 'telegram_edit_message', { chat: 'leo', messageId: id, text: 'fixed' })
    svc.editContact({ nickname: 'leo', sendMode: 'blocked' })
    const decided = await svc.decide(r.approval!.id, true, 'menubar', null)
    expect(decided).toEqual({ text: 'Not edited in Leo Perera [leo]: this chat is on the blocked list.', isError: true })
    expect(tg.edits).toEqual([])
  })

  test('with no menu bar, the session confirms after the user says yes in chat; only that session can', async () => {
    const id = await sentId('leo')
    svc.editContact({ nickname: 'leo', sendMode: 'requireApproval' })
    const r = await svc.call('s1', 'telegram_edit_message', { chat: 'leo', messageId: id, text: 'fixed' })
    expect(r.approval?.uiActive).toBe(false)
    expect(r.text).toContain('call telegram_confirm_send with the approval id')
    expect((await svc.call('s2', 'telegram_confirm_send', { approvalId: r.approval!.id })).text).toContain('belongs to another session')
    const ok = await svc.call('s1', 'telegram_confirm_send', { approvalId: r.approval!.id })
    expect(ok.text).toBe(`Approved in chat. Edited message #${id} in Leo Perera [leo].`)
    expect(tg.edits).toHaveLength(1)
  })

  test('cancelling an edit leaves the message as it was', async () => {
    const id = await sentId('leo')
    svc.editContact({ nickname: 'leo', sendMode: 'requireApproval' })
    const r = await svc.call('s1', 'telegram_edit_message', { chat: 'leo', messageId: id, text: 'fixed' })
    const no = await svc.call('s1', 'telegram_cancel_send', { approvalId: r.approval!.id })
    expect(no.text).toBe(`Declined in chat: message #${id} in Leo Perera [leo] was not edited.`)
    expect(tg.edits).toEqual([])
  })

  // An autoReply chat the session no longer watches asks before a send, like a chat on no list;
  // approving an edit there must not put it on a list, as a first message would.
  test('approving an edit never changes the rules lists', async () => {
    await svc.call('s1', 'telegram_watch', { chat: 'anna' })
    const id = await sentId('anna')
    await svc.call('s1', 'telegram_unwatch', { all: true })
    const r = await svc.call('s1', 'telegram_edit_message', { chat: 'anna', messageId: id, text: 'fixed' })
    expect(r.approval).toMatchObject({ action: 'edit', firstTime: false })
    const before = readFileSync(path, 'utf8')
    const ok = await svc.decide(r.approval!.id, true, 'menubar', null, { remember: 'autoSend', nickname: 'x' })
    expect(ok.text).toBe(`Approved in the menu bar. Edited message #${id} in Anna K [anna].`)
    expect(readFileSync(path, 'utf8')).toBe(before)
  })

  test('daemon.log has the ask and what came of it', async () => {
    const logs: string[] = []
    svc = new Service({ store, tg, hub, approvals: new Approvals(), eventsUrl: () => 'ws://x', log: m => logs.push(m) })
    const id = await sentId('leo')
    svc.editContact({ nickname: 'leo', sendMode: 'requireApproval' })
    const yes = await svc.call('s1', 'telegram_edit_message', { chat: 'leo', messageId: id, text: 'fixed' })
    await svc.decide(yes.approval!.id, true, 'menubar', null)
    const no = await svc.call('s1', 'telegram_edit_message', { chat: 'leo', messageId: id, text: 'again' })
    await svc.decide(no.approval!.id, false, 'menubar', null)
    expect(logs).toEqual([
      `edit asked: message #${id} in Leo Perera [leo] (${LEO.id}) by one, waiting for approval (${yes.approval!.id})`,
      `edit: message #${id} in Leo Perera [leo] (${LEO.id}) by one, approved in the menu bar`,
      `edit asked: message #${id} in Leo Perera [leo] (${LEO.id}) by one, waiting for approval (${no.approval!.id})`,
      `edit declined in the menu bar: message #${id} in Leo Perera [leo] (${LEO.id}) by one`,
    ])
  })

  test('a chat moved to blocked after the send is refused by its rule', async () => {
    const id = await sentId('leo')
    svc.editContact({ nickname: 'leo', sendMode: 'blocked' })
    const r = await svc.call('s1', 'telegram_edit_message', { chat: 'leo', messageId: id, text: 'fixed' })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('blocked list')
    expect(tg.edits).toEqual([])
  })

  test('a message no session sent is refused', async () => {
    const r = await svc.call('s1', 'telegram_edit_message', { chat: 'leo', messageId: 99999, text: 'fixed' })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('not one a Claude session sent there')
    expect(tg.edits).toEqual([])
  })

  test("the Page button's message is the user's own words and can't be edited", async () => {
    expect((await svc.pageContact('leo', 'prod is down, call me')).ok).toBe(true)
    const id = svc.uiState().recent[0]!.messageId
    const r = await svc.call('s1', 'telegram_edit_message', { chat: 'leo', messageId: id, text: 'never mind, all good' })
    expect(r.isError).toBe(true)
    expect(tg.edits).toEqual([])
  })

  test("the pager's fixed reply and an away reply can't be edited", async () => {
    await svc.tellPageSender(LEO.id, 'Paging Iddhi now.', null)
    const pager = svc.uiState().recent[0]!.messageId
    svc.recordSent({ chatId: LEO.id, chatLabel: 'Leo', text: 'away', messageId: 4242, via: 'away', sessionLabel: null })
    for (const messageId of [pager, 4242]) {
      const r = await svc.call('s1', 'telegram_edit_message', { chat: 'leo', messageId, text: 'x' })
      expect(r.isError).toBe(true)
    }
    expect(tg.edits).toEqual([])
  })

  test("another session's message is refused", async () => {
    const id = await sentId('leo')
    const r = await svc.call('s2', 'telegram_edit_message', { chat: 'leo', messageId: id, text: 'rewritten' })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('sent by another session (one)')
    expect(tg.edits).toEqual([])
  })

  test('a file is refused: only text messages can be edited', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'tgmcp-')), 'report.pdf')
    writeFileSync(file, '%PDF-1.7 hello')
    const asked = await svc.call('s1', 'telegram_send_file', { to: 'leo', path: file, caption: 'Q3' })
    const sent = await svc.call('s1', '__decide', { approvalId: asked.approval!.id, approve: true })
    const id = Number(/message #(\d+)/.exec(sent.text)![1])
    const r = await svc.call('s1', 'telegram_edit_message', { chat: 'leo', messageId: id, text: 'new caption' })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('Only text messages')
    expect(tg.edits).toEqual([])
  })

  test('a caption that the footer takes past 1024 characters is refused before anything goes', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'tgmcp-')), 'report.pdf')
    writeFileSync(file, '%PDF-1.7 hello')
    const before = tg.sent.length
    const r = await svc.call('s1', 'telegram_send_file', { to: 'leo', path: file, caption: 'x'.repeat(1020) })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('Telegram allows 1024 under a file')
    expect(tg.sent.length).toBe(before)
    const ok = await svc.call('s1', 'telegram_send_file', { to: 'leo', path: file, caption: 'x'.repeat(900) })
    expect(ok.isError).toBeFalsy()
    expect(ok.approval).toBeDefined()
  })

  test('text that starts with /reply is refused', async () => {
    const id = await sentId('leo')
    const r = await svc.call('s1', 'telegram_edit_message', { chat: 'leo', messageId: id, text: '/reply stop' })
    expect(r.isError).toBe(true)
    expect(tg.edits).toEqual([])
  })

  test('Recently sent marks the edit and keeps the original; the log has a line', async () => {
    const logs: string[] = []
    svc = new Service({ store, tg, hub, approvals: new Approvals(), eventsUrl: () => 'ws://x', log: m => logs.push(m) })
    const id = await sentId('leo', 'first')
    await svc.call('s1', 'telegram_edit_message', { chat: 'leo', messageId: id, text: 'second' })
    await svc.call('s1', 'telegram_edit_message', { chat: 'leo', messageId: id, text: 'third' })
    const rec = svc.uiState().recent[0]!
    expect(rec.text).toBe(`third${FOOTER}`)
    expect(rec.edited).toMatchObject({ by: 'one', original: `first${FOOTER}` })
    expect(logs.filter(l => l.startsWith(`edit: message #${id}`))).toHaveLength(2)
  })

  test("after a restart, the session can still edit its message (recent.json keeps who sent it)", async () => {
    const recentPath = join(mkdtempSync(join(tmpdir(), 'tgmcp-')), 'recent.json')
    svc = new Service({ store, tg, hub, approvals: new Approvals(), eventsUrl: () => 'ws://x', recentPath })
    const id = await sentId('leo')
    svc = new Service({ store, tg, hub, approvals: new Approvals(), eventsUrl: () => 'ws://x', recentPath })
    expect((await svc.call('s1', 'telegram_edit_message', { chat: 'leo', messageId: id, text: 'fixed' })).isError).toBeFalsy()
    expect((await svc.call('s2', 'telegram_edit_message', { chat: 'leo', messageId: id, text: 'nope' })).isError).toBe(true)
  })
})

// An edit or delete where sending needs approval runs only after a yes for that exact change, and
// only once: no deny, timeout, retry or replayed approval id gets around it.
describe('edit and delete approvals cannot be skipped', () => {
  let now: number
  let approvals: Approvals
  let logs: string[]
  const TTL = 20 * 60_000

  beforeEach(() => {
    setup(baseConfig)
    now = 1_000_000
    approvals = new Approvals(TTL, () => now)
    logs = []
    svc = new Service({ store, tg, hub, approvals, eventsUrl: () => 'ws://x', log: m => logs.push(m) })
  })

  /** Messages s1 sent to leo, which then moved to Ask every time. */
  async function ownMessages(...texts: string[]): Promise<number[]> {
    const ids: number[] = []
    for (const text of texts) {
      const r = await svc.call('s1', 'telegram_send_message', { to: 'leo', text })
      ids.push(Number(/message #(\d+)/.exec(r.text)![1]))
    }
    svc.editContact({ nickname: 'leo', sendMode: 'requireApproval' })
    return ids
  }
  const ownMessage = async () => (await ownMessages('first'))[0]!

  const CHANGES = [
    ['telegram_edit_message', 'edit'],
    ['telegram_delete_message', 'delete'],
  ] as const
  const args = (messageId: number, text = 'fixed') => ({ chat: 'leo', messageId, text })
  const nothingChanged = () => {
    expect(tg.edits).toEqual([])
    expect(tg.deleted).toEqual([])
  }

  for (const [tool, action] of CHANGES) {
    test(`a denied ${action} changes nothing: not the chat, Recently sent or the rules`, async () => {
      const id = await ownMessage()
      const rules = readFileSync(path, 'utf8')
      const before = svc.uiState().recent
      for (const deny of [
        (approvalId: string) => svc.decide(approvalId, false, 'menubar', null),
        (approvalId: string) => svc.decide(approvalId, false, 'dialog', 's1'),
        (approvalId: string) => svc.call('s1', 'telegram_cancel_send', { approvalId }),
      ]) {
        const r = await svc.call('s1', tool, args(id))
        expect(r.approval).toMatchObject({ action })
        expect((await deny(r.approval!.id)).text).toContain(`was not ${action === 'edit' ? 'edited' : 'deleted'}`)
      }
      nothingChanged()
      expect(svc.uiState().recent).toEqual(before)
      expect(readFileSync(path, 'utf8')).toBe(rules)
      expect(svc.uiState().approvals).toEqual([])
    })

    test(`a timed-out ${action} changes nothing, and its id can't be approved afterwards`, async () => {
      const id = await ownMessage()
      const before = svc.uiState().recent
      const swept = await svc.call('s1', tool, args(id))
      const unswept = await svc.call('s1', tool, args(id))
      now += TTL + 1
      // Expired but not swept yet: approving it is refused just the same.
      await expect(svc.decide(unswept.approval!.id, true, 'menubar', null)).rejects.toThrow('No pending message')
      approvals.sweep()
      await expect(svc.decide(swept.approval!.id, true, 'menubar', null)).rejects.toThrow('already declined')
      for (const approvalId of [swept.approval!.id, unswept.approval!.id]) {
        expect((await svc.call('s1', 'telegram_confirm_send', { approvalId })).isError).toBe(true)
      }
      nothingChanged()
      expect(svc.uiState().recent).toEqual(before)
    })

    test(`a timed-out ${action} gets a line in daemon.log`, async () => {
      const id = await ownMessage()
      await svc.call('s1', tool, args(id))
      now += TTL + 1
      svc.sweepApprovals()
      expect(logs.filter(l => l.startsWith(`${action} expired`) && l.includes(`message #${id}`))).toHaveLength(1)
    })

    test(`retrying ${action === 'edit' ? 'an edit' : 'a delete'} asks again every time, never runs without a yes`, async () => {
      const id = await ownMessage()
      const ids: string[] = []
      const retry = async () => {
        const r = await svc.call('s1', tool, args(id))
        expect(r.isError).toBeFalsy()
        expect(r.text).toStartWith(`Not ${action === 'edit' ? 'edited' : 'deleted'} yet: needs the user's approval`)
        expect(r.approval).toMatchObject({ action, messageId: id })
        ids.push(r.approval!.id)
        return r.approval!.id
      }
      const first = await retry()
      await retry() // while the first still waits: a second card, not a run
      expect(svc.uiState().approvals.map(a => a.id)).toEqual(ids)
      await svc.decide(first, false, 'menubar', null)
      await retry() // after a deny
      now += TTL + 1
      approvals.sweep()
      await retry() // after a timeout
      expect(new Set(ids).size).toBe(4)
      nothingChanged()
    })

    test(`an approved ${action} runs once: a second approval of the same id, at the same moment or later, is refused`, async () => {
      const id = await ownMessage()
      const r = await svc.call('s1', tool, args(id))
      const both = await Promise.allSettled([
        svc.decide(r.approval!.id, true, 'menubar', null),
        svc.decide(r.approval!.id, true, 'menubar', null),
      ])
      expect(both.map(x => x.status).sort()).toEqual(['fulfilled', 'rejected'])
      await expect(svc.decide(r.approval!.id, true, 'menubar', null)).rejects.toThrow('already approved')
      expect((await svc.call('s1', 'telegram_confirm_send', { approvalId: r.approval!.id })).isError).toBe(true)
      expect(tg.edits.length + tg.deleted.length).toBe(1)
    })
  }

  test('an approval id makes only the edit it was asked for, whatever is passed with it', async () => {
    const id = await ownMessage()
    const one = await svc.call('s1', 'telegram_edit_message', args(id, 'one'))
    const two = await svc.call('s1', 'telegram_edit_message', args(id, 'two'))
    // Extra arguments to confirm are not part of its input: they can't swap the text or the message.
    const ok = await svc.call('s1', 'telegram_confirm_send', { approvalId: one.approval!.id, text: 'evil', messageId: 1, chat: 'anna' })
    expect(ok.text).toBe(`Approved in chat. Edited message #${id} in Leo Perera [leo].`)
    expect(tg.edits).toEqual([{ chatId: LEO.id, messageId: id, text: `one${FOOTER}`, parseMode: 'plain' }])
    // The other ask is still its own, with its own text.
    expect(svc.uiState().approvals).toEqual([expect.objectContaining({ id: two.approval!.id, text: `two${FOOTER}`, previousText: `one${FOOTER}` })])
  })

  test("an approval id deletes only the message it was asked for", async () => {
    const [keep, gone] = (await ownMessages('keep me', 'take me back')) as [number, number]
    const r = await svc.call('s1', 'telegram_delete_message', { chat: 'leo', messageId: gone })
    await svc.call('s1', 'telegram_confirm_send', { approvalId: r.approval!.id, messageId: keep })
    expect(tg.deleted).toEqual([{ chatId: LEO.id, messageId: gone }])
    expect(svc.uiState().recent.map(x => x.messageId)).toEqual([keep])
  })

  test("an edit's approval id can't approve anything else once used: not a later edit, not a delete", async () => {
    const id = await ownMessage()
    const edit = await svc.call('s1', 'telegram_edit_message', args(id, 'one'))
    await svc.decide(edit.approval!.id, true, 'menubar', null)
    const later = await svc.call('s1', 'telegram_edit_message', args(id, 'two'))
    const del = await svc.call('s1', 'telegram_delete_message', { chat: 'leo', messageId: id })
    expect((await svc.call('s1', 'telegram_confirm_send', { approvalId: edit.approval!.id })).isError).toBe(true)
    expect(tg.edits).toHaveLength(1)
    expect(tg.deleted).toEqual([])
    expect(svc.uiState().approvals.map(a => a.id)).toEqual([later.approval!.id, del.approval!.id])
  })
})

describe('who has read a message', () => {
  beforeEach(() => setup(baseConfig))

  test('a private chat says whether the other person has read it', async () => {
    tg.readStatuses.set(`${LEO.id}:10`, { kind: 'private', seen: true })
    tg.readStatuses.set(`${LEO.id}:11`, { kind: 'private', seen: false })
    const read = await svc.call('s1', 'telegram_message_readers', { chat: 'leo', messageId: 10 })
    expect(read.isError).toBeFalsy()
    expect(read.text).toContain(`read by ${LEO.name}`)
    expect(read.text).not.toContain('not read')
    const unread = await svc.call('s1', 'telegram_message_readers', { chat: 'leo', messageId: 11 })
    expect(unread.text).toContain('not read by')
    expect(unread.text).toContain('hides read receipts')
  })

  test('a group lists who read it and when', async () => {
    tg.readStatuses.set(`${TEAM_QA.id}:5`, {
      kind: 'group',
      readers: [
        { id: 1, name: 'Anna', username: 'anna_k', at: '2026-11-03T10:00:00.000Z' },
        { id: 2, name: 'Bo', username: null, at: '2026-11-03T10:05:00.000Z' },
      ],
    })
    const r = await svc.call('s1', 'telegram_message_readers', { chat: 'qa', messageId: 5 })
    expect(r.text).toContain('read by 2')
    expect(r.text).toContain('Anna (@anna_k) · 2026-11-03T10:00:00.000Z')
    expect(r.text).toContain('• Bo · 2026-11-03T10:05:00.000Z')
  })

  test('a group nobody has read says so, and that hidden receipts are not listed', async () => {
    tg.readStatuses.set(`${TEAM_QA.id}:6`, { kind: 'group', readers: [] })
    const r = await svc.call('s1', 'telegram_message_readers', { chat: 'qa', messageId: 6 })
    expect(r.text).toContain('nobody is shown as having read it')
  })

  test("a message that isn't yours, or isn't there, is an error", async () => {
    const r = await svc.call('s1', 'telegram_message_readers', { chat: 'leo', messageId: 999 })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('only your own messages have read receipts')
  })

  test('it only reads: nothing is sent, edited or deleted', async () => {
    tg.readStatuses.set(`${LEO.id}:10`, { kind: 'private', seen: true })
    await svc.call('s1', 'telegram_message_readers', { chat: 'leo', messageId: 10 })
    expect(tg.sent).toEqual([])
    expect(tg.deleted).toEqual([])
    expect(tg.edits).toEqual([])
  })
})

describe('deleting a sent message', () => {
  beforeEach(() => setup(baseConfig))

  async function sentId(to: string, text = 'first'): Promise<number> {
    const r = await svc.call('s1', 'telegram_send_message', { to, text })
    return Number(/message #(\d+)/.exec(r.text)![1])
  }

  test('the sending session deletes its own message; it leaves Recently sent and the log has a line', async () => {
    const logs: string[] = []
    svc = new Service({ store, tg, hub, approvals: new Approvals(), eventsUrl: () => 'ws://x', log: m => logs.push(m) })
    const id = await sentId('leo')
    const r = await svc.call('s1', 'telegram_delete_message', { chat: 'leo', messageId: id })
    expect(r.isError).toBeFalsy()
    expect(r.text).toContain(`Deleted message #${id}`)
    expect(tg.deleted).toEqual([{ chatId: LEO.id, messageId: id }])
    expect(svc.uiState().recent.some(x => x.messageId === id)).toBe(false)
    expect(logs.filter(l => l.startsWith(`delete: message #${id}`))).toHaveLength(1)
  })

  test('a deleted message cannot be edited or deleted again', async () => {
    const id = await sentId('leo')
    await svc.call('s1', 'telegram_delete_message', { chat: 'leo', messageId: id })
    expect((await svc.call('s1', 'telegram_edit_message', { chat: 'leo', messageId: id, text: 'x' })).isError).toBe(true)
    expect((await svc.call('s1', 'telegram_delete_message', { chat: 'leo', messageId: id })).isError).toBe(true)
    expect(tg.deleted).toHaveLength(1)
    expect(tg.edits).toEqual([])
  })

  test('a chat moved to blocked after the send is refused by its rule', async () => {
    const id = await sentId('leo')
    svc.editContact({ nickname: 'leo', sendMode: 'blocked' })
    const r = await svc.call('s1', 'telegram_delete_message', { chat: 'leo', messageId: id })
    expect(r).toEqual({ text: 'Not deleted in Leo Perera [leo]: this chat is on the blocked list.', isError: true })
    expect(tg.deleted).toEqual([])
    expect(svc.uiState().approvals).toEqual([])
  })

  test('a chat on ask every time waits for approval, showing the message to remove', async () => {
    const id = await sentId('leo')
    svc.editContact({ nickname: 'leo', sendMode: 'requireApproval' })
    svc.touchUi()
    const r = await svc.call('s1', 'telegram_delete_message', { chat: 'leo', messageId: id })
    expect(r.isError).toBeFalsy()
    expect(r.text).toStartWith(`Not deleted yet: needs the user's approval (this chat is on the requireApproval list). Approval id: ${r.approval!.id}`)
    expect(r.text).toContain(`first${FOOTER}`)
    expect(r.approval).toMatchObject({ action: 'delete', messageId: id, text: `first${FOOTER}`, uiActive: true, firstTime: false })
    expect(svc.uiState().approvals).toEqual([
      expect.objectContaining({ action: 'delete', messageId: id, text: `first${FOOTER}`, previousText: null, to: 'Leo Perera [leo]', firstTime: false }),
    ])
    expect(tg.deleted).toEqual([])
  })

  test('approving a delete removes the message, from the chat and from Recently sent', async () => {
    const logs: string[] = []
    svc = new Service({ store, tg, hub, approvals: new Approvals(), eventsUrl: () => 'ws://x', log: m => logs.push(m) })
    const id = await sentId('leo')
    svc.editContact({ nickname: 'leo', sendMode: 'requireApproval' })
    svc.touchUi()
    const r = await svc.call('s1', 'telegram_delete_message', { chat: 'leo', messageId: id })
    const waiting = svc.call('s1', '__await_approval', { approvalId: r.approval!.id })
    const decided = await svc.decide(r.approval!.id, true, 'menubar', null)
    expect(decided).toEqual({ text: `Approved in the menu bar. Deleted message #${id} in Leo Perera [leo].` })
    expect(await waiting).toEqual(decided)
    expect(tg.deleted).toEqual([{ chatId: LEO.id, messageId: id }])
    expect(svc.uiState().recent.some(x => x.messageId === id)).toBe(false)
    expect(logs).toEqual([
      `delete asked: message #${id} in Leo Perera [leo] (${LEO.id}) by one, waiting for approval (${r.approval!.id})`,
      `delete: message #${id} in Leo Perera [leo] (${LEO.id}) by one, approved in the menu bar`,
    ])
  })

  test('denying a delete keeps the message', async () => {
    const id = await sentId('leo')
    svc.editContact({ nickname: 'leo', sendMode: 'requireApproval' })
    const r = await svc.call('s1', 'telegram_delete_message', { chat: 'leo', messageId: id })
    expect(r.text).toContain('call telegram_confirm_send with the approval id')
    const denied = await svc.decide(r.approval!.id, false, 'menubar', null)
    expect(denied).toEqual({ text: `Declined in the menu bar: message #${id} in Leo Perera [leo] was not deleted.` })
    expect(tg.deleted).toEqual([])
    expect(svc.uiState().recent.some(x => x.messageId === id)).toBe(true)
  })

  test('a delete nobody approves in time is not made', async () => {
    let now = 1_000_000
    const approvals = new Approvals(20 * 60_000, () => now)
    svc = new Service({ store, tg, hub, approvals, eventsUrl: () => 'ws://x' })
    const id = await sentId('leo')
    svc.editContact({ nickname: 'leo', sendMode: 'requireApproval' })
    const r = await svc.call('s1', 'telegram_delete_message', { chat: 'leo', messageId: id })
    const waiting = svc.call('s1', '__await_approval', { approvalId: r.approval!.id })
    now += 21 * 60_000
    approvals.sweep()
    expect(await waiting).toEqual({
      text: `Nobody approved deleting message #${id} in Leo Perera [leo] within 20 minutes. It was not deleted.`,
      isError: true,
    })
    expect(tg.deleted).toEqual([])
  })

  test('a message no session sent is refused', async () => {
    const r = await svc.call('s1', 'telegram_delete_message', { chat: 'leo', messageId: 99999 })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('not one a Claude session sent there')
    expect(tg.deleted).toEqual([])
  })

  test("the Page button's message, the pager's reply and an away reply can't be deleted", async () => {
    expect((await svc.pageContact('leo', 'prod is down, call me')).ok).toBe(true)
    const page = svc.uiState().recent[0]!.messageId
    await svc.tellPageSender(LEO.id, 'Paging Iddhi now.', null)
    const pager = svc.uiState().recent[0]!.messageId
    svc.recordSent({ chatId: LEO.id, chatLabel: 'Leo', text: 'away', messageId: 4242, via: 'away', sessionLabel: null })
    for (const messageId of [page, pager, 4242]) {
      expect((await svc.call('s1', 'telegram_delete_message', { chat: 'leo', messageId })).isError).toBe(true)
    }
    expect(tg.deleted).toEqual([])
  })

  test("another session's message is refused", async () => {
    const id = await sentId('leo')
    const r = await svc.call('s2', 'telegram_delete_message', { chat: 'leo', messageId: id })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('sent by another session (one)')
    expect(tg.deleted).toEqual([])
  })

  test('a file the session sent can be deleted, with the same yes a file needs', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'tgmcp-')), 'report.pdf')
    writeFileSync(file, '%PDF-1.7 hello')
    const asked = await svc.call('s1', 'telegram_send_file', { to: 'leo', path: file, caption: 'Q3' })
    const sent = await svc.call('s1', '__decide', { approvalId: asked.approval!.id, approve: true })
    const id = Number(/message #(\d+)/.exec(sent.text)![1])
    const r = await svc.call('s1', 'telegram_delete_message', { chat: 'leo', messageId: id })
    expect(r.approval).toMatchObject({ action: 'delete', messageId: id })
    expect(tg.deleted).toEqual([])
    expect((await svc.call('s1', 'telegram_confirm_send', { approvalId: r.approval!.id })).isError).toBeFalsy()
    expect(tg.deleted).toEqual([{ chatId: LEO.id, messageId: id }])
  })

  test('a file in a chat the session watches follows the file rule and asks, a text message there does not', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'tgmcp-')), 'report.pdf')
    writeFileSync(file, '%PDF-1.7 hello')
    const asked = await svc.call('s1', 'telegram_send_file', { to: 'leo', path: file, caption: 'Q3' })
    const sent = await svc.call('s1', '__decide', { approvalId: asked.approval!.id, approve: true })
    const fileId = Number(/message #(\d+)/.exec(sent.text)![1])
    const textId = await sentId('leo')
    await svc.call('s1', 'telegram_watch', { chat: 'leo' })
    const r = await svc.call('s1', 'telegram_delete_message', { chat: 'leo', messageId: fileId })
    expect(r.isError).toBeFalsy()
    expect(r.text).toContain('files always need approval')
    expect(r.approval).toMatchObject({ action: 'delete', messageId: fileId })
    expect((await svc.call('s1', 'telegram_delete_message', { chat: 'leo', messageId: textId })).isError).toBeFalsy()
    expect(tg.deleted).toEqual([{ chatId: LEO.id, messageId: textId }])
  })

  test("a message no session sent is refused without asking, also where sending needs approval", async () => {
    const r = await svc.call('s1', 'telegram_delete_message', { chat: 'qa', messageId: 1 })
    expect(r.isError).toBe(true)
    expect(r.approval).toBeUndefined()
    expect(tg.deleted).toEqual([])
    expect(svc.uiState().approvals).toEqual([])
  })

  test("in a chat that needs approval, another session's message is refused without asking", async () => {
    const id = await sentId('leo')
    svc.editContact({ nickname: 'leo', sendMode: 'requireApproval' })
    for (const tool of ['telegram_delete_message', 'telegram_edit_message']) {
      const r = await svc.call('s2', tool, { chat: 'leo', messageId: id, text: 'x' })
      expect(r.isError).toBe(true)
      expect(r.text).toContain('sent by another session (one)')
    }
    expect(svc.uiState().approvals).toEqual([])
  })

  test('after a restart, the session can still delete its message but another session cannot', async () => {
    const recentPath = join(mkdtempSync(join(tmpdir(), 'tgmcp-')), 'recent.json')
    svc = new Service({ store, tg, hub, approvals: new Approvals(), eventsUrl: () => 'ws://x', recentPath })
    const id = await sentId('leo')
    svc = new Service({ store, tg, hub, approvals: new Approvals(), eventsUrl: () => 'ws://x', recentPath })
    expect((await svc.call('s2', 'telegram_delete_message', { chat: 'leo', messageId: id })).isError).toBe(true)
    expect((await svc.call('s1', 'telegram_delete_message', { chat: 'leo', messageId: id })).isError).toBeFalsy()
  })
})

describe('listing chats by kind', () => {
  const BOT = { id: 77, type: 'bot' as const, name: 'Helper Bot', username: 'helper_bot' }
  const NEWS = { id: -1009990001111, type: 'channel' as const, name: 'Acme News', username: 'acme_news' }
  beforeEach(() => {
    setup(baseConfig)
    tg.add(BOT, NEWS)
    tg.unread.set(ANNA.id, 3).set(TEAM_QA.id, 7)
  })
  const names = (text: string) => text.split('\n').filter(l => l.startsWith('• ')).map(l => l.slice(2).split(' · ')[0])

  test('all chats by default, in Telegram order', async () => {
    const r = await svc.call('s1', 'telegram_list_chats', {})
    expect(names(r.text)).toEqual([LEO.name, LEONARDO.name, ANNA.name, TEAM_QA.name, ALL_HANDS.name, BOT.name, NEWS.name])
  })

  test('filters private chats, groups, channels and bots', async () => {
    expect(names((await svc.call('s1', 'telegram_list_chats', { type: 'private' })).text)).toEqual([LEO.name, LEONARDO.name, ANNA.name])
    expect(names((await svc.call('s1', 'telegram_list_chats', { type: 'groups' })).text)).toEqual([TEAM_QA.name, ALL_HANDS.name])
    expect(names((await svc.call('s1', 'telegram_list_chats', { type: 'channels' })).text)).toEqual([NEWS.name])
    expect(names((await svc.call('s1', 'telegram_list_chats', { type: 'bots' })).text)).toEqual([BOT.name])
    expect((await svc.call('s1', 'telegram_list_chats', { type: 'channels', unreadOnly: true })).text).toBe('No unread channels.')
  })

  test('sorts by unread count or by name', async () => {
    const byUnread = await svc.call('s1', 'telegram_list_chats', { sort: 'unread' })
    expect(names(byUnread.text).slice(0, 3)).toEqual([TEAM_QA.name, ANNA.name, LEO.name])
    const byName = await svc.call('s1', 'telegram_list_chats', { type: 'private', sort: 'name' })
    expect(names(byName.text)).toEqual([ANNA.name, LEO.name, LEONARDO.name])
  })

  test('categorize groups the list under a heading per kind', async () => {
    const r = await svc.call('s1', 'telegram_list_chats', { categorize: true, sort: 'name' })
    const headings = r.text.split('\n').filter(l => l && !l.startsWith('• '))
    expect(headings).toEqual(['Private chats (3, 3 unread)', 'Groups (2, 7 unread)', 'Channels (1)', 'Bots (1)'])
    expect(r.text).toContain(`Groups (2, 7 unread)\n• ${ALL_HANDS.name}`)
  })
})
