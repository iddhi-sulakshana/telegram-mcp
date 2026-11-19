import { Chat, FileLocation, InputMedia, TelegramClient, User, type ITelegramStorageProvider, type Message, type Peer, type tl } from '@mtcute/bun'
import { formatted } from './formatting'
import { mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type {
  DialogInfo,
  DownloadedFile,
  IncomingMessage,
  MessageInfo,
  PeerInfo,
  ReadStatus,
  TelegramState,
} from '../shared/protocol'
import { downloadFileName, fmtBytes, type OutgoingFile } from '../shared/media'
import type { Credentials } from '../shared/secrets'
import { matchesChatKind, type ChatKind } from '../shared/tools'
import { oneLine } from '../shared/text'
import { SessionLockedError } from './session-store'

export interface SendOptions {
  replyTo?: number
  topicId?: number
  parseMode?: 'plain' | 'markdown' | 'html'
}

/** Where a sticker to re-send was posted. */
export interface StickerRef {
  chatId: number
  messageId: number
}

export interface SendFileOptions extends SendOptions {
  /** Send an image as a compressed photo instead of a file. */
  asPhoto?: boolean
}

/** Everything the daemon needs from Telegram. Tests swap in a fake. */
export interface TelegramPort {
  state(): TelegramState
  start(): void
  stop(): Promise<void>
  reconnect(reason: string): Promise<void>
  onMessage(cb: (msg: IncomingMessage) => void): void
  /** You read messages in a chat, on any of your devices (Telegram's read-inbox update). */
  onRead(cb: (chatId: number) => void): void
  getPeer(ref: number | string): Promise<PeerInfo>
  sendText(chatId: number, text: string, opts?: SendOptions): Promise<MessageInfo>
  sendFile(chatId: number, file: OutgoingFile, caption: string, opts?: SendFileOptions): Promise<MessageInfo>
  /** Re-send the sticker attached to an existing message (by its Telegram file id, nothing is uploaded). */
  sendSticker(chatId: number, from: StickerRef, opts?: SendOptions): Promise<MessageInfo>
  /** Delete one of your own messages for everyone. */
  deleteMessage(chatId: number, messageId: number): Promise<void>
  /** The topics of a forum group, with their ids. */
  listTopics(chatId: number): Promise<{ id: number; title: string }[]>
  /** Create a forum topic and return its id (the id of its first message). */
  createTopic(chatId: number, title: string): Promise<{ id: number }>
  /** Create a broadcast channel or a supergroup owned by this account. */
  createChat(spec: { type: 'channel' | 'supergroup'; title: string; description?: string }): Promise<PeerInfo>
  /** Make a channel or supergroup this account owns public under `username` (no @). Throws if it is taken or invalid. */
  setChatUsername(chatId: number, username: string): Promise<void>
  /** Make a supergroup the discussion group of a channel. Both need this account as an admin with the right to change info. */
  linkDiscussionGroup(channelId: number, groupId: number): Promise<void>
  /** Replace the text of one of your own text messages. */
  editMessage(chatId: number, messageId: number, text: string, opts?: { parseMode?: SendOptions['parseMode'] }): Promise<MessageInfo>
  getHistory(chatId: number, opts: { limit: number; beforeId?: number; topicId?: number }): Promise<MessageInfo[]>
  /** Who has read one of your own messages (Telegram only tells for small groups and recent messages). */
  getReadStatus(chatId: number, messageId: number): Promise<ReadStatus>
  /** Recent dialogs, newest first; `type` keeps only one kind (private chats, groups, channels or bots). */
  listDialogs(opts: { limit: number; unreadOnly: boolean; type?: ChatKind }): Promise<DialogInfo[]>
  searchChats(query: string, limit: number): Promise<(PeerInfo & { global: boolean })[]>
  markRead(chatId: number): Promise<void>
  /** Save the file attached to a message into `dir`. Refuses files over `maxBytes`. */
  downloadMedia(chatId: number, messageId: number, dir: string, maxBytes: number): Promise<DownloadedFile>
  /** The chat's small (160×160 JPEG) profile photo, or null when it has none or hides it. */
  profilePhoto(chatId: number): Promise<Uint8Array | null>
}

// ---- conversions ----------------------------------------------------------------

/**
 * Pairs each reader Telegram reports with their user by id, never by position, so a name can't land
 * on the wrong person. A reader whose user couldn't be looked up shows as their id.
 */
export function readersOf(
  parts: readonly { userId: number; date: number }[],
  users: readonly ({ id: number; displayName: string; username: string | null } | null)[],
): { id: number; name: string; username: string | null; at: string }[] {
  const byId = new Map(users.flatMap(u => (u ? [[u.id, u] as const] : [])))
  return parts.map(x => {
    const u = byId.get(Number(x.userId))
    return { id: Number(x.userId), name: u?.displayName ?? String(x.userId), username: u?.username ?? null, at: new Date(x.date * 1000).toISOString() }
  })
}

export function peerInfo(p: Peer): PeerInfo {
  if (p.type === 'user') {
    return {
      id: p.id,
      type: p.isBot ? 'bot' : 'user',
      name: p.displayName,
      username: p.username,
      isSelf: p.isSelf,
      ...(p.isSupport ? { isSupport: true } : {}),
    }
  }
  return {
    id: p.id,
    type: p.chatType === 'channel' ? 'channel' : 'group',
    name: p.displayName,
    username: p.username,
    isForum: p.isForum,
    ...(p.chatType === 'group' ? { basicGroup: true } : {}),
  }
}

/** The channel form of a resolved peer, for raw channels.* calls. */
function inputChannel(p: tl.TypeInputPeer): tl.TypeInputChannel {
  if (p._ === 'inputPeerChannel') return { _: 'inputChannel', channelId: p.channelId, accessHash: p.accessHash }
  throw new Error('That chat is not a channel or supergroup.')
}

function safeSender(m: Message): PeerInfo | null {
  try {
    return peerInfo(m.sender)
  } catch {
    return null
  }
}

/** Name and mime of a downloadable attachment; photos and voice notes have no name. */
function fileMeta(media: FileLocation & { type: string }): { name: string | null; mime: string | null } {
  const doc = media as FileLocation & { fileName?: unknown; mimeType?: unknown }
  const name = typeof doc.fileName === 'string' && doc.fileName ? doc.fileName : null
  const mime = typeof doc.mimeType === 'string' && doc.mimeType ? doc.mimeType : media.type === 'photo' ? 'image/jpeg' : null
  return { name, mime }
}

/** "document: report.pdf, 1.2 MB", so a reader can tell what telegram_download_media would fetch. */
function mediaLabel(media: Message['media']): string | null {
  if (!media) return null
  if (!(media instanceof FileLocation)) return media.type
  const name = fileMeta(media).name
  const detail = [name ? oneLine(name) : null, media.fileSize ? fmtBytes(media.fileSize) : null].filter(Boolean).join(', ')
  return detail ? `${media.type}: ${detail}` : media.type
}

export function messageInfo(m: Message): MessageInfo {
  const reply = m.replyToMessage
  const topicId = reply?.threadId ?? null
  let replyToId = reply?.id ?? null
  // In a forum, a message "replying" to the topic root is just a message in that topic.
  if (reply?.isForumTopic && replyToId === topicId) replyToId = null
  return {
    id: m.id,
    chatId: m.chat.id,
    date: m.date.toISOString(),
    from: safeSender(m),
    outgoing: m.isOutgoing,
    text: m.text,
    media: mediaLabel(m.media),
    replyToId,
    topicId,
    ...(m.forward ? { forwarded: true } : {}),
  }
}

function markedFromTlPeer(p: tl.TypePeer): number {
  if (p._ === 'peerUser') return p.userId
  if (p._ === 'peerChat') return -p.chatId
  return -1_000_000_000_000 - p.channelId
}

const LOGGED_OUT = new Set([
  'AUTH_KEY_UNREGISTERED',
  'AUTH_KEY_INVALID',
  'SESSION_REVOKED',
  'SESSION_EXPIRED',
  'USER_DEACTIVATED',
  'USER_DEACTIVATED_BAN',
])

function isLoggedOutError(e: unknown): boolean {
  const text = (e as { text?: unknown })?.text
  return typeof text === 'string' && LOGGED_OUT.has(text)
}

/** Retrying can't fix these: the api_id/api_hash themselves are wrong. */
function isBadCredentialsError(e: unknown): boolean {
  const text = (e as { text?: unknown })?.text
  return typeof text === 'string' && (text === 'API_ID_INVALID' || text === 'API_ID_PUBLISHED_FLOOD')
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000}s`)), ms)
    p.then(
      v => {
        clearTimeout(timer)
        resolve(v)
      },
      e => {
        clearTimeout(timer)
        reject(e)
      },
    )
  })
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// ---- the real client, with a supervisor around it ------------------------------------

export interface MtcuteOptions {
  /** Opens session.db for one client. A SessionLockedError means only `tgmcp login` can help. */
  openStorage: () => Promise<ITelegramStorageProvider>
  /** Reads api_id/api_hash. Throws when the keystore can't be read (retried with backoff). */
  loadCredentials: () => Promise<Credentials | null>
  log: (msg: string) => void
  /** How often the watchdog checks the connection. */
  tickMs?: number
  /** A tick this much later than scheduled means the machine slept. */
  sleepGapMs?: number
  /** Give up on mtcute's own reconnect and rebuild the client after this long without a connection. */
  stuckMs?: number
}

/**
 * Owns the mtcute client and keeps it alive without a human:
 * - mtcute reconnects dropped sockets by itself;
 * - a watchdog pings Telegram every tick and rebuilds the client when pings fail,
 *   when it's been stuck "connecting" too long, or right after the Mac wakes from sleep;
 * - rebuilds retry forever with backoff (capped at a minute);
 * - only a revoked or missing login stops it, because that needs `tgmcp login`.
 * If the process itself dies, launchd starts it again.
 */
export class MtcuteTelegram implements TelegramPort {
  #client: TelegramClient | null = null
  #state: TelegramState = { phase: 'starting', me: null, since: Date.now(), reconnects: 0, lastError: null }
  #listeners: ((msg: IncomingMessage) => void)[] = []
  #readListeners: ((chatId: number) => void)[] = []
  #restarting: Promise<void> | null = null
  #timer: ReturnType<typeof setInterval> | null = null
  #stopped = false
  #lastTick = Date.now()
  #notConnectedSince: number | null = null
  #pingFailures = 0
  #seen = new Set<string>()
  readonly #o: Required<MtcuteOptions>

  constructor(opts: MtcuteOptions) {
    this.#o = { tickMs: 30_000, sleepGapMs: 90_000, stuckMs: 90_000, ...opts }
  }

  state(): TelegramState {
    return { ...this.#state }
  }

  onRead(cb: (chatId: number) => void): void {
    this.#readListeners.push(cb)
  }

  onMessage(cb: (msg: IncomingMessage) => void): void {
    this.#listeners.push(cb)
  }

  start(): void {
    this.#stopped = false
    void this.#rebuild('startup')
    this.#timer ??= setInterval(() => void this.#tick(), this.#o.tickMs)
  }

  async stop(): Promise<void> {
    this.#stopped = true
    if (this.#timer) clearInterval(this.#timer)
    this.#timer = null
    await this.#teardown()
  }

  async reconnect(reason: string): Promise<void> {
    this.#stopped = false
    if (this.#restarting) await this.#restarting
    await this.#rebuild(reason)
  }

  #setPhase(phase: TelegramState['phase'], patch: Partial<TelegramState> = {}) {
    if (this.#state.phase !== phase) this.#o.log(`telegram: ${this.#state.phase} -> ${phase}`)
    this.#state = { ...this.#state, ...patch, phase, since: this.#state.phase === phase ? this.#state.since : Date.now() }
  }

  async #teardown() {
    const c = this.#client
    this.#client = null
    if (c) await withTimeout(c.destroy(), 10_000, 'closing the old client').catch(e => this.#o.log(`telegram: ${errText(e)}`))
  }

  /** Single-flight: concurrent callers share one rebuild. */
  #rebuild(reason: string): Promise<void> {
    if (this.#restarting) return this.#restarting
    this.#restarting = this.#rebuildLoop(reason).finally(() => {
      this.#restarting = null
    })
    return this.#restarting
  }

  async #rebuildLoop(reason: string) {
    this.#o.log(`telegram: (re)connecting, reason: ${reason}`)
    let attempt = 0
    const backoff = async (why: string) => {
      attempt++
      const delay = Math.min(60_000, 1_000 * 2 ** Math.min(attempt, 6))
      this.#state.lastError = `${why} (retrying in ${Math.round(delay / 1000)}s)`
      this.#o.log(`telegram: connect failed: ${this.#state.lastError}`)
      await sleep(delay)
    }
    while (!this.#stopped) {
      let creds: Credentials | null
      let storage: ITelegramStorageProvider
      try {
        creds = await this.#o.loadCredentials()
        if (!creds) {
          await this.#teardown()
          this.#setPhase('no_credentials', { lastError: 'No API id/hash. Run `tgmcp login`.' })
          return
        }
        // The old client holds session.db open; close it before opening it again.
        await this.#teardown()
        storage = await this.#o.openStorage()
      } catch (e) {
        if (e instanceof SessionLockedError) {
          await this.#teardown()
          this.#setPhase('logged_out', { me: null, lastError: e.message })
          return
        }
        // The keystore may be locked or waiting for a click; that passes, so keep trying.
        await this.#teardown()
        this.#setPhase('connecting')
        await backoff(errText(e))
        continue
      }
      this.#setPhase('connecting')
      this.#notConnectedSince ??= Date.now()
      const client = new TelegramClient({
        apiId: creds.apiId,
        apiHash: creds.apiHash,
        storage,
        updates: { catchUp: true },
        logLevel: 2,
      })
      this.#client = client
      client.onConnectionState.add(s => this.#onConnection(client, s))
      client.onNewMessage.add(m => this.#onNewMessage(client, m))
      client.onHistoryRead.add(u => {
        // Inbox only: someone reading what you sent says nothing about you.
        if (client !== this.#client || u.isOutbox) return
        for (const cb of this.#readListeners) {
          try {
            cb(u.chatId)
          } catch (e) {
            this.#o.log(`telegram: read listener failed: ${errText(e)}`)
          }
        }
      })
      client.onError.add(e => this.#o.log(`telegram client error: ${errText(e)}`))
      try {
        // Not client.start(): the Bun wrapper would prompt on stdin for a phone number and hang the daemon.
        const me = await withTimeout(client.getMe(), 60_000, 'getMe')
        await client.notifyLoggedIn(me.raw)
        if (reason !== 'startup') this.#state.reconnects++
        this.#pingFailures = 0
        this.#notConnectedSince = null
        this.#setPhase('connected', { me: peerInfo(me), lastError: null })
        return
      } catch (e) {
        if (isLoggedOutError(e)) {
          await this.#teardown()
          this.#setPhase('logged_out', { me: null, lastError: 'Not logged in (or the session was revoked). Run `tgmcp login`.' })
          return
        }
        if (isBadCredentialsError(e)) {
          await this.#teardown()
          this.#setPhase('no_credentials', { me: null, lastError: `Telegram rejected the api_id/api_hash (${errText(e)}). Run \`tgmcp login --credentials\` to enter them again.` })
          return
        }
        await backoff(errText(e))
      }
    }
  }

  #onConnection(client: TelegramClient, s: string) {
    if (client !== this.#client || this.#restarting) return
    if (s === 'connected' || s === 'updating') {
      this.#notConnectedSince = null
      if (this.#state.phase === 'connecting') this.#setPhase('connected')
    } else {
      this.#notConnectedSince ??= Date.now()
      if (this.#state.phase === 'connected') this.#setPhase('connecting')
    }
  }

  #onNewMessage(client: TelegramClient, m: Message) {
    if (client !== this.#client) return
    // Catch-up after a reconnect can replay messages; notify each one once.
    const key = `${m.chat.id}:${m.id}`
    if (this.#seen.has(key)) return
    this.#seen.add(key)
    if (this.#seen.size > 5_000) this.#seen = new Set([...this.#seen].slice(-2_500))
    let msg: IncomingMessage
    try {
      msg = { ...messageInfo(m), chat: peerInfo(m.chat) }
    } catch (e) {
      this.#o.log(`telegram: could not read an incoming message: ${errText(e)}`)
      return
    }
    for (const cb of this.#listeners) {
      try {
        cb(msg)
      } catch (e) {
        this.#o.log(`telegram: message listener failed: ${errText(e)}`)
      }
    }
  }

  async #tick() {
    const now = Date.now()
    const slept = now - this.#lastTick > this.#o.sleepGapMs
    this.#lastTick = now
    if (this.#stopped || this.#restarting) return
    const { phase } = this.#state
    if (phase === 'logged_out' || phase === 'no_credentials' || phase === 'starting') return
    if (slept) this.#o.log('telegram: woke from sleep, checking the connection')

    if (phase === 'connecting' && this.#notConnectedSince && now - this.#notConnectedSince > this.#o.stuckMs) {
      void this.#rebuild(`no connection for ${Math.round((now - this.#notConnectedSince) / 1000)}s`)
      return
    }
    const client = this.#client
    if (!client) {
      void this.#rebuild('no client')
      return
    }
    try {
      await withTimeout(client.call({ _: 'updates.getState' }), 15_000, 'ping')
      this.#pingFailures = 0
    } catch (e) {
      if (isLoggedOutError(e)) {
        await this.#teardown()
        this.#setPhase('logged_out', { me: null, lastError: 'Session revoked. Run `tgmcp login`.' })
        return
      }
      this.#pingFailures++
      this.#o.log(`telegram: ping failed (${this.#pingFailures}): ${errText(e)}`)
      if (slept || this.#pingFailures >= 2) void this.#rebuild('ping failed')
    }
  }

  /** Waits briefly for a connection so a call during a reconnect succeeds instead of failing. */
  async #ready(timeoutMs = 25_000): Promise<TelegramClient> {
    const deadline = Date.now() + timeoutMs
    while (true) {
      const { phase, lastError } = this.#state
      if (phase === 'logged_out' || phase === 'no_credentials') throw new Error(lastError ?? 'Not logged in. Run `tgmcp login`.')
      if (phase === 'connected' && this.#client && !this.#restarting) return this.#client
      if (Date.now() > deadline) {
        throw new Error(`Telegram is reconnecting (${lastError ?? phase}). The daemon keeps retrying on its own; try again shortly.`)
      }
      await sleep(250)
    }
  }

  async getPeer(ref: number | string): Promise<PeerInfo> {
    const c = await this.#ready()
    const input = typeof ref === 'string' ? ref.replace(/^@/, '') : ref
    return peerInfo(await c.getPeer(input))
  }

  async sendText(chatId: number, text: string, opts: SendOptions = {}): Promise<MessageInfo> {
    const c = await this.#ready()
    const body = formatted(text, opts.parseMode)
    const sent = await c.sendText(chatId, body, {
      ...(opts.replyTo ? { replyTo: opts.replyTo } : {}),
      ...(opts.topicId ? { threadId: opts.topicId } : {}),
    })
    return messageInfo(sent)
  }

  async sendFile(chatId: number, file: OutgoingFile, caption: string, opts: SendFileOptions = {}): Promise<MessageInfo> {
    const c = await this.#ready()
    const text = formatted(caption, opts.parseMode)
    // mtcute reads a bare string as a Telegram file id; "file:" marks a local path.
    const local = `file:${file.path}`
    const media = opts.asPhoto
      ? InputMedia.photo(local, { caption: text })
      : InputMedia.document(local, { caption: text, fileName: file.name, fileSize: file.size })
    const sent = await c.sendMedia(chatId, media, {
      ...(opts.replyTo ? { replyTo: opts.replyTo } : {}),
      ...(opts.topicId ? { threadId: opts.topicId } : {}),
    })
    return messageInfo(sent)
  }

  async deleteMessage(chatId: number, messageId: number): Promise<void> {
    const c = await this.#ready()
    await c.deleteMessagesById(chatId, [messageId], { revoke: true })
  }

  async listTopics(chatId: number): Promise<{ id: number; title: string }[]> {
    const c = await this.#ready()
    const topics = await c.getForumTopics(chatId, { limit: 100 })
    return topics.map(t => ({ id: t.id, title: t.title }))
  }

  async createTopic(chatId: number, title: string): Promise<{ id: number }> {
    const c = await this.#ready()
    const created = await c.createForumTopic({ chatId, title })
    return { id: created.id }
  }

  async createChat(spec: { type: 'channel' | 'supergroup'; title: string; description?: string }): Promise<PeerInfo> {
    const c = await this.#ready()
    const params = { title: spec.title, ...(spec.description ? { description: spec.description } : {}) }
    const chat = spec.type === 'channel' ? await c.createChannel(params) : await c.createSupergroup(params)
    return peerInfo(chat)
  }

  async setChatUsername(chatId: number, username: string): Promise<void> {
    const c = await this.#ready()
    await c.setChatUsername(chatId, username)
  }

  async linkDiscussionGroup(channelId: number, groupId: number): Promise<void> {
    const c = await this.#ready()
    const group = await c.getChat(groupId)
    // Telegram links only supergroups; a basic group has to be upgraded first (Telegram does that when
    // its owner makes it public or turns on topics, for example).
    if (group.chatType !== 'supergroup' && group.chatType !== 'gigagroup') {
      throw new Error(`${group.displayName} is a ${group.chatType}, not a supergroup, so it can't be a channel's discussion group.`)
    }
    await c.call({
      _: 'channels.setDiscussionGroup',
      broadcast: inputChannel(await c.resolvePeer(channelId)),
      group: inputChannel(await c.resolvePeer(groupId)),
    })
  }

  async editMessage(chatId: number, messageId: number, text: string, opts: { parseMode?: SendOptions['parseMode'] } = {}): Promise<MessageInfo> {
    const c = await this.#ready()
    const edited = await c.editMessage({ chatId, message: messageId, text: formatted(text, opts.parseMode) })
    return messageInfo(edited)
  }

  async sendSticker(chatId: number, from: StickerRef, opts: SendOptions = {}): Promise<MessageInfo> {
    const c = await this.#ready()
    const [m] = await c.getMessages(from.chatId, [from.messageId])
    if (!m) throw new Error(`Message #${from.messageId} not found in that chat.`)
    if (m.media?.type !== 'sticker') {
      throw new Error(`Message #${from.messageId} has ${m.media ? `a ${m.media.type}` : 'no attachment'}, not a sticker.`)
    }
    const sent = await c.sendMedia(chatId, m.media.fileId, {
      ...(opts.replyTo ? { replyTo: opts.replyTo } : {}),
      ...(opts.topicId ? { threadId: opts.topicId } : {}),
    })
    return messageInfo(sent)
  }

  async getHistory(chatId: number, opts: { limit: number; beforeId?: number; topicId?: number }): Promise<MessageInfo[]> {
    const c = await this.#ready()
    const list = opts.topicId
      ? await c.searchMessages({ chatId, threadId: opts.topicId, limit: opts.limit, maxId: opts.beforeId, query: '' })
      : await c.getHistory(chatId, { limit: opts.limit, maxId: opts.beforeId })
    return [...list].map(messageInfo).reverse()
  }

  async getReadStatus(chatId: number, messageId: number): Promise<ReadStatus> {
    const c = await this.#ready()
    const [m] = await c.getMessages(chatId, [messageId])
    if (!m) throw new Error(`Message #${messageId} not found in that chat.`)
    if (!m.isOutgoing) throw new Error(`Message #${messageId} was not sent from your account: only your own messages have read receipts.`)
    const peer = await c.resolvePeer(chatId)
    if (peer._ === 'inputPeerUser' || peer._ === 'inputPeerSelf') {
      const r = await c.call({ _: 'messages.getPeerDialogs', peers: [{ _: 'inputDialogPeer', peer }] })
      const d = r.dialogs[0]
      if (!d || d._ !== 'dialog') throw new Error('Telegram did not return this chat\'s read state.')
      return { kind: 'private', seen: messageId <= d.readOutboxMaxId }
    }
    let parts
    try {
      parts = await c.call({ _: 'messages.getMessageReadParticipants', peer, msgId: messageId })
    } catch (e) {
      const text = e instanceof Error ? e.message : String(e)
      if (/CHAT_TOO_BIG/.test(text)) throw new Error('Telegram only tells who read a message in groups of up to 100 people.')
      if (/MSG_TOO_OLD/.test(text)) throw new Error('Telegram only tells who read a message for about a week after it was sent.')
      throw e
    }
    // One lookup per reader (mtcute batches them). getUsers with a list silently drops anyone missing
    // from the peer cache (e.g. a member who never posts), which would shift names onto the wrong people.
    const users = await Promise.all(parts.map(x => c.getUsers(x.userId).then(([u]) => u ?? null, () => null)))
    return { kind: 'group', readers: readersOf(parts, users) }
  }

  async downloadMedia(chatId: number, messageId: number, dir: string, maxBytes: number): Promise<DownloadedFile> {
    const c = await this.#ready()
    const [m] = await c.getMessages(chatId, [messageId])
    if (!m) throw new Error(`Message #${messageId} not found in that chat.`)
    const media = m.media
    if (!(media instanceof FileLocation)) {
      throw new Error(`Message #${messageId} has ${media ? `a ${media.type}` : 'no attachment'}, nothing to download.`)
    }
    if (media.fileSize && media.fileSize > maxBytes) {
      throw new Error(`Message #${messageId} is ${fmtBytes(media.fileSize)}, over the ${fmtBytes(maxBytes)} limit (raise maxMb).`)
    }
    const { name, mime } = fileMeta(media)
    const fileName = downloadFileName(messageId, { name, type: media.type, mime })
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const path = join(dir, fileName)
    // Write to a side file first so a half-finished download never sits under the real name.
    const part = `${path}.part`
    try {
      await c.downloadToFile(part, media)
      renameSync(part, path)
    } catch (e) {
      rmSync(part, { force: true })
      throw e
    }
    return { path, name: fileName, size: statSync(path).size, mime }
  }

  async profilePhoto(chatId: number): Promise<Uint8Array | null> {
    const c = await this.#ready()
    const photo = (await c.getPeer(chatId)).photo
    return photo ? c.downloadAsBuffer(photo.small) : null
  }

  async listDialogs(opts: { limit: number; unreadOnly: boolean; type?: ChatKind }): Promise<DialogInfo[]> {
    const c = await this.#ready()
    const kind = opts.type ?? 'all'
    // Filtering skips dialogs, so look further back to still fill the limit.
    const filtered = opts.unreadOnly || kind !== 'all'
    const out: DialogInfo[] = []
    for await (const d of c.iterDialogs({ limit: filtered ? Math.max(opts.limit * 5, 200) : opts.limit })) {
      if (opts.unreadOnly && d.unreadCount === 0) continue
      const peer = peerInfo(d.peer)
      if (!matchesChatKind(peer.type, kind)) continue
      const last = d.lastMessage
      out.push({
        peer,
        unread: d.unreadCount,
        pinned: d.isPinned,
        lastMessage: last ? { id: last.id, date: last.date.toISOString(), text: last.text, outgoing: last.isOutgoing } : null,
      })
      if (out.length >= opts.limit) break
    }
    return out
  }

  async searchChats(query: string, limit: number): Promise<(PeerInfo & { global: boolean })[]> {
    const c = await this.#ready()
    const res = await c.call({ _: 'contacts.search', q: query, limit })
    const mine = new Set(res.myResults.map(markedFromTlPeer))
    const peers: PeerInfo[] = [
      ...res.users.filter(u => u._ === 'user').map(u => peerInfo(new User(u))),
      ...res.chats.map(ch => peerInfo(new Chat(ch))),
    ]
    return peers.map(p => ({ ...p, global: !mine.has(p.id) })).sort((a, b) => Number(a.global) - Number(b.global))
  }

  async markRead(chatId: number): Promise<void> {
    const c = await this.#ready()
    await c.readHistory(chatId)
  }
}
