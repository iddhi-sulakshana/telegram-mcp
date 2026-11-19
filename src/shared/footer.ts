/**
 * The footer: a line added to every message the daemon sends from your account (Claude's messages,
 * away replies, the pager's replies), so people can tell. Changed only by hand, by the CLI or by the
 * tray, never by a session. Turning it off keeps its text as `savedFooter`, so turning it back on
 * restores it.
 */

export const DEFAULT_FOOTER = '\n\n✨ sᴇɴᴛ ᴠɪᴀ ᴄʟᴀᴜᴅᴇ'
export const FOOTER_MAX = 300

export interface FooterState {
  footer: string
  savedFooter?: string
}

export interface FooterPatch {
  /** The whole footer, leading blank line included. */
  footer?: string
  enabled?: boolean
}

/** The footer's text whether it's on or off: what the tray edits. */
export function footerText(c: FooterState): string {
  return c.footer.trim() !== '' ? c.footer : c.savedFooter?.trim() ? c.savedFooter : DEFAULT_FOOTER
}

export function footerOn(c: FooterState): boolean {
  return c.footer.trim() !== ''
}

/** Control characters other than a line break: they'd show as boxes, or not at all. */
export const CONTROL = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/u
/** Direction overrides and marks: they can flip how the message above the footer reads. */
export const BIDI = /[؜‎‏‪-‮⁦-⁩]/u
/** Characters that take no space: fine inside an emoji, but not all there is. */
const INVISIBLE = /[\s­᠎​-‍⁠﻿]/gu

/** What's wrong with footer text, or null. The tray makes the same checks (Footer.Check). */
export function footerProblem(text: string): string | null {
  if (CONTROL.test(text)) return "The footer can't contain control characters."
  if (BIDI.test(text)) return "The footer can't contain text direction marks."
  if (text.replace(INVISIBLE, '') === '') return "The footer can't be empty. Turn it off instead."
  if (text.length > FOOTER_MAX) return `The footer is too long (${FOOTER_MAX} characters at most).`
  return null
}

/** The new footer and savedFooter, or what's wrong. A rejected patch changes nothing. */
export function applyFooterPatch(
  current: FooterState,
  patch: unknown,
): { ok: true; footer: string; savedFooter: string | undefined } | { ok: false; error: string } {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) return { ok: false, error: 'send footer and/or enabled' }
  const p = patch as Record<string, unknown>
  const unknown = Object.keys(p).filter(k => k !== 'footer' && k !== 'enabled')
  if (unknown.length > 0) return { ok: false, error: `unknown setting: ${unknown.join(', ')}` }
  if (!('footer' in p) && !('enabled' in p)) return { ok: false, error: 'nothing to change: send footer or enabled' }
  if ('footer' in p && typeof p.footer !== 'string') return { ok: false, error: 'footer must be text' }
  if ('enabled' in p && typeof p.enabled !== 'boolean') return { ok: false, error: 'enabled must be true or false' }
  // Windows text boxes write \r\n; Telegram wants \n.
  const text = ((p.footer as string | undefined) ?? footerText(current)).replace(/\r\n?/g, '\n')
  const enabled = (p.enabled as boolean | undefined) ?? (p.footer !== undefined ? true : footerOn(current))
  // Switching off without new text keeps whatever is there; new text is checked either way.
  if (!enabled && p.footer === undefined) return { ok: true, footer: '', savedFooter: text.trim() === '' ? current.savedFooter : text }
  const problem = footerProblem(text)
  if (problem) return { ok: false, error: problem }
  if (!enabled) return { ok: true, footer: '', savedFooter: text }
  return { ok: true, footer: text, savedFooter: undefined }
}

export function footerSummary(c: FooterState): string {
  return footerOn(c) ? `on: ${JSON.stringify(c.footer)}` : `off (saved: ${JSON.stringify(footerText(c))})`
}

const USAGE = 'usage: footer [on | off | <text>]  (text gets a blank line before it; write \\n for a new line)'

export function parseFooterArgs(args: string[]): { kind: 'show' } | { kind: 'patch'; patch: FooterPatch } | { kind: 'error'; usage: string } {
  if (args.length === 0) return { kind: 'show' }
  if (args.length === 1 && args[0] === 'on') return { kind: 'patch', patch: { enabled: true } }
  if (args.length === 1 && args[0] === 'off') return { kind: 'patch', patch: { enabled: false } }
  const text = args.join(' ').replaceAll('\\n', '\n').trim()
  if (text === '') return { kind: 'error', usage: USAGE }
  return { kind: 'patch', patch: { footer: `\n\n${text}` } }
}
