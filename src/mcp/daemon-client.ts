import type { ClientMessage, ServerMessage, TelegramState, TgEvent, ToolResult, WatchSpec } from '../shared/protocol'

/** Where the daemon is and the token to show it. The token goes in the Authorization header, never in the URL. */
export interface DaemonTarget {
  url: string
  token: string
}

export interface DaemonClientOptions {
  /** Built fresh on every attempt (the token may appear after we start). Null = not ready yet. */
  target: () => DaemonTarget | null | Promise<DaemonTarget | null>
  sessionId: string
  label: string
  channel: boolean
  /** Speak as this desk's session (tgmcp mcp --desk). */
  desk?: string
  log: (msg: string) => void
  /** Called once if the daemon can't be reached at first, e.g. to ask launchd to start it. */
  onUnreachable?: () => void
}

interface Pending {
  resolve: (v: { result: ToolResult; pending: number }) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * The proxy's line to the daemon. Reconnects forever with backoff and says hello again with
 * this session's watches, so a daemon restart doesn't lose them. Never throws on its own;
 * only calls fail, with a message the model can act on.
 */
export class DaemonClient {
  #ws: WebSocket | null = null
  #open = false
  #closed = false
  #nextId = 1
  #backoff = 250
  #pending = new Map<number, Pending>()
  #waiters = new Set<() => void>()
  #watches: WatchSpec[] = []
  #pokedLaunchd = false
  #lastUrlError: string | null = null
  telegram: TelegramState | null = null
  onEvent: (e: TgEvent) => void = () => {}

  constructor(private readonly o: DaemonClientOptions) {}

  get connected(): boolean {
    return this.#open
  }

  get watches(): WatchSpec[] {
    return this.#watches
  }

  start(): void {
    void this.#connect()
  }

  close(): void {
    this.#closed = true
    this.#ws?.close()
  }

  async #connect() {
    if (this.#closed) return
    let target: DaemonTarget | null
    try {
      target = await this.o.target()
      this.#lastUrlError = null
    } catch (e) {
      // Usually the keystore saying no. Say it once, not on every retry.
      const why = e instanceof Error ? e.message : String(e)
      if (why !== this.#lastUrlError) this.o.log(why)
      this.#lastUrlError = why
      target = null
    }
    if (this.#closed) return
    if (!target) {
      this.#retry()
      return
    }
    let ws: WebSocket
    try {
      ws = new WebSocket(target.url, { headers: { authorization: `Bearer ${target.token}` } })
    } catch (e) {
      this.o.log(`daemon connect failed: ${e}`)
      this.#retry()
      return
    }
    this.#ws = ws
    ws.onopen = () => {
      const hello: ClientMessage = {
        t: 'hello',
        sessionId: this.o.sessionId,
        label: this.o.label,
        channel: this.o.channel,
        watches: this.#watches,
        ...(this.o.desk ? { desk: this.o.desk } : {}),
      }
      ws.send(JSON.stringify(hello))
      this.#open = true
      this.#backoff = 250
      for (const wake of this.#waiters) wake()
      this.#waiters.clear()
      this.o.log('connected to daemon')
    }
    ws.onmessage = ev => this.#handle(String(ev.data))
    ws.onclose = () => {
      const wasOpen = this.#open
      this.#open = false
      this.#ws = null
      for (const [id, p] of this.#pending) {
        clearTimeout(p.timer)
        p.reject(
          new Error(
            'Lost the connection to the Telegram daemon during this call (it is restarting). If this was a send, check with telegram_read_messages before retrying so nothing goes out twice.',
          ),
        )
        this.#pending.delete(id)
      }
      if (wasOpen) this.o.log('daemon connection closed, reconnecting')
      this.#retry()
    }
    ws.onerror = () => {}
  }

  #retry() {
    if (this.#closed) return
    if (!this.#pokedLaunchd && this.#backoff >= 1_000) {
      this.#pokedLaunchd = true
      this.o.onUnreachable?.()
    }
    setTimeout(() => void this.#connect(), this.#backoff)
    this.#backoff = Math.min(this.#backoff * 2, 5_000)
  }

  #handle(raw: string) {
    let msg: ServerMessage
    try {
      msg = JSON.parse(raw) as ServerMessage
    } catch {
      return
    }
    switch (msg.t) {
      case 'welcome':
        this.telegram = msg.telegram
        return
      case 'watches':
        this.#watches = msg.watches
        return
      case 'event':
        this.onEvent(msg.event)
        return
      case 'result': {
        const p = this.#pending.get(msg.id)
        if (!p) return
        this.#pending.delete(msg.id)
        clearTimeout(p.timer)
        if (msg.ok) p.resolve({ result: msg.result, pending: msg.pending })
        else p.reject(new Error(msg.error))
      }
    }
  }

  #waitOpen(ms: number): Promise<void> {
    if (this.#open) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const wake = () => {
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(() => {
        this.#waiters.delete(wake)
        reject(
          new Error(
            'The Telegram daemon is not reachable. It normally runs under launchd: check `tgmcp status`, or start it with `tgmcp install` (or `tgmcp daemon` in a terminal). This session reconnects by itself once it is up.',
          ),
        )
      }, ms)
      this.#waiters.add(wake)
    })
  }

  async call(method: string, params: unknown, timeoutMs = 120_000): Promise<{ result: ToolResult; pending: number }> {
    await this.#waitOpen(15_000)
    const ws = this.#ws
    if (!ws) throw new Error('daemon connection dropped, try again')
    const id = this.#nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new Error(`The daemon did not answer ${method} within ${timeoutMs / 1000}s.`))
      }, timeoutMs)
      this.#pending.set(id, { resolve, reject, timer })
      ws.send(JSON.stringify({ t: 'call', id, method, params } satisfies ClientMessage))
    })
  }
}
