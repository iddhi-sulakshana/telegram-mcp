import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SendFileOptions, SendOptions, StickerRef, TelegramPort } from '../src/daemon/telegram'
import type { DialogInfo, DownloadedFile, IncomingMessage, MessageInfo, PeerInfo, ReadStatus, TelegramState } from '../src/shared/protocol'
import { downloadFileName, type OutgoingFile } from '../src/shared/media'
import { matchesChatKind, type ChatKind } from '../src/shared/tools'

/** In-memory stand-in for Telegram. Never touches the network. */
export class FakeTelegram implements TelegramPort {
  me: PeerInfo = { id: 1, type: 'user', name: 'Me', username: 'me_user', isSelf: true }
  peers = new Map<number, PeerInfo>()
  /** Ids that getPeer(id) pretends not to know yet (no access hash), like a fresh session. */
  uncached = new Set<number>()
  sent: { chatId: number; text: string; opts: SendOptions }[] = []
  sentFiles: { chatId: number; file: OutgoingFile; caption: string; opts: SendFileOptions }[] = []
  history = new Map<number, MessageInfo[]>()
  /** Attachments by `${chatId}:${messageId}`. */
  files = new Map<string, { name: string | null; type: string; mime: string | null; data: string }>()
  phase: TelegramState['phase'] = 'connected'
  #listeners: ((m: IncomingMessage) => void)[] = []
  #readListeners: ((chatId: number) => void)[] = []
  #nextId = 1000

  add(...peers: PeerInfo[]): this {
    for (const p of peers) this.peers.set(p.id, p)
    return this
  }

  state(): TelegramState {
    return { phase: this.phase, me: this.phase === 'connected' ? this.me : null, since: 0, reconnects: 0, lastError: null }
  }
  start() {}
  async stop() {}
  async reconnect() {}
  onMessage(cb: (m: IncomingMessage) => void) {
    this.#listeners.push(cb)
  }
  onRead(cb: (chatId: number) => void) {
    this.#readListeners.push(cb)
  }

