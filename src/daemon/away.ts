import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import {
  AWAY_MAX_AGE_MS,
  AWAY_MAX_PER_HOUR,
  AWAY_MAX_PER_WINDOW,
  AWAY_MIN_GAP_MINUTES,
  awaySummary,
  awayWindowAt,
  firstName,
  nextAwayChange,
  primarySchedule,
  renderAwayMessage,
  type AwaySchedule,
  type AwayWindow,
} from '../shared/away'
import { inRefs, isListed, resolveRef, type Config } from '../shared/config'
import { decideSend, withFooter } from '../shared/policy'
import type { IncomingMessage, MessageInfo, PeerInfo, SentRecord, UiAway } from '../shared/protocol'
import type { SessionHub } from './sessions'
import type { TelegramPort } from './telegram'

export interface AwayDeps {
  /** store.get(), read on every message. */
  config: () => Config
  tg: TelegramPort
  hub: Pick<SessionHub, 'handledLive' | 'takeoverOf'>
  /** pager?.active() ?? [] */
  pages: () => { senderKey: string }[]
  /** Service.recordSent */
  record: (r: Omit<SentRecord, 'at'>) => void
  /**
   * Sends the reply. Defaults to tg.sendText; the daemon passes Service.sendAway, which marks the
   * message as its own so its echo is never mistaken for you being back.
   */
  send?: (chatId: number, text: string) => Promise<MessageInfo>
  /** A moderator paused Claude in this chat ("/bots stop"): no away reply goes there either. */
  paused?: (chatId: number) => boolean
  /** away.json; absent = memory only. */
  statePath?: string
  now?: () => number
  /** Runs `fn` after `ms`; tests drive it by hand (and can await what `fn` returns). */
  setTimer?: (fn: () => Promise<unknown>, ms: number) => { cancel(): void }
  log?: (msg: string) => void
}

/** Entries older than this are dropped on save: no away window is longer than a day. */
const REPLIED_KEEP_MS = 48 * 3_600_000
const HOUR_MS = 3_600_000

/** Telegram's own service account (login codes, security notices): never a person to answer. */
const TELEGRAM_SERVICE_ID = 777000

const realTimer = (fn: () => Promise<unknown>, ms: number) => {
  const t = setTimeout(() => void fn(), ms)
  return { cancel: () => clearTimeout(t) }
}

/**
 * away.json as an earlier build wrote it: `{ window: "YYYY-MM-DDTHH:MM", chats: [...] }`, the window
 * named by its local start. Read back as "answered at the window's start", which still blocks that night.
 */
function fromOldFormat(raw: { window: string; chats: unknown[] }): Map<number, number> {
  const out = new Map<number, number>()
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(raw.window)
  if (!m) return out
  const [, y, mo, d, h, mi] = m.map(Number) as [number, number, number, number, number, number]
  const start = new Date(y, mo - 1, d, h, mi).getTime()
  for (const c of raw.chats) if (typeof c === 'number') out.set(c, start)
  return out
}

/** What a sender gets from this schedule: its message with {name} filled in, plus the footer. */
export function awayText(config: Config, me: { name: string } | null | undefined, schedule: Pick<AwaySchedule, 'message'>): string {
  return withFooter(renderAwayMessage(schedule.message, firstName(me)), config.footer)
}

/** The away settings as the tray shows them. One place, so the responder and a Service without one agree. */
export function uiAway(config: Config, me: { name: string } | null | undefined, at: Date, waiting = 0): UiAway {
  const { away } = config
  const current = awayWindowAt(away, at)
  // The fields an earlier tray and the menu bar read, and write back to the same schedule (applyAwayPatch).
  const primary = primarySchedule(away, at)
  return {
    enabled: away.enabled,
    from: primary?.from ?? '18:00',
    until: primary?.until ?? '09:00',
    message: primary?.message ?? '',
    quietMinutes: away.quietMinutes,
    active: current !== null,
    nextChange: nextAwayChange(away, at)?.toISOString() ?? null,
    preview: primary ? awayText(config, me, primary) : '',
    current: current?.schedule.id ?? null,
    currentUntil: current?.end.toISOString() ?? null,
    waiting,
    schedules: away.schedules.map(s => ({
      id: s.id,
      name: s.name,
      enabled: s.enabled,
      from: s.from,
      until: s.until,
      days: s.days,
      startDate: s.startDate,
      endDate: s.endDate,
      delaySeconds: s.delaySeconds,
      repeatMinutes: s.repeatMinutes,
      message: s.message,
      active: current?.schedule.id === s.id,
      preview: awayText(config, me, s),
    })),
    skip: away.skip.map(ref => {
      const r = resolveRef(config, ref)
      return { ref, chatId: r.kind === 'entry' ? r.entry.id : r.kind === 'id' ? r.id : null }
    }),
  }
}

