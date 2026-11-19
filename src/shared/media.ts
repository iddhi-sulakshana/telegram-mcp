import { realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, sep } from 'node:path'

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
  /^(.*\.env(\..*)?|\.envrc|\.netrc|\.npmrc|\.pypirc|\.git-credentials|\.claude\.json(\..*)?|id_(rsa|dsa|ecdsa|ed25519)(_[\w-]+)?(\.pub)?|.*\.(pem|key|p12|pfx|kdbx))$/i

/**
 * Whether a local file may be sent at all, whatever the chat rules say: an absolute path to a
 * regular, non-empty file under Telegram's size limit, and not a credential. `mcpHome` is this
 * tool's own folder (login session, API token), which is never sent.
 */
export function checkSendable(path: string, o: { mcpHome: string; home?: string; ignoreCase?: boolean }): OutgoingFile {
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
