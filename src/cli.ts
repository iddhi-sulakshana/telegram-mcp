#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline/promises'
import { ensureHome } from './shared/files'
import { getPaths, getPort } from './shared/paths'
import { FileSecretStore, loadCredentials, openSecretStore, readToken, readUiToken, saveCredentials } from './shared/secrets'
import { ConfigStore, type Config } from './shared/config'
import { applyAwayPatch, awaySummary, firstName, parseAwayArgs, renderAwayMessage, scheduleSummary } from './shared/away'
import { readDaemonReply } from './shared/daemon-reply'
import { applyFooterPatch, footerSummary, parseFooterArgs } from './shared/footer'
import { withFooter } from './shared/policy'
import { VERSION, isCompiled, selfCommand, shellJoin } from './shared/runtime'

const HELP = `tgmcp ${VERSION}: always-on Telegram daemon + per-session MCP bridge

  tgmcp install       install/refresh the launchd agent (starts now and at every login, restarts on exit)
  tgmcp uninstall     remove the launchd agent
  tgmcp restart       restart the daemon
  tgmcp status        daemon, Telegram and session status
  tgmcp login         log in to Telegram (interactive; run it in a terminal)
  tgmcp login --credentials   enter api_id/api_hash again, then log in
  tgmcp logs          follow the daemon log
  tgmcp config        print the rules file path
  tgmcp menubar       build and start the menu bar app (macOS) or tray app (Windows) at login:
                      approvals, listeners, recent sends, saved chats
  tgmcp menubar uninstall
  tgmcp page setup    connect your own pager bot (from @BotFather) so pages reach your phone
  tgmcp page test     ring a test page: hear the alarm, check the volume, try Ack
  tgmcp away          show the away schedules; tgmcp away on|off|quiet <minutes>, or [<schedule>] hours HH:MM HH:MM|message <text>
  tgmcp bots          moderator commands: who can pause Claude here and what is paused now;
                      tgmcp bots on|off | resume [chat id]   (resume with no id lifts every pause)
  tgmcp footer        show the footer added to every message; tgmcp footer on|off|<text>
  tgmcp call <tool> [json]   call a tool as a one-off session, e.g. tgmcp call telegram_get_rules
  tgmcp mcp-add       print the command that registers the MCP server with Claude Code
  tgmcp daemon        run the daemon in the foreground
  tgmcp mcp [--channel] [--desk <name>]  stdio MCP server (Claude Code starts this, one per session);
                         --desk makes this session hold that desk (config.json "desks")
  tgmcp version       print the version

Files live in ${getPaths().home} (override with TELEGRAM_MCP_HOME). Port ${getPort()} (TELEGRAM_MCP_PORT).
Secrets (login key, API token, api_hash) live in the OS keystore; TELEGRAM_MCP_SECRET_STORE=file keeps them in files.`

/**
 * A call to the daemon's local API from a command a person runs. `auth` picks the token: "ui" for
 * /ui/* and /admin/* (the menu bar and tray apps' token), "bridge" for /status. The daemon refuses
 * each one on the other's routes.
 */
async function daemonFetch(auth: 'ui' | 'bridge', path: string, init?: RequestInit, timeoutMs = 3_000): Promise<Response> {
  const secrets = openSecretStore(getPaths())
  const token = await (auth === 'ui' ? readUiToken(secrets) : readToken(secrets))
  return fetch(`http://127.0.0.1:${getPort()}${path}`, {
    ...init,
    headers: { ...(init?.headers ?? {}), authorization: `Bearer ${token ?? ''}` },
    signal: AbortSignal.timeout(timeoutMs),
  })
}

/**
 * The reply as it would go out, rendered here from the config just read or saved. Only the name
 * comes from the daemon: its own preview lags a save by its 150 ms reload. No daemon keeps {name}.
 */
