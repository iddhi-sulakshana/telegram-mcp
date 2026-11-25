import { existsSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'

/** Naming and sizes for files moving between Telegram and disk. */

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'audio/ogg': '.ogg',
  'audio/mpeg': '.mp3',
  'application/pdf': '.pdf',
  'application/zip': '.zip',
  'application/x-tgsticker': '.tgs',
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/** A sender picks the file name, so keep only a plain base name: no folders, no leading dots. */
export function safeFileName(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? ''
  const clean = base
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[^\p{L}\p{M}\p{N} ._()+-]/gu, '_')
    .replace(/^[.\s]+/, '')
    .trim()
  if (!clean) return ''
  if (clean.length <= 120) return clean
  const dot = clean.lastIndexOf('.')
  const ext = dot > 0 && clean.length - dot <= 10 ? clean.slice(dot) : ''
  return clean.slice(0, 120 - ext.length) + ext
}

/** `<message id>-<name>`, so two files called "photo.jpg" in one chat never overwrite each other. */
export function downloadFileName(messageId: number, file: { name: string | null; type: string; mime: string | null }): string {
  const given = file.name ? safeFileName(file.name) : ''
  const name = given || `${file.type}${(file.mime && EXT_BY_MIME[file.mime]) ?? (file.type === 'photo' ? '.jpg' : '')}`
  return `${messageId}-${name}`
}

/** A local file waiting to go out, checked when the send is requested and again when it is approved. */
export interface OutgoingFile {
  path: string
  name: string
  size: number
}

const MAX_UPLOAD = 2000 * 1024 * 1024

/** Folders under the home directory that hold credentials, or an agent's settings and history. */
const SECRET_DIRS = ['.ssh', '.gnupg', '.aws', '.azure', '.kube', '.docker', '.config/gcloud', '.config/gh', 'Library/Keychains', '.claude']
/** Base names that are credentials wherever they sit. */
const SECRET_NAMES =
  /^(.*\.env(\..*)?|\.env.*|\.netrc|\.npmrc|\.pypirc|\.pgpass|\.vault-token|\.dev\.vars|\.git-credentials|\.claude\.json(\..*)?|id_(rsa|dsa|ecdsa|ed25519)(_[\w-]+)?(\.pub)?|.*\.tfvars(\.json)?|.*\.(pem|key|p12|pfx|kdbx))$/i

/** A `files.protectedDirs` entry as a path: "~" is the home folder, "~/x" (or "~\\x") under it. */
export function expandHome(dir: string, home: string): string {
  if (dir === '~') return home
  if (/^~[\\/]/.test(dir)) return join(home, dir.slice(2))
  return resolve(dir)
}

/**
 * A protectedDirs entry as the folder it names: "~" expanded, "." and ".." and trailing separators
 * resolved away and, on Windows, trailing dots and spaces dropped from every part, as Windows itself
 * drops them ("C:\\Secrets." is "C:\\Secrets" there).
 */
export function normalizeProtectedDir(dir: string, home: string, platform: string = process.platform): string {
  const path = resolve(expandHome(dir.trim(), home))
  if (platform !== 'win32') return path
  const parts = path.split(/[\\/]/)
  const kept = parts.map((p, i) => (i === 0 ? p : p.replace(/[. ]+$/, '') || p))
  return resolve(kept.join(sep))
}

/**
 * A folder by its real path even before it exists: the deepest part that exists is resolved (links
 * and, on Windows, short names), and the rest added back. So a folder protected before it is made
 * is matched once it is, and a link in the path above it is no way round it.
 */
export function realFolder(path: string): string {
  let head = path
  const rest: string[] = []
  for (;;) {
    try {
      return join(realpathSync.native(head), ...rest)
    } catch {
      const up = dirname(head)
      if (up === head) return path
      rest.unshift(basename(head))
      head = up
    }
  }
}

/**
 * What /status and telegram_status warn about in files.protectedDirs: an entry whose folder doesn't
 * exist (it is still protected by that path, from the moment it is made), one that names a file, and
 * one that only matches once normalised (trailing dots or spaces on Windows). Empty when all is well.
 */
