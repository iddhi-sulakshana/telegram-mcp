import {
  RULE_LISTS,
  isListed,
  normalizeNickname,
  refMatches,
  resolveRef,
  rulesMentioning,
  validateNickname,
  type ChatEntry,
  type ChatKey,
  type Config,
  type RuleList,
} from './config'
import { policyLabel } from './policy'
import type { SendMode, UiContact } from './protocol'

/**
 * The Contacts page of the menu bar app: every saved chat, and the edits a human can make there
 * (which list decides sending, whether sessions may auto-reply, the nickname). These run only for
 * the menu bar, never as a tool: sessions still can't change the rules.
 *
 * Each function mutates the config it is given, so the daemon runs them inside ConfigStore.update.
 */

export const SEND_MODES: readonly SendMode[] = ['autoSend', 'requireApproval', 'blocked', 'none']
const SENDING_LISTS = ['blocked', 'requireApproval', 'autoSend'] as const satisfies readonly RuleList[]

/** The saved key for a nickname: exact first, then a hand-edited key that differs only in case or spacing. */
function keyFor(config: Config, nickname: string): string {
  if (config.chats[nickname]) return nickname
  const n = normalizeNickname(nickname)
  const key = Object.keys(config.chats).find(k => normalizeNickname(k) === n)
  if (!key) throw new Error(`No saved chat called "${nickname}".`)
  return key
}

function chatKey(config: Config, key: string, meId?: number): ChatKey {
  const e = config.chats[key]!
  return { id: e.id, username: e.username, isSelf: meId !== undefined && e.id === meId }
}

export function sendModeOf(config: Config, chat: ChatKey): SendMode {
  for (const list of SENDING_LISTS) if (isListed(config, list, chat)) return list
  return 'none'
}

export function listContacts(config: Config, meId?: number): UiContact[] {
  const entries = Object.entries(config.chats)
  return entries
    .map(([nickname, e]): UiContact => {
      const chat = chatKey(config, nickname, meId)
      return {
        nickname,
        chatId: e.id,
        name: e.name ?? null,
        username: e.username ?? null,
        type: e.type ?? null,
        topicId: e.topicId ?? null,
        aliases: e.aliases,
        notes: e.notes ?? null,
        sendMode: sendModeOf(config, chat),
        autoReply: isListed(config, 'autoReply', chat),
        policy: policyLabel(config, chat),
        sameChat: entries.filter(([n, other]) => n !== nickname && other.id === e.id).map(([n]) => n),
        pageable: notPageable(e, meId) === null,
        pageFrom: config.paging.pageFrom.includes(e.id),
      }
    })
    .sort((a, b) => a.nickname.localeCompare(b.nickname))
}

/**
 * Pages go between people: "/page <reason>" in a private chat, answered by the other person's
 * daemon. Returns what the chat is instead ("a group", "you"), or null for a person.
 */
function notPageable(e: ChatEntry, meId?: number): string | null {
  if (meId !== undefined && e.id === meId) return 'you'
  if (e.type === 'bot') return 'a bot'
  if (e.type === 'group' || e.type === 'channel') return `a ${e.type}`
  if (e.id <= 0) return 'a group or channel'
  return null
}

/**
 * Puts the person's user id on paging.pageFrom (their "/page <reason>" rings you), or takes it off.
 * pageFrom holds ids, not nicknames, since a username can change hands. False = no change.
 */
export function setPageFrom(config: Config, nickname: string, on: boolean, meId?: number): boolean {
  const key = keyFor(config, nickname)
  const e = config.chats[key]!
  const not = notPageable(e, meId)
  if (on && not) throw new Error(`Only a person can page you, and "${key}" is ${not}.`)
  const ids = config.paging.pageFrom
  if (ids.includes(e.id) === on) return false
  config.paging.pageFrom = on ? [...ids, e.id] : ids.filter(id => id !== e.id)
  return true
}