type Skip = { skip: string }
type Ok = { window: AwayWindow }

interface Waiting {
  /** The message's own date (Telegram's clock, epoch ms). */
  at: number
  /** When it reached the daemon (this PC's clock), for comparing with reads, which only this clock times. */
  arrived: number
  chat: PeerInfo
  msg: IncomingMessage
  paged: boolean
  /** The schedule's wait. Only this much counts on top of the age limit: a timer that fires late (the laptop slept) is too late. */
  delayMs: number
  timer: { cancel(): void }
}

/**
 * Sends away replies to people only, never over a live Claude or page. A schedule with a wait holds
 * the reply that long and drops it if you show up meanwhile (you read a chat or send something
 * yourself, on any device).
 */
export class AwayResponder {
  /** chat id -> when it last got an away reply (epoch ms). Loaded lazily from away.json. */
  #replied: Map<number, number> | null = null
  /** When each away reply of the last two days went (epoch ms), for the hourly and per-window limits. */
  #sentLog: number[] = []
  #lastOutgoing = new Map<number, number>()
  /** Replies waiting out a schedule's delay, by chat. */
  #waiting = new Map<number, Waiting>()
  /**
   * When you were last seen on Telegram. Two clocks, never compared with each other: a read is timed by
   * this PC, a message you sent by Telegram, and the two can be seconds apart.
   */
  #lastRead = 0
  #lastSent = 0
  /** The limit last logged and when (hour or window id), so each is logged once. */
  #limitLogged: string | null = null

  constructor(private d: AwayDeps) {}

  #now = () => (this.d.now ?? Date.now)()
  #log = (m: string) => this.d.log?.(m)