export function protectedDirWarnings(dirs: readonly string[], home: string = homedir(), platform: string = process.platform): string[] {
  const out: string[] = []
  for (const dir of dirs) {
    const path = normalizeProtectedDir(dir, home, platform)
    const plain = resolve(expandHome(dir.trim(), home))
    if (path !== plain) out.push(`"${dir}" is read as ${path}`)
    // Trailing dots or spaces outside Windows name a different folder, most likely by mistake.
    else if (platform !== 'win32' && /[. ]$/.test(dir.trim()) && dir.trim() !== '~') out.push(`"${dir}" ends in a dot or space: is that the folder you meant?`)
    if (!existsSync(path)) out.push(`"${dir}" does not exist yet (${path}): it is protected once it is made`)
    else if (!statSync(path).isDirectory()) out.push(`"${dir}" is a file, not a folder: that file is never sent`)
  }
  return out
}

/**
 * Whether a local file may be sent at all, whatever the chat rules say: an absolute path to a
 * regular, non-empty file under Telegram's size limit, and not a credential. `mcpHome` is this
 * tool's own folder (login session, API token), which is never sent. `protectedDirs` are the
 * owner's own extra folders (config `files.protectedDirs`), refused like the built-in ones.
 */
export function checkSendable(
  path: string,
  o: { mcpHome: string; home?: string; ignoreCase?: boolean; protectedDirs?: readonly string[] },
): OutgoingFile {
  if (!isAbsolute(path)) throw new Error(`Give an absolute path, not "${path}".`)
  let real: string
  try {
    real = realpathSync.native(path)
  } catch {
    throw new Error(`No such file: ${path}`)
  }
  const st = statSync(real)
  // A network share or a device path (two leading slashes) can reach the same files by another name.
  if (/^[\\/]{2}/.test(real)) throw new Error(`Refusing to send ${path}: give a path on a local drive, not a network or device path.`)
  if (!st.isFile()) throw new Error(`Not a regular file: ${path}`)
  // Another name for the same data can sit in any folder, so where this one is says nothing about it.
  if (st.nlink > 1) {
    throw new Error(`Refusing to send ${path}: it is a hard-linked file (one of ${st.nlink} names for the same data), so it can't be told apart from a protected file. Send a copy of it instead.`)
  }
  if (st.size === 0) throw new Error(`The file is empty: ${path}`)
  if (st.size > MAX_UPLOAD) throw new Error(`The file is ${fmtBytes(st.size)}; Telegram takes at most ${fmtBytes(MAX_UPLOAD)}.`)
  const home = o.home ?? homedir()
  const realOr = (p: string) => {
    try {
      return realpathSync.native(p)
    } catch {
      return p
    }
  }
  // Windows and macOS file systems ignore case by default: ~/.SSH is ~/.ssh there.
  const fold = (o.ignoreCase ?? (process.platform === 'win32' || process.platform === 'darwin')) ? (p: string) => p.toLowerCase() : (p: string) => p
  const inside = (dir: string) => {
    const [r, d] = [fold(real), fold(dir)]
    return r === d || r.startsWith(d.endsWith(sep) ? d : d + sep)
  }
  const guarded = [realOr(o.mcpHome), ...SECRET_DIRS.map(d => realOr(join(home, d)))]
  if (guarded.some(inside) || SECRET_NAMES.test(basename(real))) {
    throw new Error(`Refusing to send ${path}: it looks like a credential or this tool's own login files.`)
  }
  // Resolved the same way as the file, so a link to the folder, or the folder by a link, is no way
  // round it; a folder that doesn't exist yet is matched by its resolved path once it does.
  if ((o.protectedDirs ?? []).some(d => inside(realFolder(normalizeProtectedDir(d, home))))) {
    throw new Error(`Refusing to send ${path}: it is in a folder the user protected (files.protectedDirs in config.json).`)
  }
  return { path: real, name: basename(real), size: st.size }
}

/**
 * How a send reads in results and the recent list. `withPath` is for approvals: the person
 * deciding sees which folder the file comes from, not just its name.
 */
export function describeOutgoing(text: string, file?: OutgoingFile, withPath = false): string {
  if (!file) return text
  const lines = [`[file: ${file.name}, ${fmtBytes(file.size)}]`]
  if (withPath) lines.push(`Path: ${file.path}`)
  if (text) lines.push(text)
  return lines.join('\n')
}

/**
 * SHA-256 of a file, streamed. Taken when approval is asked and checked again before sending,
 * so the bytes that go out are the bytes the person approved, not whatever is at that path now.
 */
export async function fileDigest(path: string): Promise<string> {
  const h = new Bun.CryptoHasher('sha256')
  for await (const chunk of Bun.file(path).stream()) h.update(chunk)
  return h.digest('hex')
}
