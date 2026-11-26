import type { PeerType } from './config'

// ---- Telegram data as the daemon hands it around ---------------------------------

export interface PeerInfo {
  id: number
  type: PeerType
  name: string
  username: string | null
  isSelf?: boolean
  isForum?: boolean
  /** A Telegram support account: type 'user', but not a person to send an away reply to. */
  isSupport?: boolean
  /** A basic (legacy) group, not a supergroup: type 'group' too, but it can't be a channel's discussion group. */
  basicGroup?: boolean
}

/**
 * The header a menu bar or tray app sends on /ui requests to say which newer approval kinds it can
 * show, comma separated. `create`: it shows a new-chat card as one (Create / Deny), not as a send.
 * An app that doesn't send it never sees a create card and can't decide one.
 */
export const UI_FEATURES_HEADER = 'x-tgmcp-features'
export type UiFeature = 'create'

export interface MessageInfo {
  id: number
  chatId: number
  date: string
  from: PeerInfo | null
  outgoing: boolean
  text: string
  media: string | null
  replyToId: number | null
  topicId: number | null
  /** Forwarded from somewhere else: the sender here didn't write it. Absent when not forwarded. */
  forwarded?: boolean
}

/**
 * Who has read one of your messages, as Telegram reports it. In a private chat it is only whether
 * the other person has read up to it; in a small group it is the people who did, with the time.
 */
export type ReadStatus =
  | { kind: 'private'; seen: boolean }
  | { kind: 'group'; readers: { id: number; name: string; username: string | null; at: string }[] }

/** A message's attachment saved to disk. */
export interface DownloadedFile {
  path: string
  name: string
  size: number
  mime: string | null
}

export interface IncomingMessage extends MessageInfo {
  chat: PeerInfo
}

export interface DialogInfo {
  peer: PeerInfo
  unread: number
  pinned: boolean
  lastMessage: { id: number; date: string; text: string; outgoing: boolean } | null
}

export type ConnectionPhase = 'starting' | 'connecting' | 'connected' | 'logged_out' | 'no_credentials'

export interface TelegramState {
  phase: ConnectionPhase
  me: PeerInfo | null
  since: number
  reconnects: number
  lastError: string | null
}

// ---- watches and the events they produce -----------------------------------------

export interface WatchSpec {
  id: string
  chatId: number
  chatLabel: string
  fromId?: number
  fromLabel?: string
  topicId?: number
  note?: string
  createdAt: number
}

export interface TgEvent {
  seq: number
  watchIds: string[]
  chatId: number
  chatLabel: string
  chatNickname?: string
  fromId: number | null
  fromName: string
  fromUsername: string | null
  messageId: number
  topicId: number | null
  replyToId: number | null
  text: string
  media: string | null
  date: string
  /** Set on the notices "/reply" sends: a chat was handed to this session, or taken back. */
  takeover?: { action: 'start'; instruction: string; minutes: number } | { action: 'stop' }
  /** Set on the notices a moderator's /bots command sends: this chat (or every chat) is paused, or no longer. */
  moderation?: { action: 'pause'; all: boolean; until: string; minutes: number } | { action: 'resume'; all: boolean }
}

// ---- tool results ------------------------------------------------------------------

/**
 * What waits for a yes: a new message, or an edit or delete of one a session sent, where sending
 * needs approval (the chat sees the change, so it needs the same yes as a send). Or a new channel or
 * supergroup (telegram_create_chat), which always waits, and only the menu bar or tray can approve.
 * An app older than `create` shows it as a send: `to` and `text` describe the new chat in full.
 */
export type ApprovalAction = 'send' | 'edit' | 'delete' | 'create'

export interface ApprovalRequest {
  id: string
  /** Absent from a daemon older than edit and delete approvals: a send. */
  action?: ApprovalAction
  /** The message an edit or delete is for. */
  messageId?: number
  /** An edit: the text the chat sees now (`text` is the new text). A delete: absent, `text` is the message to remove. */
  previousText?: string
  to: string
  /** The chat's id (absent for a new chat, which has none yet, and from an older daemon). */
  chatId?: number
  /** The chat as the menu bar and tray cards show it next to `to`: name, @username, id and type (fmtPeer). */
  detail?: string
  text: string
  reason: string
  /** The menu bar app is running, so the decision is made there. */
  uiActive: boolean
  /**
   * Set only when uiActive is false: the key the proxy sends back with its dialog's answer (__decide).
   * It reaches only the session that asked, and the proxy never shows it to the model.
   */
  dialogKey?: string
  /** First message to a chat on neither autoSend nor requireApproval: the approver also picks which list it joins. */
  firstTime: boolean
  nickname: string | null
  suggestedNickname: string
}

// ---- what the menu bar app shows ----------------------------------------------------

export interface SentRecord {
  at: string
  chatId: number
  chatLabel: string
  text: string
  messageId: number
  /** auto = allowed by the rules; menubar / dialog / chat = approved there. */
  via: 'auto' | 'menubar' | 'dialog' | 'chat' | 'away'
  sessionLabel: string | null
  /**
   * The Claude session that wrote it: its own sends and the drafts it got approved. Absent for the
   * pager's replies, away replies and the Page button, which no session wrote. Only this session may
   * edit the message (telegram_edit_message).
   */
  sessionId?: string
  /** What went out. Only a text message can be edited. */
  kind?: 'text' | 'file' | 'sticker'
  /** The footer it carries (a text message), so an edit after the footer changed can take the old one off. */
  footer?: string
  /** Set once a session edited it: when, by which session, and the text before the first edit. */
  edited?: { at: string; by: string | null; original: string }
}

