import { describe, expect, test } from 'bun:test'
import { copyFileSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { Approvals } from '../src/daemon/approvals'
import { Service } from '../src/daemon/service'
import { SessionHub } from '../src/daemon/sessions'
import { ConfigStore } from '../src/shared/config'
import { checkSendable, downloadFileName, expandHome, fmtBytes, normalizeProtectedDir, protectedDirWarnings, realFolder, safeFileName } from '../src/shared/media'
import { ANNA, FakeTelegram, LEO } from './fake-telegram'

describe('file names', () => {
  test('keeps only a plain base name', () => {
    expect(safeFileName('../../.ssh/authorized_keys')).toBe('authorized_keys')
    expect(safeFileName('..\\..\\evil.bat')).toBe('evil.bat')
    expect(safeFileName('.hidden')).toBe('hidden')
    expect(safeFileName('a\u0000b<c>.pdf')).toBe('ab_c_.pdf')
    expect(safeFileName('රිපෝට් 2026.pdf')).toBe('රිපෝට් 2026.pdf')
    expect(safeFileName('...')).toBe('')
  })

  test('long names keep their extension', () => {
    const n = safeFileName(`${'x'.repeat(300)}.pdf`)
    expect(n.length).toBe(120)
    expect(n.endsWith('.pdf')).toBe(true)
  })

  test('prefixes the message id and names unnamed media by type', () => {
    expect(downloadFileName(7, { name: 'Archive.zip', type: 'document', mime: 'application/zip' })).toBe('7-Archive.zip')
    expect(downloadFileName(8, { name: null, type: 'photo', mime: 'image/jpeg' })).toBe('8-photo.jpg')
    expect(downloadFileName(9, { name: null, type: 'voice', mime: 'audio/ogg' })).toBe('9-voice.ogg')
    expect(downloadFileName(10, { name: '../', type: 'document', mime: null })).toBe('10-document')
  })

  test('sizes', () => {
    expect(fmtBytes(500)).toBe('500 B')
    expect(fmtBytes(1490302)).toBe('1.4 MB')
  })
})

describe('telegram_download_media', () => {
  function setup() {
    const dir = mkdtempSync(join(tmpdir(), 'tgmcp-'))
    const path = join(dir, 'config.json')
    writeFileSync(path, JSON.stringify({ chats: { leo: { id: LEO.id, username: 'leo_p', name: LEO.name } }, rules: {} }))
    const tg = new FakeTelegram().add(LEO, ANNA)
    const downloadsDir = join(dir, 'downloads')
    const svc = new Service({
      store: new ConfigStore(path),
      tg,
      hub: new SessionHub(),
      approvals: new Approvals(),
      eventsUrl: () => 'ws://x',
      downloadsDir,
    })
    return { tg, svc, downloadsDir }
  }

  test('saves into a folder named after the nickname and returns the path', async () => {
    const { tg, svc, downloadsDir } = setup()
    tg.files.set(`${LEO.id}:42`, { name: 'report.pdf', type: 'document', mime: 'application/pdf', data: '%PDF-1.7' })
    const r = await svc.call('s1', 'telegram_download_media', { chat: 'leo', messageId: 42 })
    expect(r.isError).toBeFalsy()
    const saved = join(downloadsDir, 'leo', '42-report.pdf')
    expect(r.text).toContain(saved)
    expect(r.text).toContain('application/pdf')
    expect(readFileSync(saved, 'utf8')).toBe('%PDF-1.7')
  })

  test('a chat without a nickname gets a folder named by its id', async () => {
    const { tg, svc, downloadsDir } = setup()
    tg.files.set(`${ANNA.id}:5`, { name: null, type: 'photo', mime: 'image/jpeg', data: 'jpg' })
    const r = await svc.call('s1', 'telegram_download_media', { chat: ANNA.id, messageId: 5 })
    expect(r.isError).toBeFalsy()
    expect(r.text).toContain(join(downloadsDir, String(ANNA.id), '5-photo.jpg'))
  })

  test('a message without an attachment is an error', async () => {
    const { svc } = setup()
    const r = await svc.call('s1', 'telegram_download_media', { chat: 'leo', messageId: 1 })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('nothing to download')
  })
})

describe('telegram_send_file', () => {
  const FOOTER = '\n\n-- sent by a bot'

  function setup() {
    const dir = mkdtempSync(join(tmpdir(), 'tgmcp-'))
    const mcpHome = join(dir, 'mcp')
    mkdirSync(mcpHome)
    const path = join(mcpHome, 'config.json')
    writeFileSync(
      path,
      JSON.stringify({
        footer: FOOTER,
        chats: { leo: { id: LEO.id, username: 'leo_p', name: LEO.name }, anna: { id: ANNA.id, username: 'anna_k', name: ANNA.name } },
        rules: { autoSend: ['leo'], requireApproval: ['anna'] },
      }),
    )
    const tg = new FakeTelegram().add(LEO, ANNA)
    const approvals = new Approvals()
    const store = new ConfigStore(path)
    const svc = new Service({ store, tg, hub: new SessionHub(), approvals, eventsUrl: () => 'ws://x', mcpHome })
    const report = join(dir, 'report.pdf')
    writeFileSync(report, '%PDF-1.7 hello')
    return { tg, svc, dir, mcpHome, report, store }
  }

  test('an autoSend chat still asks for a file; once approved it goes with the footer as caption', async () => {
    const { tg, svc, report } = setup()
    const r = await svc.call('s1', 'telegram_send_file', { to: 'leo', path: report, caption: 'Q3 numbers' })
    expect(r.isError).toBeFalsy()
    expect(r.approval).toBeDefined()
    expect(r.text).toContain('files always need approval')
    expect(tg.sentFiles).toHaveLength(0)
    expect((await svc.call('s1', '__decide', { approvalId: r.approval!.id, dialogKey: r.approval!.dialogKey, approve: true })).isError).toBeFalsy()
    expect(tg.sentFiles).toHaveLength(1)
    expect(tg.sentFiles[0]!.file).toEqual({ path: realpathSync.native(report), name: 'report.pdf', size: 14 })
    expect(tg.sentFiles[0]!.caption).toBe(`Q3 numbers${FOOTER}`)
    expect(tg.sent).toHaveLength(0)
  })

  test('a text message keeps its leading spaces', async () => {
    const { tg, svc } = setup()
    await svc.call('s1', 'telegram_send_message', { to: 'leo', text: '    indented code' })
    expect(tg.sent[0]!.text).toBe(`    indented code${FOOTER}`)
  })

  test('no caption still gets the footer, without leading blank lines', async () => {
    const { tg, svc, report } = setup()
    const r = await svc.call('s1', 'telegram_send_file', { to: 'leo', path: report })
    await svc.call('s1', '__decide', { approvalId: r.approval!.id, dialogKey: r.approval!.dialogKey, approve: true })
    expect(tg.sentFiles[0]!.caption).toBe(FOOTER.trim())
  })

  test('a chat that needs approval waits, shows the file, and sends it once approved', async () => {
    const { tg, svc, report } = setup()
    const r = await svc.call('s1', 'telegram_send_file', { to: 'anna', path: report, caption: 'hi' })
    expect(r.approval).toBeDefined()
    expect(r.approval!.text).toContain('[file: report.pdf, 14 B]')
    expect(tg.sentFiles).toHaveLength(0)
    expect(svc.uiState().approvals[0]!.text).toContain('[file: report.pdf')
    const ok = await svc.call('s1', '__decide', { approvalId: r.approval!.id, dialogKey: r.approval!.dialogKey, approve: true })
    expect(ok.isError).toBeFalsy()
    expect(tg.sentFiles).toHaveLength(1)
    expect(svc.uiState().recent.at(-1)!.text).toContain('[file: report.pdf')
  })

  test('a file to a chat the session watches asks first, like every file; text still goes', async () => {
    const { tg, svc, report, store } = setup()
    store.update(c => {
      c.rules.autoReply = ['leo']
    })
    const w = await svc.call('s1', 'telegram_watch', { chat: 'leo' })
    expect(w.isError).toBeFalsy()
    const f = await svc.call('s1', 'telegram_send_file', { to: 'leo', path: report })
    expect(f.approval).toBeDefined()
    expect(f.text).toContain('files always need approval')
    expect(tg.sentFiles).toHaveLength(0)
    const t = await svc.call('s1', 'telegram_send_message', { to: 'leo', text: 'on it' })
    expect(t.isError).toBeFalsy()
    expect(tg.sent).toHaveLength(1)
    // Another session that isn't watching asks too: a file never goes without a yes.
    const other = await svc.call('s2', 'telegram_send_file', { to: 'leo', path: report })
    expect(other.approval).toBeDefined()
    expect(tg.sentFiles).toHaveLength(0)
  })

  test("a file is never approved on the model's word in chat; the draft keeps waiting", async () => {
    const { tg, svc, report } = setup()
    for (const to of ['leo', 'anna']) {
      const r = await svc.call('s1', 'telegram_send_file', { to, path: report })
      expect(r.text).toContain("telegram_confirm_send can't approve it")
      const chat = await svc.call('s1', 'telegram_confirm_send', { approvalId: r.approval!.id })
      expect(chat.isError).toBe(true)
      expect(chat.text).toContain('never in chat')
      expect(svc.uiState().approvals.map(a => a.id)).toContain(r.approval!.id)
      expect((await svc.call('s1', 'telegram_cancel_send', { approvalId: r.approval!.id })).isError).toBeFalsy()
    }
    expect(tg.sentFiles).toHaveLength(0)
  })

  test('with no app open, the result says the draft already waits there, not to send it again', async () => {
    const { tg, svc, report } = setup()
    const r = await svc.call('s1', 'telegram_send_file', { to: 'anna', path: report })
    expect(r.text).toContain('already waiting, for up to 20 minutes')
    expect(r.text).toContain('Do not send the file again')
    expect(r.text).not.toContain('send it again')
    // Once the user opens the app, that same draft is there to approve.
    svc.touchUi()
    expect(svc.uiState().approvals.map(a => a.id)).toEqual([r.approval!.id])
    expect((await svc.decide(r.approval!.id, true, 'menubar', null)).isError).toBeFalsy()
    expect(tg.sentFiles).toHaveLength(1)
  })

  test('a file replaced while waiting for approval is not sent', async () => {
    const { tg, svc, report } = setup()
    const r = await svc.call('s1', 'telegram_send_file', { to: 'anna', path: report })
    writeFileSync(report, 'something else entirely, not what the user approved')
    const res = await svc.call('s1', '__decide', { approvalId: r.approval!.id, dialogKey: r.approval!.dialogKey, approve: true })
    expect(res.isError).toBe(true)
    expect(res.text).toContain('changed after approval was asked')
    expect(tg.sentFiles).toHaveLength(0)
  })

  test('the approver sees the full path, not just the file name', async () => {
    const { svc, report } = setup()
    const r = await svc.call('s1', 'telegram_send_file', { to: 'anna', path: report, caption: 'hi' })
    expect(r.approval!.text).toContain(`Path: ${realpathSync.native(report)}`)
    expect(r.text).toContain(`Path: ${realpathSync.native(report)}`)
    expect(svc.uiState().approvals[0]!.text).toContain(`Path: ${realpathSync.native(report)}`)
  })

  test('a file deleted while waiting for approval is not sent', async () => {
    const { tg, svc, report } = setup()
    const r = await svc.call('s1', 'telegram_send_file', { to: 'anna', path: report })
    rmSync(report)
    const res = await svc.call('s1', '__decide', { approvalId: r.approval!.id, dialogKey: r.approval!.dialogKey, approve: true })
    expect(res.isError).toBe(true)
    expect(tg.sentFiles).toHaveLength(0)
  })

  test('refuses credentials, its own files, relative paths and folders', async () => {
    const { tg, svc, dir, mcpHome } = setup()
    const home = join(dir, 'home')
    mkdirSync(join(home, '.ssh'), { recursive: true })
    writeFileSync(join(home, '.ssh', 'config'), 'Host x')
    writeFileSync(join(dir, '.env'), 'SECRET=1')
    writeFileSync(join(dir, 'id_ed25519'), 'key')
    writeFileSync(join(dir, 'server.pem'), 'key')
    writeFileSync(join(mcpHome, 'session.db'), 'auth key')
    for (const path of [join(dir, '.env'), join(dir, 'id_ed25519'), join(dir, 'server.pem'), join(mcpHome, 'session.db')]) {
      const r = await svc.call('s1', 'telegram_send_file', { to: 'leo', path })
      expect(r.isError).toBe(true)
      expect(r.text).toContain('Refusing')
    }
    expect(() => checkSendable(join(home, '.ssh', 'config'), { mcpHome, home })).toThrow('Refusing')
    expect((await svc.call('s1', 'telegram_send_file', { to: 'leo', path: 'report.pdf' })).text).toContain('absolute path')
    expect((await svc.call('s1', 'telegram_send_file', { to: 'leo', path: dir })).text).toContain('Not a regular file')
    expect((await svc.call('s1', 'telegram_send_file', { to: 'leo', path: join(dir, 'nope') })).text).toContain('No such file')
    expect(tg.sentFiles).toHaveLength(0)
  })
})

describe('telegram_send_file: links', () => {
  // POSIX: creating a symlink on Windows needs admin rights or Developer Mode.
  test.skipIf(process.platform === 'win32')('a symlink to its own login files is refused', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tgmcp-'))
    const mcpHome = join(dir, 'mcp')
    mkdirSync(mcpHome)
    writeFileSync(join(mcpHome, 'session.db'), 'auth key')
    symlinkSync(join(mcpHome, 'session.db'), join(dir, 'innocent.txt'))
    expect(() => checkSendable(join(dir, 'innocent.txt'), { mcpHome, home: join(dir, 'home') })).toThrow('Refusing')
  })
})

