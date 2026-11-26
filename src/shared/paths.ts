import { homedir } from 'node:os'
import { join } from 'node:path'

export const LAUNCHD_LABEL = 'com.telegram-mcp.daemon'
export const DEFAULT_PORT = 47823

export interface Paths {
  home: string
  config: string
  /** The next five are only used with TELEGRAM_MCP_SECRET_STORE=file (or found from an older version). */
  credentials: string
  token: string
  /** The menu bar and tray apps' token (secret "ui-token"). */
  uiToken: string
  sessionKey: string
  pageBot: string
  session: string
  log: string
  /** One line per page, ack, snooze and retry. */
  pages: string
  /** Where telegram_download_media saves files, one folder per chat. */
  downloads: string
  /** Contacts' small profile photos for the menu bar and tray avatars (see AvatarCache). */
  avatars: string
}

export const defaultHome = () => join(homedir(), '.config', 'telegram-mcp')

/** Everything lives in one folder, `~/.config/telegram-mcp` unless TELEGRAM_MCP_HOME says otherwise. */
export function getPaths(home = process.env.TELEGRAM_MCP_HOME || defaultHome()): Paths {
  return {
    home,
    config: join(home, 'config.json'),
    credentials: join(home, 'credentials.json'),
    token: join(home, 'token'),
    uiToken: join(home, 'ui-token'),
    sessionKey: join(home, 'session.key'),
    pageBot: join(home, 'page-bot'),
    session: join(home, 'session.db'),
    log: join(home, 'daemon.log'),
    pages: join(home, 'pages.jsonl'),
    avatars: join(home, 'avatars'),
    downloads: process.env.TELEGRAM_MCP_DOWNLOADS ?? join(homedir(), 'Downloads', 'telegram-mcp'),
  }
}

export function getPort(): number {
  const raw = process.env.TELEGRAM_MCP_PORT
  const port = raw ? Number(raw) : DEFAULT_PORT
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_PORT
}
