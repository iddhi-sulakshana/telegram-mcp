import { isListed, type Config } from './config'

export type Decision =
  | { action: 'send'; reason: string }
  | { action: 'approve'; reason: string }
  | { action: 'block'; reason: string }

/**
 * Who may send where. Order matters and the safer answer wins:
 * blocked > requireApproval > autoSend > autoReply (only while watching) > defaultPolicy.
 *
 * A file always asks, whatever the lists, a watch or a /reply handover say: a file can carry
 * anything on this machine, and the request for it may have come from a chat the session reads,
 * not from you. This only turns a "send" into an "approve"; it never loosens anything, so a
 * blocked chat stays blocked.
 */
export function decideSend(
  config: Config,
  chat: { id: number; username?: string | null },
  ctx: { isWatching: boolean; file?: boolean; takenOver?: boolean },
): Decision {
  const d = decideText(config, chat, ctx)
  if (d.action === 'send' && ctx.file) {
    return { action: 'approve', reason: 'files always need approval, whatever the chat rules say' }
  }
  return d
}

function decideText(
  config: Config,
  chat: { id: number; username?: string | null },
  ctx: { isWatching: boolean; takenOver?: boolean },
): Decision {
  if (isListed(config, 'blocked', chat)) return { action: 'block', reason: 'this chat is on the blocked list' }
  // The owner typed /reply in this very chat: that is a yes for this chat, for as long as the takeover lasts.
  if (ctx.takenOver) return { action: 'send', reason: 'the user handed this chat over with /reply' }
  if (isListed(config, 'requireApproval', chat))
    return { action: 'approve', reason: 'this chat is on the requireApproval list' }
  if (isListed(config, 'autoSend', chat)) return { action: 'send', reason: 'this chat is on the autoSend list' }
  if (isListed(config, 'autoReply', chat)) {
    return ctx.isWatching
      ? { action: 'send', reason: 'autoReply chat that this session is watching' }
      : { action: 'approve', reason: 'autoReply chats only send without asking while this session watches them' }
  }
  return config.defaultPolicy === 'block'
    ? { action: 'block', reason: 'this chat is in no list and defaultPolicy is "block"' }
    : { action: 'approve', reason: 'this chat is in no list, so it needs approval (defaultPolicy "approve")' }
}

/** Short label for listings: what would happen if a session sent here now. */
export function policyLabel(config: Config, chat: { id: number; username?: string | null }): string {
  if (isListed(config, 'blocked', chat)) return 'blocked'
  if (isListed(config, 'requireApproval', chat)) return 'needs approval'
  if (isListed(config, 'autoSend', chat)) return 'auto-send'
  if (isListed(config, 'autoReply', chat)) return 'auto-reply while watched'
  return config.defaultPolicy === 'block' ? 'blocked (default)' : 'needs approval (default)'
}

/**
 * The footer written in the message's parse mode, so it reads exactly as typed: markdown characters
 * are escaped (a footer with * or _ would otherwise turn bold or swallow its markers), and in html
 * <, > and & are escaped and line breaks become <br> (html drops plain line breaks).
 */
export function footerFor(footer: string, parseMode: 'plain' | 'markdown' | 'html' = 'plain'): string {
  if (parseMode === 'markdown') return footer.replace(/[\\*_~`[\]()|>]/g, '\\$&')
  if (parseMode === 'html') return footer.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')
  return footer
}

/**
 * Takes an earlier footer off the end of a text, as written plain or in the parse mode: a session
 * editing a message it copied, footer and all, after the footer changed.
 */
export function withoutFooter(text: string, footer: string, parseMode: 'plain' | 'markdown' | 'html' = 'plain'): string {
  const body = text.trimEnd()
  for (const mark of [footerFor(footer, parseMode).trim(), footer.trim()]) {
    if (mark !== '' && body.endsWith(mark)) return body.slice(0, body.length - mark.length).trimEnd()
  }
  return text
}

/** Appends the footer once, in the message's parse mode. Text that already ends with it is left alone. */
export function withFooter(text: string, footer: string, parseMode: 'plain' | 'markdown' | 'html' = 'plain'): string {
  if (footer.trim() === '') return text
  const written = footerFor(footer, parseMode)
  const body = text.trimEnd()
  if (body.endsWith(written.trim()) || body.endsWith(footer.trim())) return body
  return body + written
}