describe('checkSendable: more credential files', () => {
  function setup() {
    const dir = mkdtempSync(join(tmpdir(), 'tgmcp-deny-'))
    const home = join(dir, 'home')
    const mcpHome = join(dir, 'mcp')
    mkdirSync(mcpHome, { recursive: true })
    mkdirSync(join(home, '.claude', 'projects'), { recursive: true })
    return { dir, home, mcpHome }
  }

  test('refuses .env files by any name, git credentials and the Claude Code config', () => {
    const { dir, home, mcpHome } = setup()
    const refused = [
      join(dir, 'prod.env'),
      join(dir, 'prod.env.local'),
      join(dir, '.envrc'),
      join(dir, 'local.ENV'),
      join(dir, '.git-credentials'),
      join(home, '.claude', 'settings.json'),
      join(home, '.claude', 'projects', 'notes.md'),
      join(home, '.claude.json'),
      join(dir, '.claude.json.backup'),
      join(dir, '.env-prod'),
      join(dir, '.env_local'),
      join(dir, '.pgpass'),
      join(dir, '.vault-token'),
      join(dir, 'prod.tfvars'),
      join(dir, 'prod.auto.tfvars.json'),
      join(dir, '.dev.vars'),
    ]
    for (const path of refused) {
      writeFileSync(path, 'x')
      expect(() => checkSendable(path, { mcpHome, home })).toThrow('Refusing')
    }
  })

  test('ordinary files still pass, including ones that only look alike', () => {
    const { dir, home, mcpHome } = setup()
    for (const name of ['environment.txt', 'envoy.pdf', 'claude.json', 'git-credentials.md', 'dev.vars.md', 'tfvars.txt', 'pgpass.txt']) {
      const path = join(dir, name)
      writeFileSync(path, 'x')
      expect(checkSendable(path, { mcpHome, home }).name).toBe(name)
    }
  })

  test('a hard-linked file is refused, under either name; a copy passes', () => {
    const { dir, home, mcpHome } = setup()
    mkdirSync(join(home, '.ssh'), { recursive: true })
    const key = join(home, '.ssh', 'id_work')
    writeFileSync(key, 'secret')
    const report = join(dir, 'report.txt')
    linkSync(key, report)
    expect(() => checkSendable(report, { mcpHome, home })).toThrow('hard-linked')
    const plain = join(dir, 'notes.txt')
    writeFileSync(plain, 'x')
    const other = join(dir, 'notes-link.txt')
    linkSync(plain, other)
    expect(() => checkSendable(plain, { mcpHome, home })).toThrow('Send a copy')
    const copy = join(dir, 'copy.txt')
    copyFileSync(plain, copy)
    expect(checkSendable(copy, { mcpHome, home }).name).toBe('copy.txt')
  })

  // Windows reaches one file by several names: a device path, an admin share, a folder's stream name.
  test.skipIf(process.platform !== 'win32')('on Windows, other names for a protected file are refused too', () => {
    const { home, mcpHome } = setup()
    const path = join(home, '.claude', 'settings.json')
    writeFileSync(path, 'x')
    const bs = String.fromCharCode(92)
    const drive = path.slice(0, 1)
    const names = [
      `${bs}${bs}?${bs}${path}`,
      `${bs}${bs}.${bs}${path}`,
      `${bs}${bs}localhost${bs}${drive}$${path.slice(2)}`,
      join(home, '.claude::$INDEX_ALLOCATION', 'settings.json'),
    ]
    for (const name of names) expect(() => checkSendable(name, { mcpHome, home })).toThrow()
  })

  test('on a file system that ignores case, a differently cased secret folder is still refused', () => {
    const { home, mcpHome } = setup()
    mkdirSync(join(home, '.SSH'), { recursive: true })
    const path = join(home, '.SSH', 'config')
    writeFileSync(path, 'Host x')
    expect(() => checkSendable(path, { mcpHome, home, ignoreCase: true })).toThrow('Refusing')
  })
})