async function awayName(): Promise<string | null> {
  try {
    const res = await daemonFetch('ui', '/ui/state')
    if (res.ok) {
      const body = (await res.json()) as { telegram?: { me?: { name?: unknown } | null } }
      const me = body.telegram?.me
      if (typeof me?.name === 'string') return firstName({ name: me.name })
    }
  } catch {
    // daemon not running: render without a name
  }
  return null
}

async function away(args: string[]) {
  const parsed = parseAwayArgs(args)
  if (parsed.kind === 'error') {
    console.log(parsed.usage)
    process.exitCode = 1
    return
  }
  const store = new ConfigStore(getPaths().config) // no watch(): nothing keeps the process alive
  try {
    if (parsed.kind === 'patch') {
      // Check first, so a rejected change never rewrites config.json.
      const checked = applyAwayPatch(store.get().away, parsed.patch)
      if (!checked.ok) {
        console.log(checked.error)
        process.exitCode = 1
        return
      }
      // Then apply to the file as it is now, so a hand edit made meanwhile survives.
      store.update(c => {
        const r = applyAwayPatch(c.away, parsed.patch)
        if (!r.ok) throw new Error(r.error)
        c.away = r.away
      })
      console.log('Saved.')
    } else if (store.error()) {
      throw new Error(store.error()!)
    }
  } catch (e) {
    console.log(e instanceof Error ? e.message : String(e))
    process.exitCode = 1
    return
  }
  const config = store.get()
  const { away: a } = config
  console.log(`Away auto-reply: ${awaySummary(a, new Date())}`)
  console.log(`Quiet after you or Claude write there: ${a.quietMinutes} min`)
  const name = await awayName()
  for (const s of a.schedules) {
    console.log('')
    console.log(scheduleSummary(s))
    console.log(withFooter(renderAwayMessage(s.message, name), config.footer).replace(/^/gm, '  '))
  }
  if (a.schedules.length === 0) console.log('No schedules: add one in the tray or menu bar app, or in config.json.')
}

/**
 * Moderator commands on this account: show them, switch them on or off (config.json), or lift a pause
 * (the daemon holds those). You can always override a moderator here.
 */
async function bots(args: string[]) {
  const [sub, arg] = args
  const store = new ConfigStore(getPaths().config) // no watch(): nothing keeps the process alive
  if (sub === 'on' || sub === 'off') {
    try {
      store.update(c => {
        c.moderation.enabled = sub === 'on'
      })
    } catch (e) {
      console.log(e instanceof Error ? e.message : String(e))
      process.exitCode = 1
      return
    }
    const ids = store.get().moderation.moderators
    console.log(
      sub === 'on'
        ? `Moderator commands are on: "/bots stop" and "/bots resume" from user ids ${ids.join(', ') || '(none yet: add them to moderation.moderators)'} now pause or resume Claude on this account.`
        : 'Moderator commands are off: /bots from anyone is just a message now.',
    )
    if (sub === 'off') console.log('Pauses a moderator set no longer apply here.')
  } else if (sub === 'resume') {
    if (arg !== undefined && !/^-?\d+$/.test(arg)) {
      console.log('usage: tgmcp bots resume [chat id]')
      process.exitCode = 1
      return
    }
    try {
      const res = await daemonFetch('ui', '/ui/bots/resume', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(arg === undefined ? {} : { chatId: Number(arg) }),
      })
      const body = await readDaemonReply(res)
      console.log(body.text)
      if (!body.ok) process.exitCode = 1
    } catch (e) {
      console.log(`The daemon did not answer (${e instanceof Error ? e.message : String(e)}). Is it running? tgmcp status`)
      process.exitCode = 1
    }
    return
  } else if (sub !== undefined) {
    console.log('usage: tgmcp bots [on|off|resume [chat id]]')
    process.exitCode = 1
    return
  }
  const m = store.get().moderation
  console.log(`Moderator commands: ${m.enabled ? 'on' : 'off'}`)
  console.log(`Moderators (user ids): ${m.moderators.join(', ') || '(none)'}`)
  console.log(`"/bots stop" lasts ${m.defaultMinutes} min unless they say (at most ${m.maxMinutes} min).`)
  try {
    // /status, not /ui/state: reading that one counts as the menu bar being open.
    const res = await daemonFetch('bridge', '/status')
    if (!res.ok) return
    const st = (await res.json()) as { moderation?: { appliesHere: boolean; pauses: { chatId: number | null; chatLabel: string; until: string; byName: string; by: number }[] } }
    if (!st.moderation) return
    if (!st.moderation.appliesHere) console.log('This account is a moderator, so /bots commands never pause it.')
    if (st.moderation.pauses.length === 0) console.log('Nothing is paused.')
    for (const p of st.moderation.pauses) {
      const where = p.chatId === null ? 'every chat' : `${p.chatLabel} (chat ${p.chatId})`
      console.log(`Paused: ${where} until ${new Date(p.until).toLocaleTimeString()}, by ${p.byName} (${p.by})`)
    }
  } catch {
    console.log('(The daemon is not answering, so pauses in force are not shown.)')
  }
}