export interface UiApproval {
  id: string
  /**
   * send: a new message (text). edit: messageId would change from previousText to text. delete: messageId,
   * saying text, would go for everyone. create: a new chat named in `to`, described in `text` (chatId 0).
   */
  action: ApprovalAction
  messageId: number | null
  previousText: string | null
  /** The chat it goes to, for its avatar (GET /ui/avatars/:chatId). 0 for a create: the chat doesn't exist yet. */
  chatId: number
  to: string
  detail: string
  text: string
  reason: string
  sessionId: string
  sessionLabel: string
  createdAt: string
  expiresAt: string
  firstTime: boolean
  nickname: string | null
  suggestedNickname: string
}

export interface UiSession {
  id: string
  label: string
  connected: boolean
  channel: boolean
  monitors: number
  pending: number
  watches: WatchSpec[]
  /** The desk this session holds, if any. */
  desk?: string
}

/**
 * Which sending list decides a chat, the safest one winning as in the policy:
 * blocked > requireApproval > autoSend. `none` = in none of them, so defaultPolicy applies.
 */
export type SendMode = 'autoSend' | 'requireApproval' | 'blocked' | 'none'

/** A saved chat (`chats` in the rules file) and the rules that apply to it, for the Contacts page. */
export interface UiContact {
  nickname: string
  chatId: number
  name: string | null
  username: string | null
  type: PeerType | null
  topicId: number | null
  aliases: string[]
  notes: string | null
  sendMode: SendMode
  /** On the autoReply list: sessions may watch it and reply without asking while they do. */
  autoReply: boolean
  /** What sending there does now, in words (the same label telegram_get_rules shows). */
  policy: string
  /** Other nicknames saved for the same chat. Rules are per chat, so they change together. */
  sameChat: string[]
  /** A person other than you: they can be on paging.pageFrom, and the Page button can page them. */
  pageable: boolean
  /** On paging.pageFrom: their "/page <reason>" rings you. */
  pageFrom: boolean
}

export interface UiState {
  telegram: TelegramState
  configError: string | null
  /** Added to every message; '' while it's off. */
  footer: string
  /** The footer's text even while it's off, for the tray's editor. */
  footerText: string
  footerOn: boolean
  defaultPolicy: 'approve' | 'block'
  approvals: UiApproval[]
  sessions: UiSession[]
  recent: SentRecord[]
  contacts: UiContact[]
  /** Pages still waiting for someone: the menu bar and tray ring while any is ringing or unanswered. */
  pages: UiPage[]
  away: UiAway
  /** Moderator commands: whether they apply to this account, and the pauses in force. */
  moderation: UiModeration
}

export interface UiModeration {
  enabled: boolean
  moderators: number[]
  /** False when this account is a moderator itself: then /bots commands never pause it. */
  appliesHere: boolean
  pauses: { chatId: number | null; chatLabel: string; until: string; by: number; byName: string }[]
}

/**
 * The away auto-reply as the tray shows it. `from`, `until`, `message` and `preview` are the schedule
 * replying now (else the first one switched on), for apps that know a single window.
 */
export interface UiAway {
  enabled: boolean
  from: string
  until: string
  message: string
  quietMinutes: number
  active: boolean
  nextChange: string | null
  preview: string
  /** The id of the schedule replying now, and when its window ends. */
  current: string | null
  currentUntil: string | null
  /** Chats whose reply is waiting for you right now (a schedule's delay). */
  waiting: number
  schedules: UiAwaySchedule[]
  /**
   * away.skip: chats that never get an away reply. `ref` as saved (send it back unchanged to keep it),
   * `chatId` the chat it points at (a saved chat's id, or a numeric ref's own id even when that chat
   * isn't saved), or null when it names no chat yet (an unsaved nickname or @username).
   */
  skip: { ref: string | number; chatId: number | null }[]
}

export interface UiAwaySchedule {
  id: string
  name: string
  enabled: boolean
  from: string
  until: string
  /** 0 = Sunday … 6 = Saturday. */
  days: number[]
  startDate: string | null
  endDate: string | null
  delaySeconds: number
  repeatMinutes: number
  message: string
  /** This one is replying now. */
  active: boolean
  /** What a sender gets, footer included. */
  preview: string
}

export interface UiPage {
  id: string
  source: 'command' | 'keyword' | 'claude' | 'test'
  /** ringing: alarm on. unanswered: the phone tries ran out, the alarm keeps going. snoozed: quiet until snoozedUntil. */
  state: 'ringing' | 'unanswered' | 'snoozed'
  from: string
  chat: string | null
  chatId: number | null
  messageId: number | null
  reason: string
  createdAt: string
  snoozedUntil: string | null
}

export interface ToolResult {
  text: string
  isError?: boolean
  /** Set when a send is waiting for a human yes. */
  approval?: ApprovalRequest
}

// ---- bridge protocol: per-session MCP proxy <-> daemon, JSON over one WebSocket ----

export type ClientMessage =
  /**
   * `desk`: the proxy was started with --desk; it then speaks as that desk's session (shared/desks.ts).
   * `startedAt`: when the proxy started (ms); of two proxies for one desk, the newer holds it.
   */
  | { t: 'hello'; sessionId: string; label: string; channel: boolean; watches: WatchSpec[]; desk?: string; startedAt?: number }
  | { t: 'call'; id: number; method: string; params: unknown }

export type ServerMessage =
  | { t: 'welcome'; telegram: TelegramState }
  | { t: 'result'; id: number; ok: true; result: ToolResult; pending: number }
  | { t: 'result'; id: number; ok: false; error: string }
  | { t: 'event'; event: TgEvent }
  | { t: 'watches'; watches: WatchSpec[] }