describe('telegram_send_sticker', () => {
  function setup() {
    const dir = mkdtempSync(join(tmpdir(), 'tgmcp-'))
    const path = join(dir, 'config.json')
    writeFileSync(
      path,
      JSON.stringify({
        footer: '\n\n-- sent by a bot',
        chats: { leo: { id: LEO.id, username: 'leo_p', name: LEO.name }, anna: { id: ANNA.id, username: 'anna_k', name: ANNA.name } },
        rules: { autoSend: ['leo'], requireApproval: ['anna'] },
      }),
    )
    const tg = new FakeTelegram().add(LEO, ANNA)
    tg.stickers.add(`${ANNA.id}:77`)
    const svc = new Service({ store: new ConfigStore(path), tg, hub: new SessionHub(), approvals: new Approvals(), eventsUrl: () => 'ws://x', mcpHome: join(dir, 'mcp') })
    return { tg, svc }
  }

  test('an autoSend chat gets the sticker at once, with no footer and nothing uploaded', async () => {
    const { tg, svc } = setup()
    const r = await svc.call('s1', 'telegram_send_sticker', { to: 'leo', fromChat: 'anna', messageId: 77, replyTo: 5 })
    expect(r.isError).toBeFalsy()
    expect(tg.sentStickers).toHaveLength(1)
    expect(tg.sentStickers[0]).toMatchObject({ chatId: LEO.id, from: { chatId: ANNA.id, messageId: 77 }, opts: { replyTo: 5 } })
    expect(tg.sent).toHaveLength(0)
    expect(tg.sentFiles).toHaveLength(0)
    expect(svc.uiState().recent.at(-1)!.text).toBe('[sticker]')
  })

  test('a chat that needs approval waits, then sends the sticker', async () => {
    const { tg, svc } = setup()
    tg.stickers.add(`${LEO.id}:9`)
    const r = await svc.call('s1', 'telegram_send_sticker', { to: 'anna', fromChat: 'leo', messageId: 9 })
    expect(r.approval!.text).toBe('[sticker]')
    expect(svc.uiState().approvals[0]!.text).toBe('[sticker]')
    expect(tg.sentStickers).toHaveLength(0)
    await svc.call('s1', 'telegram_confirm_send', { approvalId: r.approval!.id })
    expect(tg.sentStickers).toHaveLength(1)
  })

  test('a message without a sticker is an error', async () => {
    const { tg, svc } = setup()
    const r = await svc.call('s1', 'telegram_send_sticker', { to: 'leo', fromChat: 'anna', messageId: 1 })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('not a sticker')
    expect(tg.sentStickers).toHaveLength(0)
  })
})