/** The saved chat the Page button pages: a person, by nickname. Throws for anything else. */
export function pageTarget(config: Config, nickname: string, meId?: number): { nickname: string; entry: ChatEntry } {
  const key = keyFor(config, nickname)
  const e = config.chats[key]!
  const not = notPageable(e, meId)
  if (not) throw new Error(`Only a person can be paged, and "${key}" is ${not}.`)
  return { nickname: key, entry: e }
}

/** Every entry in `list` that means this chat, by nickname, alias, id, @username or "me". */
function dropRefs(config: Config, list: RuleList, chat: ChatKey) {
  config.rules[list] = config.rules[list].filter(ref => !refMatches(config, ref, chat, list === 'blocked'))
}

/**
 * Puts the chat on exactly one of blocked / requireApproval / autoSend (or none of them), taking
 * out every other entry that means the same chat, so the choice is what actually decides. Leaves
 * autoReply alone. Returns false when the chat already had that mode.
 */
export function setSendMode(config: Config, nickname: string, mode: SendMode, meId?: number): boolean {
  if (!SEND_MODES.includes(mode)) throw new Error(`Unknown sending mode "${mode}".`)
  const key = keyFor(config, nickname)
  const chat = chatKey(config, key, meId)
  if (sendModeOf(config, chat) === mode) return false
  for (const list of SENDING_LISTS) dropRefs(config, list, chat)
  if (mode !== 'none') config.rules[mode].push(key)
  return true
}

/** Adds the nickname to autoReply, or takes out every entry that means the chat. False = no change. */
export function setAutoReply(config: Config, nickname: string, on: boolean, meId?: number): boolean {
  const key = keyFor(config, nickname)
  const chat = chatKey(config, key, meId)
  if (isListed(config, 'autoReply', chat) === on) return false
  if (on) config.rules.autoReply.push(key)
  else dropRefs(config, 'autoReply', chat)
  return true
}

/**
 * Renames a saved chat in place and rewrites the rules that used the old name, so the chat keeps
 * its lists. Refuses a name that already means another chat, and a name the rules mention that
 * matches nothing yet (taking it would quietly put this chat on those lists). Returns the new key.
 */
export function renameContact(config: Config, nickname: string, wanted: string): string {
  const problem = validateNickname(wanted)
  if (problem) throw new Error(problem)
  const from = keyFor(config, nickname)
  const to = normalizeNickname(wanted)
  if (to === from) return from
  const entry = config.chats[from]!

  if (to !== normalizeNickname(from)) {
    const r = resolveRef(config, to)
    if (r.kind === 'entry') {
      if (r.entry.id !== entry.id) throw new Error(`"${to}" already means ${r.nickname}${r.entry.name ? ` (${r.entry.name})` : ''}.`)
      if (r.nickname !== from) throw new Error(`"${to}" is already a nickname for this chat.`)
      // Otherwise it's one of this chat's own aliases (or its full name): fine to promote.
    } else if (r.kind !== 'unknown') {
      throw new Error(`"${to}" can't be a nickname: it reads as ${r.kind === 'self' ? 'your Saved Messages' : `a chat ${r.kind}`}.`)
    } else {
      const lists = rulesMentioning(config, to)
      if (lists.length) {
        throw new Error(`"${to}" is already in the rules (${lists.join(', ')}) and would put this chat on ${lists.length > 1 ? 'those lists' : 'that list'}. Pick another name, or take it out of the rules first.`)
      }
    }
  }

  const old = normalizeNickname(from)
  entry.aliases = entry.aliases.filter(a => normalizeNickname(a) !== to)
  config.chats = Object.fromEntries(Object.entries(config.chats).map(([k, e]) => (k === from ? [to, e] : [k, e])))
  for (const list of RULE_LISTS) {
    config.rules[list] = config.rules[list].map(ref => (typeof ref === 'string' && normalizeNickname(ref) === old ? to : ref))
  }
  config.away.skip = config.away.skip.map(ref => (typeof ref === 'string' && normalizeNickname(ref) === old ? to : ref))
  // A desk names its chats the same way: a rename must not take the chat off its desk.
  for (const d of Object.values(config.desks)) {
    d.chats = d.chats.map(ref => (typeof ref === 'string' && normalizeNickname(ref) === old ? to : ref))
  }
  return to
}
