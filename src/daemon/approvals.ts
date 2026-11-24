import type { OutgoingFile } from '../shared/media'
import type { ApprovalAction, PeerInfo, ToolResult } from '../shared/protocol'
import type { StickerRef } from './telegram'
import { newId } from './sessions'

/** A new channel or supergroup, as telegram_create_chat asked for it (username without the @). */
export interface CreateChatSpec {
  type: 'channel' | 'supergroup'
  title: string
  description?: string
  username?: string
  /**
   * A channel's discussion group: a new supergroup with this title, or an existing one (its username
   * too, so a block by @username placed while the request waits still applies).
   */
  discussion?: { kind: 'new'; title: string } | { kind: 'existing'; chatId: number; username: string | null; label: string }
}

export interface PendingSend {
  id: string
  /** Absent means a send. An edit or delete is of a message this session sent (messageId). A create makes a new chat (`create`). */
  action?: ApprovalAction
  /** What a create makes. chatId is 0 then: the chat doesn't exist yet. */
  create?: CreateChatSpec
  messageId?: number
  /** An edit: the text the chat sees now. `text` is the new text; for a delete, the message to remove. */
  previousText?: string
  sessionId: string
  sessionLabel: string
  chatId: number
  chatLabel: string
  /** Name · @username · id · type, so the person approving sees exactly who it goes to. */
  chatDetail: string
  username: string | null
  /** The message, or the caption when a file goes out. */
  text: string
  file?: OutgoingFile
  /** SHA-256 of the file when approval was asked; it must still match when it is sent. */
  fileDigest?: string
  asPhoto?: boolean
  /** A sticker re-sent from an existing message; text is empty then (stickers take no caption). */
  sticker?: StickerRef
  replyTo?: number
  topicId?: number
  parseMode: 'plain' | 'markdown' | 'html'
  /** The footer added to a text message (for its Recently sent record). */
  footer?: string
  reason: string
  createdAt: number
  peer: PeerInfo
  /** On neither autoSend nor requireApproval: approving also decides which one it joins. */
  firstTime: boolean
  /** The chat's saved nickname, if it has one. */
  nickname: string | null
  /** What it will be saved as otherwise (the approver can change it). */
  suggestedNickname: string
  /**
   * The menu bar / tray app was running when this was asked, so the human decides there. The
   * session must not confirm it itself (telegram_confirm_send), even after Claude Code backgrounds
   * the waiting tool call.
   */
  askedInUi: boolean
}

export type Remember = 'autoSend' | 'requireApproval'

export interface DecideOptions {
  remember?: Remember
  nickname?: string
  /** The menu bar or tray app deciding said it shows new-chat cards as such (UI_FEATURES_HEADER). */
  uiCreate?: boolean
}

export interface Outcome {
  approved: boolean
  result: ToolResult
}

/**
 * Messages waiting for a human yes, from the menu bar, the Claude Code dialog, or the chat.
 * Whoever decides first wins; anyone waiting on the draft hears the outcome.
 */
export class Approvals {
  readonly #items = new Map<string, PendingSend>()
  readonly #waiters = new Map<string, ((o: Outcome) => void)[]>()
  /** Recent outcomes, so a wait that starts just after a decision still gets it. */
  readonly #settled = new Map<string, Outcome>()

  constructor(
    readonly ttlMs = 20 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  create(p: Omit<PendingSend, 'id' | 'createdAt'>): PendingSend {
    const item = { ...p, id: newId('a_'), createdAt: this.now() }
    this.#items.set(item.id, item)
    return item
  }

  /** The draft, if it is still waiting, without taking it. */
  peek(id: string): PendingSend | undefined {
    const item = this.#items.get(id)
    return item && this.now() - item.createdAt <= this.ttlMs ? item : undefined
  }

  list(): PendingSend[] {
    return [...this.#items.values()].filter(i => this.now() - i.createdAt <= this.ttlMs)
  }

  /** Removes and returns the draft. `sessionId` null means any session may decide (the menu bar). */
  take(id: string, sessionId: string | null): PendingSend {
    const item = this.#items.get(id)
    if (!item || this.now() - item.createdAt > this.ttlMs) {
      const done = this.#settled.get(id)
      if (done) throw new Error(`Message ${id} was already ${done.approved ? 'approved' : 'declined'}.`)
      throw new Error(`No pending message with id ${id} (drafts last ${this.ttlMs / 60_000} minutes).`)
    }
    if (sessionId !== null && item.sessionId !== sessionId) throw new Error(`Pending message ${id} belongs to another session.`)
    this.#items.delete(id)
    return item
  }

  settle(id: string, outcome: Outcome): void {
    this.#settled.set(id, outcome)
    if (this.#settled.size > 100) this.#settled.delete(this.#settled.keys().next().value!)
    for (const wake of this.#waiters.get(id) ?? []) wake(outcome)
    this.#waiters.delete(id)
  }

  /** Resolves when the draft is decided or expires. */
  wait(id: string): Promise<Outcome> {
    const done = this.#settled.get(id)
    if (done) return Promise.resolve(done)
    if (!this.#items.has(id)) {
      return Promise.resolve({ approved: false, result: { text: `No pending message with id ${id}.`, isError: true } })
    }
    return new Promise(resolve => {
      this.#waiters.set(id, [...(this.#waiters.get(id) ?? []), resolve])
    })
  }

  /** Settles every draft nobody decided in time, and returns them. */
  sweep(): PendingSend[] {
    const now = this.now()
    const expired: PendingSend[] = []
    for (const [id, item] of this.#items) {
      if (now - item.createdAt <= this.ttlMs) continue
      this.#items.delete(id)
      this.settle(id, { approved: false, result: { text: expiredText(item, this.ttlMs / 60_000), isError: true } })
      expired.push(item)
    }
    return expired
  }
}

function expiredText(item: PendingSend, minutes: number): string {
  switch (item.action ?? 'send') {
    case 'edit':
      return `Nobody approved the edit of message #${item.messageId} in ${item.chatLabel} within ${minutes} minutes. It was not edited.`
    case 'delete':
      return `Nobody approved deleting message #${item.messageId} in ${item.chatLabel} within ${minutes} minutes. It was not deleted.`
    case 'create':
      return `Nobody approved the ${item.chatLabel} within ${minutes} minutes. Nothing was created.`
    case 'send':
      return `Nobody approved the message to ${item.chatLabel} within ${minutes} minutes. Nothing was sent.`
  }
}