describe("checkSendable: the owner's protected folders (files.protectedDirs)", () => {
  function setup() {
    const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'tgmcp-protect-')))
    const home = join(dir, 'home')
    const mcpHome = join(dir, 'mcp')
    mkdirSync(join(home, 'work', 'clients', 'acme'), { recursive: true })
    mkdirSync(join(dir, 'vault'), { recursive: true })
    mkdirSync(mcpHome)
    const inClients = join(home, 'work', 'clients', 'acme', 'contract.pdf')
    const inVault = join(dir, 'vault', 'notes.txt')
    for (const f of [inClients, inVault]) writeFileSync(f, 'x')
    return { dir, home, mcpHome, inClients, inVault }
  }

  test('~ means the home folder', () => {
    expect(expandHome('~', '/h')).toBe('/h')
    expect(expandHome('~/work/x', '/h')).toBe(join('/h', 'work', 'x'))
    expect(expandHome('~\\work', '/h')).toBe(join('/h', 'work'))
  })

  test('refuses files in an absolute folder or one under ~, at any depth', () => {
    const { dir, home, mcpHome, inClients, inVault } = setup()
    const protectedDirs = ['~/work/clients', join(dir, 'vault')]
    expect(() => checkSendable(inClients, { mcpHome, home, protectedDirs })).toThrow('files.protectedDirs')
    expect(() => checkSendable(inVault, { mcpHome, home, protectedDirs })).toThrow('files.protectedDirs')
    // A trailing separator or ".." in the setting makes no difference.
    expect(() => checkSendable(inVault, { mcpHome, home, protectedDirs: [join(dir, 'vault') + sep] })).toThrow('files.protectedDirs')
    expect(() => checkSendable(inVault, { mcpHome, home, protectedDirs: [join(dir, 'x', '..', 'vault')] })).toThrow('files.protectedDirs')
    // The home folder itself.
    expect(() => checkSendable(inClients, { mcpHome, home, protectedDirs: ['~'] })).toThrow('files.protectedDirs')
  })

  test('files outside them, and folders whose name only starts the same, still pass', () => {
    const { dir, home, mcpHome } = setup()
    mkdirSync(join(dir, 'vault-public'))
    const near = join(dir, 'vault-public', 'ok.txt')
    const elsewhere = join(home, 'work', 'readme.txt')
    for (const f of [near, elsewhere]) writeFileSync(f, 'x')
    const protectedDirs = ['~/work/clients', join(dir, 'vault'), join(dir, 'does-not-exist')]
    expect(checkSendable(near, { mcpHome, home, protectedDirs }).name).toBe('ok.txt')
    expect(checkSendable(elsewhere, { mcpHome, home, protectedDirs }).name).toBe('readme.txt')
    expect(checkSendable(near, { mcpHome, home }).name).toBe('ok.txt')
  })

  // POSIX: creating a symlink on Windows needs admin rights or Developer Mode.
  test.skipIf(process.platform === 'win32')('a link into a protected folder, or the folder named by a link, is refused', () => {
    const { dir, home, mcpHome, inVault } = setup()
    const link = join(dir, 'innocent.txt')
    symlinkSync(inVault, link)
    expect(() => checkSendable(link, { mcpHome, home, protectedDirs: [join(dir, 'vault')] })).toThrow('files.protectedDirs')
    // The setting names the folder by a link to it.
    symlinkSync(join(dir, 'vault'), join(dir, 'vault-link'))
    expect(() => checkSendable(inVault, { mcpHome, home, protectedDirs: [join(dir, 'vault-link')] })).toThrow('files.protectedDirs')
  })

  test('letter case is ignored where the file system ignores it, as for the built-in folders', () => {
    const { home, mcpHome, inClients } = setup()
    const protectedDirs = ['~/Work/CLIENTS']
    expect(() => checkSendable(inClients, { mcpHome, home, protectedDirs, ignoreCase: true })).toThrow('files.protectedDirs')
    if (process.platform === 'linux') expect(checkSendable(inClients, { mcpHome, home, protectedDirs, ignoreCase: false }).name).toBe('contract.pdf')
  })
})