function footer(args: string[]) {
  const parsed = parseFooterArgs(args)
  if (parsed.kind === 'error') {
    console.log(parsed.usage)
    process.exitCode = 1
    return
  }
  const store = new ConfigStore(getPaths().config)
  try {
    if (parsed.kind === 'patch') {
      const checked = applyFooterPatch(store.get(), parsed.patch)
      if (!checked.ok) {
        console.log(checked.error)
        process.exitCode = 1
        return
      }
      store.update(c => {
        const r = applyFooterPatch(c, parsed.patch)
        if (!r.ok) throw new Error(r.error)
        c.footer = r.footer
        if (r.savedFooter === undefined) delete c.savedFooter
        else c.savedFooter = r.savedFooter
      })
      console.log('Saved.')
    } else if (store.error()) {
      throw new Error(store.error()!)
    }
  } catch (e) {
    console.log(e instanceof Error ? e.message : String(e))
    process.exitCode = 1
    return
  }
  console.log(`Footer: ${footerSummary(store.get())}`)
}

/** install / uninstall / restart run the daemon under launchd. */
function needsLaunchd(): boolean {
  if (process.platform === 'darwin') return true
  console.log('This runs the daemon under launchd, which is macOS-only. Here, keep `tgmcp daemon` running in a terminal.')
  process.exitCode = 1
  return false
}

