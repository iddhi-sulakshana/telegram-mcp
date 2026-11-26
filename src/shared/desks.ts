/**
 * Desks: a named Claude session that owns some chats (config.json "desks"). Only the session holding
 * a desk hears its chats and sends to them. A proxy joins a desk with `tgmcp mcp --desk <name>`; every
 * proxy for one desk speaks as the same session, so a restart or a reconnect keeps the desk's watches.
 *
 * A desk is routing, not a permission: it never lets a session skip an approval, and the name a
 * proxy gives is taken on trust, like everything else a proxy with the daemon's token says.
 */

/** Lowercase letters, digits, - and _, starting with a letter or digit, at most 32 characters. */
export const DESK_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/

/** The desk name a proxy asked for, or null when there is none or it isn't a valid name. */
export function deskName(value: unknown): string | null {
  return typeof value === 'string' && DESK_NAME_RE.test(value) ? value : null
}

/** The one session id every proxy for this desk speaks as. */
export function deskSessionId(name: string): string {
  return `d_${name}`
}