describe('telegram_send_file and files.protectedDirs', () => {
  function setup(protectedDirs: string[]) {
    const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'tgmcp-')))
    const mcpHome = join(dir, 'mcp')
    mkdirSync(mcpHome)
    mkdirSync(join(dir, 'vault'))
    const path = join(mcpHome, 'config.json')
    writeFileSync(
      path,
      JSON.stringify({
        chats: { leo: { id: LEO.id, username: 'leo_p', name: LEO.name } },
        rules: { requireApproval: ['leo'] },
        files: { protectedDirs: protectedDirs.map(d => d.replace('$DIR', dir)) },
      }),
    )
    const tg = new FakeTelegram().add(LEO, ANNA)
    const store = new ConfigStore(path)
    const svc = new Service({ store, tg, hub: new SessionHub(), approvals: new Approvals(), eventsUrl: () => 'ws://x', mcpHome })
    const secret = join(dir, 'vault', 'plan.pdf')
    writeFileSync(secret, 'x')
    return { tg, svc, store, dir, secret, path }
  }

  test('a file in a protected folder is refused before any approval', async () => {
    const { tg, svc, secret } = setup([join('$DIR', 'vault')])
    const r = await svc.call('s1', 'telegram_send_file', { to: 'leo', path: secret })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('files.protectedDirs')
    expect(r.approval).toBeUndefined()
    expect(tg.sentFiles).toHaveLength(0)
  })

  test('a folder protected while the draft waits is refused on approval too', async () => {
    const { tg, svc, store, dir, secret } = setup([])
    const r = await svc.call('s1', 'telegram_send_file', { to: 'leo', path: secret })
    expect(r.approval).toBeDefined()
    store.update(c => {
      c.files.protectedDirs = [join(dir, 'vault')]
    })
    const res = await svc.decide(r.approval!.id, true, 'menubar', null)
    expect(res.isError).toBe(true)
    expect(res.text).toContain('files.protectedDirs')
    expect(tg.sentFiles).toHaveLength(0)
  })

  test('no tool changes it: saving a chat keeps the setting as the owner wrote it', async () => {
    const { svc, path } = setup(['~/work/clients', join('$DIR', 'vault')])
    const before = JSON.parse(readFileSync(path, 'utf8')).files
    expect((await svc.call('s1', 'telegram_save_chat', { nickname: 'anna', chat: ANNA.id })).isError).toBeFalsy()
    expect(JSON.parse(readFileSync(path, 'utf8')).files).toEqual(before)
  })
})

