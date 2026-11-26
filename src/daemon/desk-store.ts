import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'
import { deskName } from '../shared/desks'
import type { TgEvent, WatchSpec } from '../shared/protocol'
import { oneLine } from '../shared/text'

/** How many proxy start times desks.json keeps per desk for its current Monitor URL. */
export const EPOCH_HOLDERS_MAX = 20

/** A queued message older than this is dropped when desks.json loads: a desk that never came back doesn't keep text for ever. */
export const DESK_QUEUE_MAX_AGE_DAYS = 7
export const DESK_QUEUE_MAX_AGE_MS = DESK_QUEUE_MAX_AGE_DAYS * 24 * 60 * 60_000

/** What the daemon keeps for one desk, so a restart of the daemon or of the desk's Claude session loses nothing. */
export interface DeskState {
  label: string
  /** When the proxy holding the desk started (ms): of two, the newer holds it. */
  holder: number
  /** Changes when another Claude session gets the desk; the desk's Monitor key is made from it. */
  epoch: number
  /** Start times of the proxies that held the desk under this epoch, newest last (at most EPOCH_HOLDERS_MAX). */
  epochHolders: number[]
  watches: WatchSpec[]
  /** Watched messages no listener has taken yet, oldest first. */
  queue: TgEvent[]
  /** How many were dropped because the queue was full, not yet reported. */
  dropped: number
  /** How many went because they passed the age limit, not yet reported. */
  expired: number
  /** The newest message id handed to the desk, per chat id: older or equal ones are not handed again. */
  seen: Record<string, number>
}

// The daemon writes this file itself; the checks only keep a damaged one from crashing it.
const nullable = <T extends z.ZodType>(t: T) => t.nullable().default(null)
const EventSchema = z.looseObject({
  seq: z.number(),
  watchIds: z.array(z.string()),
  chatId: z.number().int(),
  chatLabel: z.string(),
  chatNickname: z.string().optional(),
  fromId: nullable(z.number().int()),
  fromName: z.string(),
  fromUsername: nullable(z.string()),
  messageId: z.number().int(),
  topicId: nullable(z.number().int()),
  replyToId: nullable(z.number().int()),
  text: z.string(),
  media: nullable(z.string()),
  date: z.string(),
})
const WatchSchema = z.looseObject({
  id: z.string().min(1).max(64),
  chatId: z.number().int(),
  chatLabel: z.string(),
  createdAt: z.number(),
  fromId: z.number().int().optional(),
  fromLabel: z.string().optional(),
  topicId: z.number().int().optional(),
  note: z.string().optional(),
})
// Each entry is checked on its own, so one bad watch, message or desk costs only itself.
const FileSchema = z.object({ version: z.literal(1), desks: z.record(z.string(), z.unknown()) })
const DeskSchema = z.object({
  label: z.string().default(''),
  holder: z.number().default(0),
  epoch: z.number().int().nonnegative().default(0),
  // A bad list only costs the list, never the desk's watches and queue.
  epochHolders: z
    .array(z.number())
    .default([])
    .catch([])
    .transform(a => a.slice(-EPOCH_HOLDERS_MAX)),
  watches: z.array(z.unknown()).default([]),
  queue: z.array(z.unknown()).default([]),
  dropped: z.number().int().nonnegative().default(0),
  expired: z.number().int().nonnegative().default(0),
  seen: z.record(z.string(), z.number().int()).default({}),
})

/**
 * Watches as a proxy or desks.json gave them, keeping only well-formed ones, each label on one line.
 * They are saved to desks.json and shown on header lines, so nothing else gets through.
 */
export function cleanWatches(list: readonly unknown[]): WatchSpec[] {
  return list.flatMap(item => {
    const r = WatchSchema.safeParse(item)
    if (!r.success) return []
    const w = r.data
    return [
      {
        ...w,
        chatLabel: oneLine(w.chatLabel),
        ...(w.fromLabel !== undefined ? { fromLabel: oneLine(w.fromLabel) } : {}),
        ...(w.note !== undefined ? { note: oneLine(w.note) } : {}),
      } as WatchSpec,
    ]
  })
}

/**
 * desks.json in the daemon's folder: each desk's watches, undelivered messages and last-seen ids.
 * It holds message text, so it is written like the other state files: owner-only, replaced atomically.
 */
export class DeskStore {
  constructor(
    readonly path: string,
    private readonly log: (msg: string) => void = () => {},
    private readonly now: () => number = Date.now,
  ) {}

  load(): Map<string, DeskState> {
    const out = new Map<string, DeskState>()
    this.#expireSetAside()
    if (!existsSync(this.path)) return out
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(this.path, 'utf8'))
    } catch {
      return this.#setAside('is not valid JSON')
    }
    const file = FileSchema.safeParse(raw)
    if (!file.success) return this.#setAside('has an unexpected layout')
    const cutoff = this.now() - DESK_QUEUE_MAX_AGE_MS
    for (const [name, entry] of Object.entries(file.data.desks)) {
      if (deskName(name) === null) continue
      const d = DeskSchema.safeParse(entry)
      if (!d.success) {
        // Only the name in the log: the entry may hold message text.
        this.log(`desks.json: desk "${name}" could not be read; it starts with no saved state`)
        continue
      }
      // Notices (/reply, moderator) are never kept; drop any an older version wrote, uncounted. Old
      // messages go too, counted as expired. Entries that can't be read are only logged, by number.
      let unreadable = 0
      const all = d.data.queue.flatMap(e => {
        const r = EventSchema.safeParse(e)
        if (!r.success) {
          unreadable++
          return []
        }
        return !r.data.takeover && !r.data.moderation ? [r.data as unknown as TgEvent] : []
      })
      if (unreadable) this.log(`desks.json: ${unreadable} queued messages of desk "${name}" could not be read and were left out`)
      const queue = all.filter(e => !(Date.parse(e.date) < cutoff))
      out.set(name, {
        ...d.data,
        // The file is the daemon's own, but labels end up on header lines: keep each on one line.
        label: oneLine(d.data.label),
        watches: cleanWatches(d.data.watches),
        queue,
        dropped: d.data.dropped,
        expired: d.data.expired + (all.length - queue.length),
      })
    }
    return out
  }

  /** A desks.json.bad (a file that couldn't be read) is kept for the person only as long as queued messages are. */
  #expireSetAside(): void {
    const aside = `${this.path}.bad`
    try {
      if (this.now() - statSync(aside).mtimeMs > DESK_QUEUE_MAX_AGE_MS) {
        rmSync(aside, { force: true })
        this.log(`desks.json.bad was older than the age limit for queued messages and was deleted`)
      }
    } catch {}
  }

  /** Moves a file that can't be read to desks.json.bad (kept for the person to look at) and starts empty. The log quotes none of it. */
  #setAside(why: string): Map<string, DeskState> {
    const aside = `${this.path}.bad`
    try {
      renameSync(this.path, aside)
    } catch {}
    this.log(`desks.json ${why}; moved to ${aside}, starting with no desk state`)
    return new Map()
  }

  /** Returns whether the file was written. */
  save(desks: Map<string, DeskState>): boolean {
    const tmp = `${this.path}.${process.pid}.tmp`
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      writeFileSync(tmp, `${JSON.stringify({ version: 1, desks: Object.fromEntries(desks) })}\n`, { mode: 0o600 })
      renameSync(tmp, this.path)
      return true
    } catch (e) {
      rmSync(tmp, { force: true })
      this.log(`desks.json could not be saved (tried again on the next change): ${e instanceof Error ? e.message : String(e)}`)
      return false
    }
  }
}