  /** You read a chat on another device. */
  emitRead(chatId: number) {
    for (const l of this.#readListeners) l(chatId)
  }

  emit(chatId: number, text: string, fromId = chatId, extra: Partial<IncomingMessage> = {}): IncomingMessage {
    const chat = this.peers.get(chatId)!
    const from = this.peers.get(fromId) ?? null
    const msg: IncomingMessage = {
      id: this.#nextId++,
      chatId,
      chat,
      date: new Date().toISOString(),
      from,
      outgoing: false,
      text,
      media: null,
      replyToId: null,
      topicId: null,
      ...extra,
    }
    for (const l of this.#listeners) l(msg)
    return msg
  }

  async getPeer(ref: number | string): Promise<PeerInfo> {
    if (ref === 'me') return this.me
    if (typeof ref === 'number') {
      const p = this.peers.get(ref)
      if (!p || this.uncached.has(ref)) throw new Error(`peer ${ref} not found`)
      return p
    }
    const u = ref.replace(/^@/, '').toLowerCase()
    for (const p of this.peers.values()) if (p.username?.toLowerCase() === u) return p
    throw new Error(`USERNAME_NOT_OCCUPIED: @${u}`)
  }

  async sendText(chatId: number, text: string, opts: SendOptions = {}): Promise<MessageInfo> {
    this.sent.push({ chatId, text, opts })
    return {
      id: this.#nextId++,
      chatId,
      date: new Date().toISOString(),
      from: this.me,
      outgoing: true,
      text,
      media: null,
      replyToId: opts.replyTo ?? null,
      topicId: opts.topicId ?? null,
    }
  }

  async sendFile(chatId: number, file: OutgoingFile, caption: string, opts: SendFileOptions = {}): Promise<MessageInfo> {
    this.sentFiles.push({ chatId, file, caption, opts })
    return {
      id: this.#nextId++,
      chatId,
      date: new Date().toISOString(),
      from: this.me,
      outgoing: true,
      text: caption,
      media: opts.asPhoto ? 'photo' : `document: ${file.name}`,
      replyToId: opts.replyTo ?? null,
      topicId: opts.topicId ?? null,
    }
  }

  /** Message refs (`${chatId}:${messageId}`) that hold a sticker. */
  stickers = new Set<string>()
  sentStickers: { chatId: number; from: StickerRef; opts: SendOptions }[] = []
  deleted: { chatId: number; messageId: number }[] = []

  async deleteMessage(chatId: number, messageId: number): Promise<void> {
    this.deleted.push({ chatId, messageId })
  }

  topics: { chatId: number; title: string; id: number }[] = []

  async listTopics(chatId: number): Promise<{ id: number; title: string }[]> {
    return this.topics.filter(t => t.chatId === chatId).map(t => ({ id: t.id, title: t.title }))
  }

  async createTopic(chatId: number, title: string): Promise<{ id: number }> {
    const topic = { chatId, title, id: this.#nextId++ }
    this.topics.push(topic)
    return { id: topic.id }
  }

  /** Chats made with createChat, in order, and their ids. */
  created: { type: 'channel' | 'supergroup'; title: string; description?: string }[] = []
  createdIds: number[] = []
  /** Public usernames set with setChatUsername, by chat id. */
  usernames = new Map<number, string>()
  /** Usernames Telegram would say are taken. */
  takenUsernames = new Set<string>()
  /** Discussion groups linked to channels. */
  links: { channelId: number; groupId: number }[] = []
  /** When set, createChat / linkDiscussionGroup fail with this Telegram error. */
  failCreate: string | null = null
  failLink: string | null = null
  #nextChannel = -1009000000000

  async createChat(spec: { type: 'channel' | 'supergroup'; title: string; description?: string }): Promise<PeerInfo> {
    if (this.failCreate) throw new Error(this.failCreate)
    const peer: PeerInfo = { id: this.#nextChannel--, type: spec.type === 'channel' ? 'channel' : 'group', name: spec.title, username: null }
    this.created.push(spec.description === undefined ? { type: spec.type, title: spec.title } : { ...spec })
    this.createdIds.push(peer.id)
    this.add(peer)
    return peer
  }

  async setChatUsername(chatId: number, username: string): Promise<void> {
    if (this.takenUsernames.has(username.toLowerCase())) throw new Error('USERNAME_OCCUPIED')
    const peer = this.peers.get(chatId)
    if (!peer || (peer.type !== 'channel' && peer.type !== 'group')) throw new Error('CHAT_INVALID')
    this.usernames.set(chatId, username)
    this.peers.set(chatId, { ...peer, username })
  }

  async linkDiscussionGroup(channelId: number, groupId: number): Promise<void> {
    if (this.failLink) throw new Error(this.failLink)
    if (this.peers.get(channelId)?.type !== 'channel') throw new Error('BROADCAST_ID_INVALID')
    if (this.peers.get(groupId)?.type !== 'group') throw new Error('MEGAGROUP_ID_INVALID')
    this.links.push({ channelId, groupId })
  }

  /** What Telegram would say about who read which of your messages, keyed `${chatId}:${messageId}`. */
  readStatuses = new Map<string, ReadStatus>()

  async getReadStatus(chatId: number, messageId: number): Promise<ReadStatus> {
    const st = this.readStatuses.get(`${chatId}:${messageId}`)
    if (!st) throw new Error(`Message #${messageId} was not sent from your account: only your own messages have read receipts.`)
    return st
  }

  edits: { chatId: number; messageId: number; text: string; parseMode?: SendOptions['parseMode'] }[] = []

  async editMessage(chatId: number, messageId: number, text: string, opts: { parseMode?: SendOptions['parseMode'] } = {}): Promise<MessageInfo> {
    this.edits.push({ chatId, messageId, text, parseMode: opts.parseMode })
    return {
      id: messageId,
      chatId,
      date: new Date().toISOString(),
      from: this.me,
      outgoing: true,
      text,
      media: null,
      replyToId: null,
      topicId: null,
    }
  }

  async sendSticker(chatId: number, from: StickerRef, opts: SendOptions = {}): Promise<MessageInfo> {
    if (!this.stickers.has(`${from.chatId}:${from.messageId}`)) throw new Error(`Message #${from.messageId} has no attachment, not a sticker.`)
    this.sentStickers.push({ chatId, from, opts })
    return {
      id: this.#nextId++,
      chatId,
      date: new Date().toISOString(),
      from: this.me,
      outgoing: true,
      text: '',
      media: 'sticker',
      replyToId: opts.replyTo ?? null,
      topicId: opts.topicId ?? null,
    }
  }

  async getHistory(chatId: number, opts: { limit: number }): Promise<MessageInfo[]> {
    return (this.history.get(chatId) ?? []).slice(-opts.limit)
  }

  /** Unread counts by chat id, for list_chats tests. */
  unread = new Map<number, number>()
  /** The last message each chat shows in the dialog list. */
  lastMessages = new Map<number, DialogInfo['lastMessage']>()

  async listDialogs(opts: { limit: number; unreadOnly?: boolean; type?: ChatKind }): Promise<DialogInfo[]> {
    for (const id of this.uncached) this.uncached.delete(id)
    return [...this.peers.values()]
      .filter(peer => matchesChatKind(peer.type, opts.type ?? 'all'))
      .map(peer => ({ peer, unread: this.unread.get(peer.id) ?? 0, pinned: false, lastMessage: this.lastMessages.get(peer.id) ?? null }))
      .filter(d => !opts.unreadOnly || d.unread > 0)
      .slice(0, opts.limit)
  }

  async searchChats(query: string): Promise<(PeerInfo & { global: boolean })[]> {
    const q = query.toLowerCase()
    return [...this.peers.values()]
      .filter(p => p.name.toLowerCase().includes(q) || p.username?.toLowerCase().includes(q))
      .map(p => ({ ...p, global: false }))
  }

  async markRead() {}

  /** Profile photos by chat id; `photoCalls` counts the fetches. Throws for ids in `photoFails`. */
  photos = new Map<number, Uint8Array>()
  photoFails = new Set<number>()
  photoCalls: number[] = []
  async profilePhoto(chatId: number): Promise<Uint8Array | null> {
    this.photoCalls.push(chatId)
    if (this.photoFails.has(chatId)) throw new Error('Telegram is reconnecting')
    return this.photos.get(chatId) ?? null
  }

  async downloadMedia(chatId: number, messageId: number, dir: string, maxBytes: number): Promise<DownloadedFile> {
    const f = this.files.get(`${chatId}:${messageId}`)
    if (!f) throw new Error(`Message #${messageId} has no attachment, nothing to download.`)
    if (f.data.length > maxBytes) throw new Error(`Message #${messageId} is over the limit.`)
    const name = downloadFileName(messageId, f)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, name), f.data)
    return { path: join(dir, name), name, size: f.data.length, mime: f.mime }
  }
}

export const LEO: PeerInfo = { id: 10, type: 'user', name: 'Leo Perera', username: 'leo_p' }
export const LEONARDO: PeerInfo = { id: 11, type: 'user', name: 'Leonardo Silva', username: 'leonardo_s' }
export const ANNA: PeerInfo = { id: 12, type: 'user', name: 'Anna K', username: 'anna_k' }
export const TEAM_QA: PeerInfo = { id: -1001234567890, type: 'group', name: 'Team QA', username: null, isForum: true }
export const ALL_HANDS: PeerInfo = { id: -1005550001111, type: 'group', name: 'Company All-Hands', username: null }