describe('protectedDirs entries that need normalising, or don\'t exist yet', () => {
  function setup() {
    const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'tgmcp-norm-')))
    const home = join(dir, 'home')
    const mcpHome = join(dir, 'mcp')
    mkdirSync(home, { recursive: true })
    mkdirSync(mcpHome)
    return { dir, home, mcpHome }
  }

  test('trailing separators, "." and ".." are resolved; on Windows trailing dots and spaces are dropped from every part', () => {
    expect(normalizeProtectedDir('/srv/x/', '/h', 'linux')).toBe(resolve('/srv/x'))
    expect(normalizeProtectedDir('/srv/./y/../x//', '/h', 'linux')).toBe(resolve('/srv/x'))
    expect(normalizeProtectedDir('~/work/', '/h', 'linux')).toBe(resolve('/h', 'work'))
    // Outside Windows a trailing dot names another folder, so it is kept (and warned about).
    expect(normalizeProtectedDir('/srv/x.', '/h', 'linux')).toBe(resolve('/srv/x.'))
    expect(normalizeProtectedDir('/srv/Secrets. /x.. ', '/h', 'win32')).toBe(resolve('/srv/Secrets/x'))
    expect(normalizeProtectedDir('~/Work. ', '/h', 'win32')).toBe(resolve(join('/h', 'Work')))
  })

  test('a folder that does not exist yet is protected as soon as it is made', () => {
    const { dir, home, mcpHome } = setup()
    const later = join(dir, 'later', 'deeper')
    const protectedDirs = [later]
    expect(realFolder(later)).toBe(later)
    mkdirSync(later, { recursive: true })
    const file = join(later, 'plan.txt')
    writeFileSync(file, 'x')
    expect(() => checkSendable(file, { mcpHome, home, protectedDirs })).toThrow('files.protectedDirs')
  })

  test.skipIf(process.platform === 'win32')('a missing folder under a linked parent is matched by its real path (symlinks need admin on Windows)', () => {
    const { dir, home, mcpHome } = setup()
    mkdirSync(join(dir, 'real'))
    symlinkSync(join(dir, 'real'), join(dir, 'via'))
    // Named through the link, before it exists.
    const named = join(dir, 'via', 'vault')
    expect(realFolder(named)).toBe(join(dir, 'real', 'vault'))
    mkdirSync(join(dir, 'real', 'vault'))
    writeFileSync(join(dir, 'real', 'vault', 'a.txt'), 'x')
    expect(() => checkSendable(join(dir, 'real', 'vault', 'a.txt'), { mcpHome, home, protectedDirs: [named] })).toThrow('files.protectedDirs')
  })

  test.skipIf(process.platform !== 'win32')('on Windows a trailing dot or space in the entry still protects the folder', () => {
    const { dir, home, mcpHome } = setup()
    mkdirSync(join(dir, 'vault'))
    writeFileSync(join(dir, 'vault', 'a.txt'), 'x')
    for (const entry of [`${join(dir, 'vault')}.`, `${join(dir, 'vault')} `, `${join(dir, 'vault')}.\\`]) {
      expect(() => checkSendable(join(dir, 'vault', 'a.txt'), { mcpHome, home, protectedDirs: [entry] })).toThrow('files.protectedDirs')
    }
  })

  test('warnings: a missing folder, a file, a trailing dot, an entry read differently; none for a plain folder', () => {
    const { dir, home } = setup()
    mkdirSync(join(dir, 'ok'))
    writeFileSync(join(dir, 'a-file'), 'x')
    expect(protectedDirWarnings([join(dir, 'ok'), `${join(dir, 'ok')}${sep}`], home, 'linux')).toEqual([])
    const missing = protectedDirWarnings([join(dir, 'nope')], home, 'linux')
    expect(missing).toHaveLength(1)
    expect(missing[0]).toContain('does not exist yet')
    expect(protectedDirWarnings([join(dir, 'a-file')], home, 'linux')[0]).toContain('is a file')
    expect(protectedDirWarnings([`${join(dir, 'ok')}.`], home, 'linux')[0]).toContain('ends in a dot or space')
    const win = protectedDirWarnings([`${join(dir, 'ok')}.`], home, 'win32')
    expect(win[0]).toContain('is read as')
  })

  test('telegram_status lists the warnings', async () => {
    const { dir, mcpHome } = setup()
    const path = join(mcpHome, 'config.json')
    writeFileSync(path, JSON.stringify({ files: { protectedDirs: [join(dir, 'nope')] } }))
    const svc = new Service({ store: new ConfigStore(path), tg: new FakeTelegram(), hub: new SessionHub(), approvals: new Approvals(), eventsUrl: () => 'ws://x', mcpHome })
    const status = (await svc.call('s1', 'telegram_status', {})).text
    expect(status).toContain('Protected folders (files.protectedDirs): 1, with warnings:')
    expect(status).toContain('warning: ')
    expect(status).toContain('does not exist yet')
    expect(svc.protectedDirWarnings()).toHaveLength(1)
  })
})
