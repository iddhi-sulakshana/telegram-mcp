import { appendFileSync, chmodSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import type { Paths } from './paths'

/** The folder holds the login session and your chats' rules, so only you may enter it. */
export function ensureHome(paths: Paths): void {
  mkdirSync(paths.home, { recursive: true, mode: 0o700 })
  chmodSync(paths.home, 0o700)
  const files = [paths.session, `${paths.session}-wal`, `${paths.session}-shm`, paths.credentials, paths.token, paths.uiToken, paths.sessionKey]
  for (const f of files) {
    if (existsSync(f)) chmodSync(f, 0o600)
  }
}

/** Appends to daemon.log, rolling it to daemon.log.1 past 5 MB. Also echoes to a terminal if there is one. */
export function makeLogger(paths: Paths | null): (msg: string) => void {
  let writes = 0
  return (msg: string) => {
    const line = `${new Date().toISOString()} ${msg}\n`
    if (process.stderr.isTTY || !paths) process.stderr.write(line)
    if (!paths) return
    try {
      if (++writes % 100 === 0 && statSync(paths.log).size > 5 * 1024 * 1024) renameSync(paths.log, `${paths.log}.1`)
      appendFileSync(paths.log, line)
    } catch {}
  }
}
