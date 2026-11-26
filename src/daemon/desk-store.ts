import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'
import { deskName } from '../shared/desks'
import type { TgEvent, WatchSpec } from '../shared/protocol'
import { oneLine } from '../shared/text'

/** A queued message older than this is dropped when desks.json loads: a desk that never came back doesn't keep text for ever. */
export const DESK_QUEUE_MAX_AGE_MS = 7 * 24 * 60 * 60_000

/** What the daemon keeps for one desk, so a restart of the daemon or of the desk's Claude session loses nothing. */
export interface DeskState {
  label: string
  /** When the proxy holding the desk started (ms): of two, the newer holds it. */
  holder: number
  /** Bumped on every change of holder; the desk's Monitor key is made from it. */
  epoch: number
  watches: WatchSpec[]
  /** Watched messages no listener has taken yet, oldest first. */
  queue: TgEvent[]
  /** How many were dropped because the queue was full, not yet reported. */
  dropped: number
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
const FileSchema = z.object({
  version: z.literal(1),
  desks: z.record(
    z.string(),
    z.object({
      label: z.string().default(''),
      holder: z.number().default(0),
      epoch: z.number().int().nonnegative().default(0),
      watches: z.array(z.looseObject({ id: z.string(), chatId: z.number().int(), chatLabel: z.string(), createdAt: z.number() })).default([]),
      queue: z.array(EventSchema).default([]),
      dropped: z.number().int().nonnegative().default(0),
      seen: z.record(z.string(), z.number().int()).default({}),
    }),
  ),
})

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
    if (!existsSync(this.path)) return out
    try {
      const file = FileSchema.parse(JSON.parse(readFileSync(this.path, 'utf8')))
      for (const [name, d] of Object.entries(file.desks)) {
        if (deskName(name) === null) continue
        // Notices (/reply, moderator) are never kept; drop any an older version wrote. Old messages go too.
        const cutoff = this.now() - DESK_QUEUE_MAX_AGE_MS
        const all = (d.queue as unknown as TgEvent[]).filter(e => !e.takeover && !e.moderation)
        const queue = all.filter(e => !(Date.parse(e.date) < cutoff))
        // The file is the daemon's own, but labels end up on header lines: keep each on one line.
        const watches = (d.watches as WatchSpec[]).map(w => ({
          ...w,
          chatLabel: oneLine(w.chatLabel),
          ...(w.fromLabel !== undefined ? { fromLabel: oneLine(String(w.fromLabel)) } : {}),
          ...(w.note !== undefined ? { note: oneLine(String(w.note)) } : {}),
        }))
        out.set(name, { ...d, label: oneLine(d.label), watches, queue, dropped: d.dropped + (all.length - queue.length) })
      }
    } catch (e) {
      // Set aside, not deleted: it may hold messages someone wants to read.
      const aside = `${this.path}.bad`
      try {
        renameSync(this.path, aside)
      } catch {}
      this.log(`desks.json could not be read (${e instanceof Error ? e.message : String(e)}); moved to ${aside}, starting with no desk state`)
    }
    return out
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