  /** Who got an away reply when. Keyed by time, not by window, so editing the hours mid-night can't reset it. */
  #repliedMap(): Map<number, number> {
    if (this.#replied) return this.#replied
    this.#replied = new Map()
    if (!this.d.statePath) return this.#replied
    try {
      const raw = JSON.parse(readFileSync(this.d.statePath, 'utf8'))
      if (raw && typeof raw.replied === 'object' && !Array.isArray(raw.replied)) {
        for (const [k, v] of Object.entries(raw.replied as Record<string, unknown>)) {
          const id = Number(k)
          if (Number.isFinite(id) && typeof v === 'number' && Number.isFinite(v)) this.#replied.set(id, v)
        }
        // A file from before the log: each chat's last reply is the best there is.
        this.#sentLog = Array.isArray(raw.sent)
          ? raw.sent.filter((t: unknown): t is number => typeof t === 'number' && Number.isFinite(t))
          : [...this.#replied.values()]
      } else if (typeof raw?.window === 'string' && Array.isArray(raw.chats)) {
        this.#replied = fromOldFormat(raw)
        this.#sentLog = [...this.#replied.values()]
      }
    } catch {}
    return this.#replied
  }

  #save() {
    const replied = this.#replied
    if (!replied) return
    const cutoff = this.#now() - REPLIED_KEEP_MS
    for (const [id, t] of replied) if (t < cutoff) replied.delete(id)
    this.#sentLog = this.#sentLog.filter(t => t >= cutoff)
    if (!this.d.statePath) return
    try {
      const tmp = `${this.d.statePath}.tmp`
      writeFileSync(tmp, JSON.stringify({ replied: Object.fromEntries(replied), sent: this.#sentLog }), { mode: 0o600 })
      renameSync(tmp, this.d.statePath)
    } catch (e) {
      this.#log(`away: could not save state: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /**
   * Every rule but the wait, checked when the message arrives and again when the wait is over.
   * `extraAge`: the schedule's wait, which doesn't count against the message's age. Only the wait as
   * set: a timer that fires late (the laptop slept through it) finds the message too old.
   */
  #check(config: Config, msg: IncomingMessage, at: number, paged: boolean, extraAge: number): Skip | Ok {
    const { away } = config
    if (!away.enabled) return { skip: 'away is off' } // R1
    const chat = msg.chat
    // R4: the chat's rules. A Blocked chat (listed, or unlisted under defaultPolicy "block") never gets
    // one. Ask every time chats do: the reply is your own fixed text, so there is nothing to approve.
    if (decideSend(config, chat, { isWatching: false }).action === 'block') return { skip: 'blocked' }
    // R4b: a chat you listed in away.skip never gets one, whatever its other rules.
    if (inRefs(config, away.skip, chat)) return { skip: 'on the away skip list' }
    // R5: away now, not just when it was sent (a catch-up at 09:05 of a message from 08:58 is too late),
    // and the message came in during this same window.
    const now = this.#now()
    const window = awayWindowAt(away, new Date(now))
    if (!window || at < window.start.getTime()) return { skip: 'not in an away window' }
    if (now - at > AWAY_MAX_AGE_MS + extraAge) return { skip: 'too old' }
    // R6: once per chat per window, or again after the schedule's repeat minutes; and never twice within
    // AWAY_MIN_GAP_MINUTES, even across schedules (a Daytime reply at 20:59, then Night's at 21:01).
    const prev = this.#repliedMap().get(chat.id)
    if (prev !== undefined) {
      const { repeatMinutes } = window.schedule
      if (now - prev < AWAY_MIN_GAP_MINUTES * 60_000) return { skip: 'replied lately' }
      if (repeatMinutes === 0 ? prev >= window.start.getTime() : now - prev < repeatMinutes * 60_000) return { skip: 'already replied' }
    }
    const lastOut = this.#lastOutgoing.get(chat.id)
    if (away.quietMinutes > 0 && lastOut !== undefined && now - lastOut < away.quietMinutes * 60_000) return { skip: 'you wrote there lately' } // R7
    if (this.d.hub.takeoverOf(chat.id) !== null) return { skip: 'handed to Claude' } // R8
    if (this.d.paused?.(chat.id)) return { skip: 'paused by a moderator' }
    if (this.d.hub.handledLive(chat) && isListed(config, 'autoReply', chat)) return { skip: 'Claude is answering' }
    if (paged || this.d.pages().some(p => p.senderKey === String(msg.from?.id ?? chat.id))) return { skip: 'paged' } // R9
    return { window }
  }

  async onIncoming(msg: IncomingMessage, paged: boolean): Promise<'sent' | 'skipped' | 'waiting'> {
    try {
      if (msg.outgoing) return 'skipped' // R2
      const chat = msg.chat
      // R3: bots are type 'bot'; Telegram's service account and support staff are users but not people to answer.
      if (chat.type !== 'user' || chat.isSelf || chat.isSupport || chat.id === TELEGRAM_SERVICE_ID) return 'skipped'
      const at = Date.parse(msg.date)
      if (Number.isNaN(at)) return 'skipped'
      if (this.#waiting.has(chat.id)) return 'skipped' // one wait per chat; its reply covers this message too
      const r = this.#check(this.d.config(), msg, at, paged, 0)
      if ('skip' in r) return 'skipped'
      const delay = r.window.schedule.delaySeconds
      if (delay === 0) return await this.#reply(msg, at, paged, 0)
      const timer = (this.d.setTimer ?? realTimer)(() => this.#afterWait(chat.id), delay * 1000)
      this.#waiting.set(chat.id, { at, arrived: this.#now(), chat, msg, paged, delayMs: delay * 1000, timer })
      return 'waiting'
    } catch (e) {
      this.#log(`away: ${e instanceof Error ? e.message : String(e)}`)
      return 'skipped'
    }
  }

  async #afterWait(chatId: number): Promise<'sent' | 'skipped'> {
    const w = this.#waiting.get(chatId)
    if (!w) return 'skipped'
    this.#waiting.delete(chatId)
    try {
      if (this.#lastRead >= w.arrived || this.#lastSent >= w.at) return 'skipped'
      return await this.#reply(w.msg, w.at, w.paged, w.delayMs)
    } catch (e) {
      this.#log(`away: ${e instanceof Error ? e.message : String(e)}`)
      return 'skipped'
    }
  }

  async #reply(msg: IncomingMessage, at: number, paged: boolean, waited: number): Promise<'sent' | 'skipped'> {
    const config = this.d.config()
    const r = this.#check(config, msg, at, paged, waited)
    if ('skip' in r) return 'skipped'
    const chat = msg.chat
    const now = this.#now()
    const replied = this.#repliedMap()
    // R10: at most AWAY_MAX_PER_HOUR in any hour and AWAY_MAX_PER_WINDOW in one window, whoever writes.
    // Counted from the saved log, so a restart doesn't reset either.
    const lastHour = this.#sentLog.filter(t => t > now - HOUR_MS).length
    const thisWindow = this.#sentLog.filter(t => t >= r.window.start.getTime()).length
    const limit =
      lastHour >= AWAY_MAX_PER_HOUR
        ? { key: `hour@${Math.floor(now / HOUR_MS)}`, text: `${AWAY_MAX_PER_HOUR} replies an hour` }
        : thisWindow >= AWAY_MAX_PER_WINDOW
          ? { key: `window@${r.window.id}`, text: `${AWAY_MAX_PER_WINDOW} replies in this ${r.window.schedule.name} window` }
          : null
    if (limit) {
      if (this.#limitLogged !== limit.key) {
        this.#limitLogged = limit.key
        this.#log(`away: reached the limit of ${limit.text}; holding off`)
      }
      return 'skipped'
    }

    // Mark before the first await so a second message arriving meanwhile sees it.
    const prev = replied.get(chat.id)
    replied.set(chat.id, now)
    this.#sentLog.push(now)
    this.#save()
    const text = awayText(config, this.d.tg.state().me, r.window.schedule)
    try {
      const sent = await (this.d.send ?? ((id, t) => this.d.tg.sendText(id, t)))(chat.id, text)
      this.d.record({ chatId: chat.id, chatLabel: chat.name, text, messageId: sent.id, via: 'away', sessionLabel: null })
      this.#log(`away reply (${r.window.schedule.name}) to ${chat.id}`)
      return 'sent'
    } catch (e) {
      // Restore what was there, unless something else has written this chat since.
      if (replied.get(chat.id) === now) {
        if (prev === undefined) replied.delete(chat.id)
        else replied.set(chat.id, prev)
        const i = this.#sentLog.lastIndexOf(now)
        if (i >= 0) this.#sentLog.splice(i, 1)
        this.#save()
      }
      throw e
    }
  }

  /** Something was sent in this chat from your account (you or Claude): R7's quiet time starts. */
  noteOutgoing(chatId: number, at: number = this.#now()) {
    this.#lastOutgoing.set(chatId, at)
  }

  /**
   * You read a chat, on any device: you are around. `at` is this PC's clock (Telegram's read updates
   * carry no time). Replies waiting for a message that reached the daemon before then are dropped.
   */
  noteRead(at: number = this.#now()) {
    if (at > this.#lastRead) this.#lastRead = at
    this.#dropWaiting(w => w.arrived <= at)
  }

  /**
   * You sent a message yourself (not Claude, the pager or an away reply), on any device. `sentAt` is the
   * message's own date, Telegram's clock, so it's compared with the waiting messages' own dates.
   */
  noteSent(sentAt: number) {
    if (sentAt > this.#lastSent) this.#lastSent = sentAt
    this.#dropWaiting(w => w.at <= sentAt)
  }

  #dropWaiting(before: (w: Waiting) => boolean) {
    for (const [chatId, w] of this.#waiting) {
      if (!before(w)) continue
      w.timer.cancel()
      this.#waiting.delete(chatId)
      this.#log(`away: you're back, no away reply to ${chatId}`)
    }
  }

  /** Chats whose reply is waiting out a schedule's delay right now. */
  waitingCount(): number {
    return this.#waiting.size
  }

  /** Stops every waiting reply (the daemon is stopping). */
  stop() {
    for (const w of this.#waiting.values()) w.timer.cancel()
    this.#waiting.clear()
  }

  ui(): UiAway {
    return uiAway(this.d.config(), this.d.tg.state().me, new Date(this.#now()), this.#waiting.size)
  }

  summary(): string {
    return awaySummary(this.d.config().away, new Date(this.#now()))
  }
}
