// A daemon with a fake Telegram and some state, for working on the menu bar app without a real account.
//   bun scripts/demo-daemon.ts            then, in another shell:
//   TELEGRAM_MCP_HOME=/tmp/tgmcp-demo TELEGRAM_MCP_PORT=47901 TELEGRAM_MCP_SECRET_STORE=file "menubar/build/Telegram MCP.app/Contents/MacOS/TelegramMCPBar"
// The demo keeps its token in a file, so it never adds entries to your Keychain.
// DEMO_PORT and DEMO_HOME run a second one next to it (the tray app's tests do), e.g. on Windows.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createDaemon } from '../src/daemon/main'
import { DaemonClient } from '../src/mcp/daemon-client'
import { getPaths } from '../src/shared/paths'
import { demoAvatar } from '../test/demo-avatars'
import { ALL_HANDS, ANNA, FakeTelegram, TEAM_QA, LEO, LEONARDO } from '../test/fake-telegram'

process.env.TELEGRAM_MCP_SECRET_STORE = 'file'
const home = process.env.DEMO_HOME || '/tmp/tgmcp-demo'
const port = Number(process.env.DEMO_PORT) || 47901
rmSync(home, { recursive: true, force: true })
mkdirSync(home, { recursive: true })
const paths = getPaths(home)
writeFileSync(
  paths.config,
  JSON.stringify({
    footer: '\n\n✨ sᴇɴᴛ ᴠɪᴀ ᴄʟᴀᴜᴅᴇ',
    chats: {
      leo: { id: LEO.id, username: 'leo_p', name: LEO.name, type: 'user', aliases: ['leonard'] },
      anna: { id: ANNA.id, username: 'anna_k', name: ANNA.name, type: 'user' },
      'team-qa': { id: TEAM_QA.id, name: 'Team QA', type: 'group', topicId: 42, notes: 'QA topic' },
      'all-hands': { id: ALL_HANDS.id, name: ALL_HANDS.name, type: 'group' },
    },
    rules: { blocked: ['all-hands'], autoSend: ['leo', 'anna'], requireApproval: ['team-qa'], autoReply: ['anna', 'leo'] },
  }),
)
const tg = new FakeTelegram().add(LEO, ANNA, TEAM_QA, LEONARDO, ALL_HANDS)
// Made-up "photos" (no real ones in screenshots): Leo and Team QA have one, the rest keep their initials.
tg.photos.set(LEO.id, demoAvatar(0x0ea5e9, 0x6366f1))
tg.photos.set(TEAM_QA.id, demoAvatar(0xf59e0b, 0xdb2777))
const daemon = await createDaemon({ paths, port, telegram: tg, log: () => {} })

function session(label: string) {
  const c = new DaemonClient({
    target: () => ({ url: `ws://127.0.0.1:${port}/bridge`, token: daemon.token }),
    sessionId: `s_${label.padEnd(8, 'x').slice(0, 8)}`,
    label,
    channel: false,
    log: () => {},
  })
  c.start()
  return c
}
const api = session('api-server · pid 4121')
const web = session('web-app · pid 5230')
await api.call('telegram_watch', { chat: 'anna', note: 'waiting for the staging link' })
await web.call('telegram_watch', { chat: 'anna' })
await web.call('telegram_watch', { chat: 'leo' })
await api.call('telegram_send_message', { to: 'leo', text: 'Deployed v2.3 to staging, can you check the login flow?' })
await web.call('telegram_send_message', { to: 'anna', text: 'The signup form now accepts uploads up to 10 MB.' })
await api.call('telegram_send_message', { to: 'leo', text: 'Also the rate limiter is back on.' })
await api.call('telegram_send_message', {
  to: 'team-qa',
  // Long on purpose: hovering the card expands it past the bottom of the screen, so the panel has to scroll.
  text: [
    'Hi team, v2.3 is on staging. Please run the QA checklist for the upload flow.',
    ...Array.from({ length: 12 }, (_, i) => `${i + 1}. Upload a file of type ${['PNG', 'JPEG', 'PDF', 'HEIC'][i % 4]} at ${((i + 1) * 0.8).toFixed(1)} MB from ${['Safari', 'Chrome', 'Firefox'][i % 3]}, refresh the page, and check that the preview, file name and size match what was uploaded.`),
    'Then try a 12 MB file: it should be refused with a clear message, and nothing should be stored.',
    'Reply here with anything that looks off. Thanks!',
  ].join('\n\n'),
})
await web.call('telegram_send_message', { to: '@leonardo_s', text: 'Hey Leonardo, are you free for a quick call about the payments integration?' })
console.log(`demo daemon on ${port}, home ${home}`)