async function status() {
  const { agentInfo } = await import('./launchd')
  const agent = agentInfo()
  console.log(`launchd agent: ${agent ?? 'not installed'}`)
  let body: {
    pid: number
    startedAt: string
    telegram: { phase: string; me: { name: string; username: string | null; id: number } | null; reconnects: number; lastError: string | null; since: number }
    config: { path: string; error: string | null; writesRefused?: boolean }
    files?: { protectedDirWarnings: string[] }
    secrets?: { kind: string; where: string }
    menubar: boolean
    sessions: { id: string; label: string; connected: boolean; channel: boolean; monitors: number; watches: number; pending: number }[]
  }
  const paths = getPaths()
  try {
    const secrets = openSecretStore(paths)
    console.log(`secrets: ${secrets.where}`)
    const left = new FileSecretStore(paths).present()
    if (secrets.kind === 'keychain' && left.length > 0) {
      console.log(`  plain-text copies still on disk: ${left.join(', ')} (moved into the keystore the next time the daemon, a proxy or the CLI reads them)`)
    }
  } catch (e) {
    console.log(`secrets: ${e instanceof Error ? e.message : e}`)
    process.exitCode = 1
    return
  }
  try {
    const res = await daemonFetch('bridge', '/status')
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    body = (await res.json()) as typeof body
  } catch (e) {
    console.log(`daemon: not reachable on 127.0.0.1:${getPort()} (${e instanceof Error ? e.message : e})`)
    process.exitCode = 1
    return
  }
  const t = body.telegram
  console.log(`daemon: pid ${body.pid}, up since ${body.startedAt}`)
  console.log(
    `telegram: ${t.phase}${t.me ? ` as ${t.me.name}${t.me.username ? ` (@${t.me.username})` : ''}` : ''}, ${t.reconnects} reconnects${t.lastError && t.phase !== 'connected' ? `\n  last error: ${t.lastError}` : ''}`,
  )
  console.log(`config: ${body.config.path}${body.config.error ? `\n  ${body.config.error}` : ''}`)
  if (body.config.writesRefused) {
    console.log('  writes: REFUSED until config.json is valid (nothing is sent, edited, deleted or created)')
    process.exitCode = 1
  }
  for (const w of body.files?.protectedDirWarnings ?? []) console.log(`  files.protectedDirs warning: ${w}`)
  if (body.secrets && body.secrets.kind !== openSecretStore(paths).kind) {
    console.log(`  the daemon keeps its secrets in ${body.secrets.where}: restart it (tgmcp install) so both agree`)
  }
  const ui = process.platform === 'win32' ? 'tray app' : 'menu bar app'
  console.log(`${ui}: ${body.menubar ? 'connected (approvals go there)' : 'not running (approvals use the Claude Code dialog)'}`)
  console.log(`sessions: ${body.sessions.length}`)
  for (const s of body.sessions) {
    console.log(
      `  ${s.id} ${s.label} · ${s.connected ? 'connected' : 'gone (grace period)'}${s.channel ? ' · channel' : ''} · ${s.watches} watches · ${s.monitors} monitors · ${s.pending} queued`,
    )
  }
}

async function login(askCredentials: boolean) {
  const paths = getPaths()
  ensureHome(paths)
  const secrets = openSecretStore(paths)
  // Never run a second client next to a connected daemon: two connections on one auth key at
  // once can get the session killed by Telegram.
  let connectedAs: string | null = null
  try {
    const res = await daemonFetch('bridge', '/status')
    const body = (await res.json()) as { telegram: { phase: string; me: { name: string } | null } }
    if (body.telegram.phase === 'connected') connectedAs = body.telegram.me?.name ?? 'your account'
  } catch {}
  if (connectedAs && !askCredentials) {
    console.log(`Already logged in as ${connectedAs}. Nothing to do.`)
    return
  }

  let creds = askCredentials ? null : await loadCredentials(secrets)
  if (!creds) {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    console.log('Telegram API credentials (from https://my.telegram.org → API development tools).')
    const apiId = Number((await rl.question('api_id: ')).trim())
    const apiHash = (await rl.question('api_hash: ')).trim()
    rl.close()
    if (!apiId || !apiHash) throw new Error('Both api_id and api_hash are needed.')
    creds = { apiId, apiHash }
    await saveCredentials(secrets, creds)
    console.log(`Saved to ${secrets.where}`)
  }
  if (connectedAs) {
    console.log(`The daemon is logged in as ${connectedAs}. Run \`tgmcp restart\` to use the new credentials.`)
    return
  }

  const { TelegramClient } = await import('@mtcute/bun')
  const { openSessionStorage } = await import('./daemon/session-store')
  // fresh: a session.db whose key is gone can't be used, so start over instead of failing.
  const storage = await openSessionStorage(paths.session, secrets, { fresh: true, log: m => console.log(m) })
  const tg = new TelegramClient({ apiId: creds.apiId, apiHash: creds.apiHash, storage, updates: false })
  const me = await tg.start({
    phone: () => tg.input('Phone number (international format, e.g. +94771234567): '),
    code: () => tg.input('Login code (sent to your Telegram app): '),
    password: () => tg.input('Two-step verification password: '),
  })
  console.log(`Logged in as ${me.displayName}${me.username ? ` (@${me.username})` : ''}.`)
  await tg.destroy()
  ensureHome(paths) // tighten the new session files to 0600

  try {
    await daemonFetch('ui', '/admin/reconnect', { method: 'POST' })
    console.log('Told the daemon to connect. Check with `tgmcp status`.')
  } catch {
    console.log('The daemon is not running. Start it with `tgmcp install`.')
  }
}

