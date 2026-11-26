import { createHmac, timingSafeEqual } from 'node:crypto'
import type { AvatarCache } from './avatars'
import type { PageAction } from './pager'
import type { ServerWebSocket } from 'bun'
import type { ConfigStore } from '../shared/config'
import { SEND_MODES } from '../shared/contacts'
import { deskName, deskSessionId } from '../shared/desks'
import { UI_FEATURES_HEADER, type ClientMessage, type SendMode, type ServerMessage } from '../shared/protocol'
import { oneLine } from '../shared/text'
import { cleanWatches } from './desk-store'
import type { Service } from './service'
import type { SessionHub } from './sessions'
import type { TelegramPort } from './telegram'

interface WsData {
  kind: 'bridge' | 'events'
  sessionId: string | null
}

export interface ServerOptions {
  port: number
  /** The bridge token: Claude sessions (MCP proxies, `tgmcp call`) on /bridge, and /status. */
  token: string
  /** The menu bar and tray apps' token: /ui/* and /admin/* only. */
  uiToken: string
  /** Shown in /status. */
  secrets: { kind: string; where: string }
  service: Service
  hub: SessionHub
  tg: TelegramPort
  store: ConfigStore
  /** Contacts' profile photos (GET /ui/avatars/:chatId). */
  avatars: AvatarCache
  log: (msg: string) => void
  startedAt: number
}

/** The newer approval kinds the calling menu bar or tray app can show (UI_FEATURES_HEADER). */
function uiFeatures(req: Request): string[] {
  return (req.headers.get(UI_FEATURES_HEADER) ?? '')
    .split(',')
    .map(f => f.trim().toLowerCase())
    .filter(Boolean)
}