async function pageSetup() {
  const paths = getPaths()
  ensureHome(paths)
  const secrets = openSecretStore(paths)
  console.log('Make a bot with @BotFather in Telegram (/newbot) and paste its token here.')
  console.log('It only ever messages you, so pages reach your phone as real notifications.\n')
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const token = (await rl.question('Bot token: ')).trim()
  rl.close()
  if (!/^\d+:[\w-]{30,}$/.test(token)) throw new Error('That does not look like a bot token (123456:ABC…).')
  const { PageBot } = await import('./daemon/page-bot')
  const me = await new PageBot({ token, ownerId: () => null, onAction: () => {} }).me()
  await secrets.set('page-bot', token)
  console.log(`\nSaved @${me.username}'s token to ${secrets.where}.`)
  console.log(`Now open https://t.me/${me.username}, press Start, and keep that chat unmuted, or the phone won't buzz.`)
  console.log('Then run `tgmcp restart` and `tgmcp page test`.')
}

async function pageTest() {
  // The daemon answers once the bot has tried the phone, which can take its full 10 s timeout.
  const res = await daemonFetch('ui', '/ui/pages/test', { method: 'POST' }, 15_000)
  const body = await readDaemonReply(res)
  console.log(body.text)
  if (!body.ok) process.exitCode = 1
}

function mcpAdd() {
  const self = shellJoin(selfCommand())
  console.log('Register for every project (user scope):\n')
  console.log(`  claude mcp add --scope user tg -- ${self} mcp\n`)
  console.log('Optional push mode (messages appear in the session by themselves; needs the dev-channels flag at launch):\n')
  console.log(`  claude mcp add --scope user tg -- ${self} mcp --channel`)
  console.log('  claude --dangerously-load-development-channels server:tg')
}

const [cmd, ...rest] = process.argv.slice(2)
// Everything we create in the home folder is private to you.
process.umask(0o077)
switch (cmd) {
  case 'daemon': {
    const { runDaemon } = await import('./daemon/main')
    await runDaemon()
    break
  }
  case 'mcp': {
    const { runProxy } = await import('./mcp/proxy')
    const { deskName } = await import('./shared/desks')
    // --desk <name> (or TELEGRAM_MCP_DESK): this session holds that desk. A name that isn't valid is ignored.
    const at = rest.indexOf('--desk')
    const asked = at >= 0 ? rest[at + 1] : process.env.TELEGRAM_MCP_DESK
    const desk = deskName(asked)
    if (at >= 0 && asked === undefined) process.stderr.write('[telegram-mcp] --desk needs a name; starting as an ordinary session\n')
    else if (asked !== undefined && !desk) process.stderr.write(`[telegram-mcp] ignoring desk name "${asked}": use 1 to 32 lowercase letters, digits, - and _\n`)
    await runProxy({ channel: rest.includes('--channel') || process.env.TELEGRAM_MCP_CHANNEL === '1', desk })
    break
  }
  case 'install': {
    if (!needsLaunchd()) break
    const { installAgent } = await import('./launchd')
    const paths = getPaths()
    ensureHome(paths)
    new ConfigStore(paths.config).close()
    console.log(`Installed ${installAgent(paths)}. The daemon is starting; check with \`tgmcp status\`.`)
    break
  }
  case 'uninstall': {
    if (!needsLaunchd()) break
    const { uninstallAgent } = await import('./launchd')
    console.log(uninstallAgent() ? 'Removed the launchd agent and stopped the daemon.' : 'No launchd agent was installed.')
    break
  }
  case 'restart': {
    if (!needsLaunchd()) break
    const { restartAgent } = await import('./launchd')
    restartAgent()
    console.log('Restarted.')
    break
  }
  case 'status':
    await status()
    break
  case 'login':
    await login(rest.includes('--credentials'))
    break
  case 'logs': {
    const p = getPaths()
    spawn('tail', ['-n', '50', '-F', p.log, `${p.home}/daemon.stderr.log`], { stdio: 'inherit' })
    break
  }
  case 'config':
    console.log(getPaths().config)
    break
  case 'call': {
    // Call a tool as a throwaway session: tgmcp call telegram_status '{}'
    const [tool, json] = rest
    if (!tool) {
      console.log('usage: tgmcp call <tool> [json-args]')
      process.exit(1)
    }
    // __decide, __await_approval and the like are the proxy's own calls (its dialog's answer), never a tool.
    if (tool.startsWith('__')) {
      console.error(`tgmcp call runs tools only; ${tool} is internal to the MCP proxy.`)
      process.exit(1)
    }
    const { DaemonClient } = await import('./mcp/daemon-client')
    const { newId } = await import('./daemon/sessions')
    const secrets = openSecretStore(getPaths())
    const client = new DaemonClient({
      target: async () => {
        const token = await readToken(secrets)
        return token ? { url: `ws://127.0.0.1:${getPort()}/bridge`, token } : null
      },
      sessionId: newId('s_'),
      label: 'tgmcp call',
      channel: false,
      log: () => {},
    })
    client.start()
    try {
      const { result } = await client.call(tool, json ? JSON.parse(json) : {})
      console.log(result.text)
      if (result.isError) process.exitCode = 1
    } catch (e) {
      console.error(e instanceof Error ? e.message : e)
      process.exitCode = 1
    }
    client.close()
    process.exit()
  }
  case 'menubar': {
    const sub = rest[0] ?? 'install'
    if (process.platform === 'win32') {
      const { buildTray, installTray, uninstallTray } = await import('./tray')
      if (sub === 'build') console.log(buildTray())
      else if (sub === 'install') console.log(`Tray app running and starts at login: ${installTray(getPaths())}`)
      else if (sub === 'uninstall') console.log(uninstallTray() ? 'The tray app quit and no longer starts at login.' : 'It was not set to start at login.')
      else console.log('usage: tgmcp menubar [install|uninstall|build]')
      break
    }
    if (process.platform !== 'darwin') {
      console.log('The menu bar app is for macOS and the tray app for Windows: there is none for this system yet.')
      process.exitCode = 1
      break
    }
    const { buildMenubar, installMenubar, uninstallMenubar } = await import('./launchd')
    if (sub === 'build') console.log(buildMenubar())
    else if (sub === 'install') console.log(`Menu bar app running and starts at login: ${installMenubar(getPaths())}`)
    else if (sub === 'uninstall') console.log(uninstallMenubar() ? 'Removed the menu bar app agent.' : 'It was not installed.')
    else console.log('usage: tgmcp menubar [install|uninstall|build]')
    break
  }
  case 'page': {
    const sub = rest[0]
    if (sub === 'setup') await pageSetup()
    else if (sub === 'test') await pageTest()
    else {
      console.log('usage: tgmcp page setup | tgmcp page test')
      process.exitCode = 1
    }
    break
  }
  case 'away':
    await away(rest)
    break
  case 'bots':
    await bots(rest)
    break
  case 'footer':
    footer(rest)
    break
  case 'mcp-add':
    mcpAdd()
    break
  case 'version':
  case '--version':
  case '-v':
    console.log(`tgmcp ${VERSION} (${isCompiled() ? `release build, ${process.platform}-${process.arch}` : `from source, bun ${Bun.version}`})`)
    break
  default:
    console.log(HELP)
    if (cmd && cmd !== 'help' && cmd !== '--help' && cmd !== '-h') process.exitCode = 1
}