function sameToken(given: string | null, token: string): boolean {
  if (!given) return false
  const a = Buffer.from(given)
  const b = Buffer.from(token)
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * The key in a Monitor URL. It opens that one session's event stream and nothing else, so the
 * URL (which the model sees, and Claude Code keeps in its transcripts) never carries the token.
 */
export function eventsKey(token: string, sessionId: string, epoch = ''): string {
  // A desk's key also names its holder (SessionHub#eventsEpoch); an ordinary session's is unchanged.
  return createHmac('sha256', token).update(epoch ? `events:${sessionId}:${epoch}` : `events:${sessionId}`).digest('hex').slice(0, 32)
}

/** The menu bar and tray apps' routes, which take the UI token and never the bridge token. */
export function isUiRoute(pathname: string): boolean {
  return /^\/(ui|admin)(\/|$)/.test(pathname)
}

/**
 * Localhost only. Everything except /health needs a token (kept in the OS keystore), which
 * also keeps web pages in a browser (which can reach 127.0.0.1) from reading your messages.
 * There are two: /ui/* and /admin/* take the UI token (the menu bar and tray apps, and the CLI
 * commands a person runs), everything else the bridge token (Claude sessions). Each is refused
 * with 403 where the other one belongs; no token, or a wrong one, gets 401.
 * /events also takes its session's own key instead (see eventsKey).
 *
 *   GET  /health                 liveness, no auth
 *   GET  /status                 JSON status
 *   POST /admin/reconnect        rebuild the Telegram client (used after `tgmcp login`)
 *   GET  /ui/state               what the menu bar app shows
 *   GET  /ui/avatars/:chatId     that chat's small profile photo (JPEG), 404 when it has none; only
 *                                chats in /ui/state, fetched once and cached on disk for a day
 *   POST /ui/bots/resume         {"chatId"?: number}  lift a moderator's pause on this account (one chat, or all of them)
 *   POST /ui/approvals/:id       {"decision": "approve" | "deny", "remember"?: "autoSend" | "requireApproval", "nickname"?: "…"}
 *   POST /ui/contacts            {"nickname": "…", "sendMode"?: "autoSend" | "requireApproval" | "blocked" | "none",
 *                                 "autoReply"?: true | false, "pageFrom"?: true | false, "rename"?: "…"}
 *                                (the Contacts page: a human editing the rules)
 *   POST /ui/contacts/page       {"nickname": "…", "reason"?: "…"}  the Page button: "/page <reason>" to that person
 *   POST /ui/pages/:id           {"action": "ack" | "snooze", "minutes"?: 15 | 60, "from"?: "menubar" | "tray"}
 *   POST /ui/footer              {"footer"?, "enabled"?}  the footer added to every message (off keeps its text)
 *   POST /ui/away                {"enabled"?, "quietMinutes"?, "skip"?, "schedules"?}  the away auto-reply settings ("schedules"
 *                                and "skip" replace the whole list; "from", "until" and "message" still change the first schedule)
 *   POST /ui/pages/test          ring a test page (tgmcp page test)
 *   WS   /bridge                 one per Claude session: the MCP proxy's tool calls and pushes
 *   WS   /events?session=ID&key=K  Monitor stream: one text frame per watched message
 */
export function startServer(o: ServerOptions) {
  const send = (ws: ServerWebSocket<WsData>, msg: ServerMessage) => ws.send(JSON.stringify(msg))

  return Bun.serve<WsData>({
    hostname: '127.0.0.1',
    port: o.port,
    fetch(req, server) {
      const url = new URL(req.url)
      if (url.pathname === '/health') return Response.json({ ok: true, service: 'telegram-mcp' })

      const bearer = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? null
      // Only the header: a token in a URL ends up in logs, history and transcripts.
      const authed = sameToken(bearer, o.token)
      const uiAuthed = sameToken(bearer, o.uiToken)

      if (url.pathname === '/events') {
        const sid = url.searchParams.get('session')
        // An ordinary session's random id, or a desk's (d_<desk name>).
        if (!sid || !/^(s_[a-z0-9]{8}|d_[a-z0-9][a-z0-9_-]{0,31})$/.test(sid)) {
          return new Response(authed ? 'bad session id\n' : 'unauthorized\n', { status: authed ? 400 : 401 })
        }
        if (!authed && !sameToken(url.searchParams.get('key'), eventsKey(o.token, sid, o.hub.eventsEpoch(sid)))) {
          // A desk's Monitor URL changes when another session gets the desk: say where the current one is.
          const hint = sid.startsWith('d_')
            ? "unauthorized: this desk's Monitor URL changed (another session held the desk). Call telegram_status for the current one; if it says another session holds the desk, this session no longer acts for it.\n"
            : 'unauthorized\n'
          return new Response(hint, { status: 401 })
        }
        return server.upgrade(req, { data: { kind: 'events', sessionId: sid } })
          ? undefined
          : new Response('expected a websocket\n', { status: 400 })
      }
      // Each token opens only its own routes: the bridge token never opens the apps' routes, and the
      // UI token never opens /bridge (so it can't act as a session) or /status.
      const ui = isUiRoute(url.pathname)
      if (ui ? !uiAuthed : !authed) {
        const otherToken = ui ? authed : uiAuthed
        return new Response(otherToken ? 'forbidden: this token is not for this route\n' : 'unauthorized\n', { status: otherToken ? 403 : 401 })
      }

      if (url.pathname === '/bridge') {
        return server.upgrade(req, { data: { kind: 'bridge', sessionId: null } })
          ? undefined
          : new Response('expected a websocket\n', { status: 400 })
      }
      if (url.pathname === '/ui/state' && req.method === 'GET') {
        const features = uiFeatures(req)
        o.service.touchUi(features)
        return Response.json(o.service.uiState({ create: features.includes('create') }))
      }
      const avatarFor = /^\/ui\/avatars\/(-?\d{1,20})$/.exec(url.pathname)
      if (avatarFor && req.method === 'GET') {
        const chatId = Number(avatarFor[1])
        const none = () => new Response('no photo\n', { status: 404, headers: { 'cache-control': 'private, max-age=3600' } })
        if (!Number.isSafeInteger(chatId) || !o.service.uiChatIds().has(chatId)) return none()
        return (async () => {
          const a = await o.avatars.get(chatId)
          if (!a) return none()
          const etag = `"${a.tag}"`
          const headers = { etag, 'content-type': a.type, 'cache-control': 'private, max-age=3600' }
          if (req.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers })
          return new Response(a.bytes, { headers })
        })()
      }
      const decision = /^\/ui\/approvals\/([\w-]+)$/.exec(url.pathname)
      if (decision && req.method === 'POST') {
        return (async () => {
          const body = (await req.json().catch(() => ({}))) as { decision?: unknown; remember?: unknown; nickname?: unknown }
          if (body.decision !== 'approve' && body.decision !== 'deny') {
            return Response.json({ ok: false, text: 'decision must be "approve" or "deny"' }, { status: 400 })
          }
          const remember = body.remember === 'autoSend' || body.remember === 'requireApproval' ? body.remember : undefined
          const nickname = typeof body.nickname === 'string' ? body.nickname : undefined
          try {
            const uiCreate = uiFeatures(req).includes('create')
            const r = await o.service.decide(decision[1]!, body.decision === 'approve', 'menubar', null, { remember, nickname, uiCreate })
            return Response.json({ ok: !r.isError, text: r.text }, { status: r.isError ? 409 : 200 })
          } catch (e) {
            return Response.json({ ok: false, text: e instanceof Error ? e.message : String(e) }, { status: 409 })
          }
        })()
      }
      if (url.pathname === '/ui/bots/resume' && req.method === 'POST') {
        return (async () => {
          const body = (await req.json().catch(() => ({}))) as { chatId?: unknown }
          if (body.chatId !== undefined && !Number.isSafeInteger(body.chatId)) {
            return Response.json({ ok: false, text: 'chatId must be a whole number' }, { status: 400 })
          }
          const r = o.service.resumeLocally(body.chatId === undefined ? 'all' : (body.chatId as number))
          return Response.json(r)
        })()
      }
      if (url.pathname === '/ui/away' && req.method === 'POST') {
        return (async () => {
          const body = await req.json().catch(() => ({}))
          const r = o.service.editAway(body)
          if (r.ok) o.log(`menu bar away: ${r.text}`)
          return Response.json(r, { status: r.ok ? 200 : 400 })
        })()
      }
      if (url.pathname === '/ui/footer' && req.method === 'POST') {
        return (async () => {
          const body = await req.json().catch(() => ({}))
          const r = o.service.editFooter(body)
          if (r.ok) o.log(`menu bar footer: ${r.text}`)
          return Response.json(r, { status: r.ok ? 200 : 400 })
        })()
      }
      if (url.pathname === '/ui/pages/test' && req.method === 'POST') {
        return (async () => {
          const r = await o.service.testPage()
          return Response.json(r, { status: r.ok ? 200 : 409 })
        })()
      }
      const pageAct = /^\/ui\/pages\/(pg_[a-z0-9]+)$/.exec(url.pathname)
      if (pageAct && req.method === 'POST') {
        return (async () => {
          const body = (await req.json().catch(() => ({}))) as { action?: unknown; minutes?: unknown; from?: unknown }
          if (body.action !== 'ack' && body.action !== 'snooze') {
            return Response.json({ ok: false, text: 'action must be "ack" or "snooze"' }, { status: 400 })
          }
          const action: PageAction =
            body.action === 'ack' ? { kind: 'ack' } : { kind: 'snooze', minutes: body.minutes === 60 ? 60 : 15 }
          const by = body.from === 'tray' ? 'tray' : 'menubar'
          const ok = await o.service.pageAction(pageAct[1]!, action, by)
          if (ok) o.log(`page ${pageAct[1]}: ${body.action} from the ${by}`)
          return Response.json({ ok, text: ok ? 'done' : 'no such page, or it was settled already' }, { status: ok ? 200 : 409 })
        })()
      }
      if (url.pathname === '/ui/contacts/page' && req.method === 'POST') {
        return (async () => {
          const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
          const bad = (text: string) => Response.json({ ok: false, text }, { status: 400 })
          if (typeof body.nickname !== 'string' || body.nickname.trim() === '') return bad('nickname is required')
          if (body.reason !== undefined && typeof body.reason !== 'string') return bad('reason must be a string')
          const r = await o.service.pageContact(body.nickname, (body.reason as string | undefined) ?? '')
          o.log(`menu bar page to ${body.nickname}: ${r.ok ? 'sent' : r.text}`)
          return Response.json(r, { status: r.ok ? 200 : 409 })
        })()
      }
      if (url.pathname === '/ui/contacts' && req.method === 'POST') {
        return (async () => {
          const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
          const bad = (text: string) => Response.json({ ok: false, text }, { status: 400 })
          if (typeof body.nickname !== 'string' || body.nickname.trim() === '') return bad('nickname is required')
          if (body.sendMode !== undefined && !SEND_MODES.includes(body.sendMode as SendMode)) {
            return bad(`sendMode must be one of ${SEND_MODES.join(', ')}`)
          }
          if (body.autoReply !== undefined && typeof body.autoReply !== 'boolean') return bad('autoReply must be true or false')
          if (body.pageFrom !== undefined && typeof body.pageFrom !== 'boolean') return bad('pageFrom must be true or false')
          if (body.rename !== undefined && typeof body.rename !== 'string') return bad('rename must be a string')
          if (body.sendMode === undefined && body.autoReply === undefined && body.pageFrom === undefined && body.rename === undefined) {
            return bad('nothing to change: send sendMode, autoReply, pageFrom or rename')
          }
          const r = o.service.editContact({
            nickname: body.nickname,
            sendMode: body.sendMode as SendMode | undefined,
            autoReply: body.autoReply as boolean | undefined,
            pageFrom: body.pageFrom as boolean | undefined,
            rename: body.rename as string | undefined,
          })
          if (r.ok) o.log(`menu bar contacts: ${r.text}`)
          return Response.json(r, { status: r.ok ? 200 : 409 })
        })()
      }
      if (url.pathname === '/status' && req.method === 'GET') {
        return Response.json({
          pid: process.pid,
          startedAt: new Date(o.startedAt).toISOString(),
          telegram: o.tg.state(),
          config: { path: o.store.path, error: o.store.error(), writesRefused: o.store.writesRefused() !== null },
          secrets: o.secrets,
          menubar: o.service.uiActive(),
          sessions: o.hub.summary(),
          moderation: o.service.moderationState(),
          files: { protectedDirWarnings: o.service.protectedDirWarnings() },
        })
      }
      if (url.pathname === '/admin/reconnect' && req.method === 'POST') {
        void o.tg.reconnect('requested over http')
        return Response.json({ ok: true })
      }
      return new Response('not found\n', { status: 404 })
    },
    websocket: {
      idleTimeout: 120,
      sendPings: true,
      open(ws) {
        if (ws.data.kind === 'events' && ws.data.sessionId) o.hub.attachMonitor(ws.data.sessionId, ws)
      },
      message(ws, raw) {
        if (ws.data.kind !== 'bridge') return
        let msg: ClientMessage
        try {
          msg = JSON.parse(String(raw)) as ClientMessage
        } catch {
          return
        }
        if (msg.t === 'hello') {
          // A proxy started with --desk speaks as the desk's one session; a name that isn't valid, or
          // that config.json doesn't list, is ignored.
          let desk = deskName(msg.desk)
          // While no valid config.json has loaded since start, a desk desks.json kept is taken on trust.
          const kept = desk !== null && o.store.writesRefused() !== null && o.hub.deskOf(deskSessionId(desk)) === desk
          if (desk && !kept && !Object.hasOwn(o.store.get().desks, desk)) {
            o.log(`session ${msg.sessionId} asked for desk "${desk}", which config.json doesn't list: an ordinary session`)
            desk = null
          }
          // Without a desk, only an ordinary session's id (a desk's d_ id comes only from --desk).
          if (!desk && (typeof msg.sessionId !== 'string' || !/^s_[a-z0-9]{8}$/.test(msg.sessionId))) {
            ws.close(1008, 'bad session id')
            return
          }
          const sid = desk ? deskSessionId(desk) : msg.sessionId
          ws.data.sessionId = sid
          const startedAt = typeof msg.startedAt === 'number' && Number.isFinite(msg.startedAt) ? msg.startedAt : 0
          // Labels and watches are kept for a desk (desks.json) and shown on header lines: take only well-formed ones.
          const label = (typeof msg.label === 'string' ? oneLine(msg.label).slice(0, 200) : '') || sid
          const watches = cleanWatches(Array.isArray(msg.watches) ? msg.watches : [])
          const current = o.hub.attachProxy(sid, { label, channel: msg.channel === true, watches, desk, startedAt }, ws)
          send(ws, { t: 'welcome', telegram: o.tg.state() })
          if (!current) {
            // A newer proxy holds this desk, or it is kept for one. The connection stays (closing it would
            // only make the proxy reconnect in a loop); every call on it is refused with an error that says
            // why, and it gets the desk if that proxy doesn't come back.
            const holds = o.hub.heldDesks().includes(sid)
            o.log(`session ${sid} (${label}) turned away: ${holds ? 'a newer proxy holds' : 'it is kept for a newer proxy of'} desk ${desk}`)
            return
          }
          o.log(`session ${sid} connected (${label}${msg.channel === true ? ', channel' : ''}${desk ? `, desk ${desk}` : ''})`)
          // A desk that comes back gets what its chats said while nothing could hand it over.
          if (desk) void o.service.catchUpDesk(sid).catch(e => o.log(`desk ${desk}: catch-up failed: ${e instanceof Error ? e.message : String(e)}`))
          return
        }
        if (msg.t === 'call') {
          const sid = ws.data.sessionId
          if (!sid) {
            send(ws, { t: 'result', id: msg.id, ok: false, error: 'say hello first' })
            return
          }
          if (!o.hub.isCurrentProxy(sid, ws)) {
            const desk = o.hub.deskOf(sid)
            send(ws, {
              t: 'result',
              id: msg.id,
              ok: false,
              error: o.hub.heldDesks().includes(sid)
                ? `Another Claude session now holds desk "${desk}" (it started later with --desk ${desk}). This session no longer acts for that desk: nothing was done. Only one session should hold a desk; close this one or start it without --desk.`
                : `Desk "${desk}" is kept for a session that started later with --desk ${desk} and is reconnecting. This session doesn't act for it now: nothing was done. If that session doesn't come back within about half a minute, this one gets the desk; call telegram_status then for its Monitor URL.`,
            })
            return
          }
          o.service
            .call(sid, msg.method, msg.params)
            .then(result => send(ws, { t: 'result', id: msg.id, ok: true, result, pending: o.hub.pending(sid) }))
            .catch(e => send(ws, { t: 'result', id: msg.id, ok: false, error: e instanceof Error ? e.message : String(e) }))
        }
      },
      close(ws) {
        const sid = ws.data.sessionId
        if (!sid) return
        if (ws.data.kind === 'bridge') {
          o.hub.detachProxy(sid, ws)
          o.log(`session ${sid} disconnected`)
        } else {
          o.hub.detachMonitor(sid, ws)
        }
      },
    },
  })
}
