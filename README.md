<p align="center">
  <img src="docs/social-preview.svg" width="100%" alt="telegram-mcp: let Claude use your Telegram, and send only what you allow. One always-on Telegram daemon, shared by every Claude Code session.">
</p>

# telegram-mcp

Telegram for Claude Code, through **one always-on daemon** instead of a Telegram connection per session.

```
Claude session A ─┐ stdio                                   
Claude session B ─┼─ tgmcp mcp (thin proxy, no Telegram) ── WebSocket ──► tgmcp daemon ──► Telegram
Claude session C ─┘                                          127.0.0.1      (launchd, KeepAlive)
```

- **The daemon** (`tgmcp daemon`) runs under launchd, starts at login, and is restarted if it ever exits. It holds the only Telegram connection (your user account, via [mtcute](https://mtcute.dev)), reads the rules file, and keeps every session's watches.
- **The proxy** (`tgmcp mcp`) is what Claude Code launches for each session. It has no Telegram connection. It forwards tool calls to the daemon, and if the daemon restarts it reconnects by itself and restores the session's watches. It never exits over daemon trouble, so Claude Code never marks the server "failed" and you never have to `/mcp reconnect`.

## Staying connected without a human

- mtcute reconnects dropped sockets by itself.
- A watchdog pings Telegram every 30 s and rebuilds the client when two pings fail, when it has been stuck "connecting" for 90 s, or straight after the Mac wakes from sleep. Rebuilds retry forever, backing off up to a minute.
- Messages that arrive while the connection is down are caught up after it reconnects (mtcute's update gap recovery), and each one is delivered only once.
- A tool call made during a reconnect waits up to ~25 s for the connection instead of failing.
- If the daemon process dies, launchd restarts it within 5 s. The proxies reconnect and re-register their watches.
- Only a revoked or missing login stops it, because that needs you: `tgmcp login`.

## Setup

Install a prebuilt binary. On macOS and Linux it goes into `~/.local/bin`, and on macOS the menu bar app goes into `~/Applications`. On Windows, `tgmcp.exe` and the tray app go into `%LOCALAPPDATA%\Programs\tgmcp`, which is added to your PATH:

```sh
curl --proto '=https' --tlsv1.2 -LsSf https://github.com/iddhi-sulakshana/telegram-mcp/releases/latest/download/tgmcp-installer.sh | sh
```

```powershell
powershell -ExecutionPolicy Bypass -c "irm https://github.com/iddhi-sulakshana/telegram-mcp/releases/latest/download/tgmcp-installer.ps1 | iex"
```

or run it from a checkout with [Bun](https://bun.sh): `bun install && bun link` puts `tgmcp` on your PATH (or use `bun run src/cli.ts …`). Then:

```sh
tgmcp install                     # launchd agent: starts the daemon now and at every login
tgmcp login                       # in a terminal: api_id/api_hash (if not saved yet), phone, code, 2FA
                                  # (tgmcp login --credentials to enter api_id/api_hash again)
tgmcp menubar                     # menu bar app (macOS) or tray app (Windows): approvals, listening sessions, recent sends, contacts (starts at login)
tgmcp mcp-add                     # prints the `claude mcp add` command for your paths
tgmcp status
```

`tgmcp install` (the launchd agent) is macOS-only. On Linux, run `tgmcp daemon` from a systemd user service (or any way that keeps it running). On Windows, keep `tgmcp daemon` running in a terminal. `tgmcp menubar` starts the menu bar app on macOS and the [tray app](#tray-app-windows) on Windows. Everything else works the same.

**Upgrading** a release: run the installer again, then `tgmcp install && tgmcp menubar` to restart both on the new version. Each new version is a new program to macOS, so it asks once more whether tgmcp and "Telegram MCP" may use the "telegram-mcp" Keychain item: choose **Always Allow**. **Moving from a checkout to a release**: `tgmcp install` points the launchd agent at whichever `tgmcp` runs it, so check `which tgmcp` (a `bun link` in `~/.bun/bin` may come first on your PATH), then run `tgmcp install`, `tgmcp menubar` and `tgmcp mcp-add` again. Your config, login and secrets stay where they are.

`tgmcp call <tool> '<json>'` runs any tool as a one-off session, e.g. `tgmcp call telegram_get_rules`. It runs the listed tools only: names starting with `__` are the MCP proxy's own calls (such as the dialog's answer) and are refused.

API credentials come from `TELEGRAM_API_ID` / `TELEGRAM_API_HASH` if set, otherwise the OS keystore (`tgmcp login` saves them there). Get them at https://my.telegram.org → API development tools.

## Secrets

Nothing secret is kept in a plain file. Three secrets go to the operating system's keystore through `Bun.secrets`, under the service `telegram-mcp`: the login Keychain on macOS, Credential Manager on Windows, and the Secret Service (GNOME Keyring, KWallet, via libsecret) on Linux.

| Secret | What it is |
| --- | --- |
| `session-key` | Encrypts the Telegram auth key inside `session.db` (AES-256-GCM) |
| `token` | Shared secret for the local API, so web pages and other users can't talk to the daemon. Clients send it in the `Authorization: Bearer` header, also on WebSocket upgrades; a token in the URL is refused |
| `credentials` | api_id / api_hash |

**Why the session key matters.** A Telegram auth key *is* your login: whoever copies it is you, with no code and no 2FA asked. `session.db` still holds the peer cache and update state, but its auth key rows are sealed with `session-key`. A copy of the folder alone (a backup, a synced dotfiles repo, a stolen disk image, or an infostealer that grabs `~/.config`) doesn't give anyone your account.

**What it doesn't stop.** Code that runs as you and asks the keystore can still get the secrets. On macOS the Keychain only hands them silently to the app that created them, which is the `bun` binary, so any script you run with `bun` could read them. On Linux and Windows any process in your session can. The keystore protects the secrets at rest. It doesn't sandbox your own account.

**Upgrading from an older version.** On its first start the daemon moves `token` and `credentials.json` into the keystore, checks they read back, and deletes the files. It seals the auth key in `session.db` and scrubs the old copy (secure delete, `VACUUM`, WAL truncated). The token value stays the same, so the Monitor URLs of running sessions keep working. Proxies and the menu bar app started before the upgrade still look for the file: run `/mcp` → reconnect in open Claude sessions and `tgmcp menubar` once. The unsealed key may still sit in older backups. To retire it, end the session in Telegram (Settings → Devices) and run `tgmcp login` again.

**The menu bar app** reads the token from the Keychain itself. The first time, and again after each rebuild (`tgmcp menubar`), macOS asks whether "TelegramMCPBar" may use the "telegram-mcp" item: choose **Always Allow**.

**No keystore?** On a machine without one (a headless Linux box, say), set `TELEGRAM_MCP_SECRET_STORE=file` for the daemon, the proxies and the CLI. The secrets then go to `token`, `credentials.json` and `session.key` in the home folder, mode 0600. There is no automatic fallback: if the keystore fails, the error says so instead of quietly writing files. `tgmcp status` shows where the secrets are and warns about leftover plain files.

## Files

All in `~/.config/telegram-mcp/` (folder mode 0700; override with `TELEGRAM_MCP_HOME`):

| File | What |
| --- | --- |
| `config.json` | The rules file (below). Edits apply as soon as you save. A broken edit keeps the last good version and shows up in `tgmcp status`. |
| `session.db` | mtcute's session: peer cache, update state, and the auth key sealed with `session-key` |
| `daemon.log` | The daemon log (`tgmcp logs`) |
| `recent.json` | The last 20 sent messages (shown in the menu bar) |
| `pauses.json` | Moderator pauses in force (see [Moderator commands](#moderator-commands)), so a restart doesn't lift one |
| `avatars/` | Small (160×160) profile photos for the menu bar and tray avatars, `<chat id>.jpg` (or `.none` when the chat has none) |
| `token`, `credentials.json`, `session.key` | Only with `TELEGRAM_MCP_SECRET_STORE=file` |

The daemon listens on `127.0.0.1:47823` (`TELEGRAM_MCP_PORT`).

Downloads go to `~/Downloads/telegram-mcp/<chat>/` (`TELEGRAM_MCP_DOWNLOADS`), named `<message id>-<file name>`.

## The rules file

```jsonc
{
  "guides": ["Free-text rules every session sees when it connects."],
  "footer": "\n\n✨ sᴇɴᴛ ᴠɪᴀ ᴄʟᴀᴜᴅᴇ",        // appended to every message, once (see Footer)
  "defaultPolicy": "approve",                // chats in no list: "approve" or "block"
  "rules": {
    "blocked":         [5550001111],         // never send
    "requireApproval": ["team-qa"],          // always ask you first ("Ask every time")
    "autoSend":        ["me", "@someone"],   // send without asking ("Always allow")
    "autoReply":       ["leo"]               // sessions may listen to these chats and reply without asking
  },
  "chats": {
    "leo": { "id": 123456789, "username": "leo_example", "name": "Leo Perera", "aliases": ["leonard"] },
    "team-qa": { "id": -1001234567890, "name": "Team QA", "topicId": 42 }
  }
}
```

**Lists** take a nickname, an `@username`, a numeric id, or `"me"`. If a chat is on more than one list, the safer list wins: blocked > requireApproval > autoSend > autoReply > defaultPolicy. `blocked` matches the raw id, so `5550001111` also blocks `-1005550001111`.

**/bots** from a moderator pauses Claude in a chat or everywhere; see [Moderator commands](#moderator-commands).

**chatCreation** lets sessions ask to create channels and supergroups; it is off by default. See [Creating chats](#creating-chats).

**/reply** hands one chat to the session that called `telegram_answer_reply`, for two hours or until `/reply stop`. Typing `/reply` in that chat counts as your approval, so the session's replies there go out without asking even when the chat is on `requireApproval`; `blocked` still refuses, and files still ask. Only a `/reply` you type on your phone or desktop counts: messages the daemon sent itself are ignored, and Claude cannot send a message that starts with `/reply`, formatted or not.

**autoReply** chats are the ones Claude sessions may listen to. A session subscribes with `telegram_watch` and stays subscribed until it says stop. Every incoming message from that chat goes to every subscribed session, and each one decides how to reply (the auto reply happens on the Claude side). While subscribed, a session's replies to that chat go out without approval, unless the chat is also on `requireApproval` or `blocked`.

**Files always ask**, in every chat that isn't blocked, even on `autoSend`, in a watched chat or under a `/reply` takeover. A file can be anything on this machine, and "send me that file" may come from someone in a chat the session reads, not from you. Only you can approve a file, in the menu bar or tray app or in Claude Code's approval dialog; `telegram_confirm_send` can't. Text messages still follow the lists, and `blocked` still refuses. Deleting a file a session sent always waits for approval too, even on `autoSend`, and it is approved like any other delete: in the menu bar or tray app, in Claude Code's dialog, or, with neither, by `telegram_confirm_send` after you say yes in chat. Taking a chat off the list stops delivery at once.

As a safety net, the send check also refuses common credential files (SSH keys, `.env` files, `.git-credentials`, cloud logins, `~/.claude`), a file with more than one hard link, and this tool's own files. That list can't name every secret on your machine: what protects you is the approval, so read the path on the card before you send.

**Your own protected folders.** Add folders whose files are never sent under `files.protectedDirs` in `config.json`, each absolute or starting with `~`:

```json
"files": { "protectedDirs": ["~/work/clients", "/srv/backups"] }
```

A file anywhere inside one is refused like a file in `~/.ssh`, before any approval and again when you approve: links are resolved first (a link to the folder, or to a file in it, counts), and on Windows and macOS the letter case doesn't matter. Only you set it, by editing `config.json`; no tool can change it, and the daemon picks up an edit at once. A relative path or one like `~bob/x` makes the config invalid, and the daemon keeps the last good one.

**First message to a new chat.** A chat that is on neither `autoSend` nor `requireApproval` always needs approval. The approval also asks what should happen next time:
- **Always allow** puts it on `autoSend`.
- **Ask every time** puts it on `requireApproval`.

Approving also saves the chat under `chats`, with a suggested nickname you can edit: the first name, else the username, else the full name. From then on the chat follows that list. Only you put chats on the lists, through an approval or the menu bar's [Contacts page](#contacts); sessions can't.

**Approval** happens in the first place available:
1. The **menu bar app**, when it's running. The draft appears there and as a notification. Both offer Approve / Deny, or Deny / Ask every time / Always allow for a new chat. The Claude tool call waits for your click: Claude Code backgrounds it after 2 minutes, and the result arrives when you decide.
2. A **Claude Code dialog** showing the exact recipient and text, plus the next-time choice and nickname for a new chat. Each draft has its own key, which the daemon gives only to the proxy of the session that asked; the dialog's answer must carry it, so another program holding the daemon's token (`tgmcp call`, a second bridge posing as that session) can't answer the dialog for you. The key never shows in tool results, `daemon.log` or `/ui/state`.
3. **In chat**: the tool returns an approval id. The model must ask you before it calls `telegram_confirm_send`. Here the model's word is the only check, so this path is narrower: it can't confirm a draft that is waiting in the menu bar app (even after Claude Code backgrounds the call), and a first message approved here always saves the chat as "ask every time". Only you can make a chat "always allow", in the menu bar's Contacts page, an approval there, the dialog, or `config.json`.

Nothing is sent unless you accept. Drafts expire after 20 minutes. The rules are checked again at send time.

**Edits and deletes ask too.** `telegram_edit_message` and `telegram_delete_message` change what a chat already sees, so they follow the same rules as a send: where sending is automatic they happen at once, blocked chats refuse them, and where sending needs approval they wait for you in the same places. The menu bar or tray card and its notification show the chat, the message number and its text now, then the new text for an edit (**Deny** / **Edit**) or the message that would go for everyone for a delete (**Keep** / **Delete**). The dialog shows the same, and in chat the model gets an approval id for `telegram_confirm_send` / `telegram_cancel_send`. Approving one never puts a chat on a list. Deny or no answer within 20 minutes leaves the message as it was, the rules are checked again when you approve, and `daemon.log` has a line for the ask and for what came of it.

**Nicknames** (`chats`) let "send to leo" mean exactly one person. Only exact matches resolve: a nickname, an alias, a saved full name, a username or an id. A near match like "leon" is refused with suggestions, never picked. Before every send the daemon checks that the saved id still has the saved username. If either has changed, it refuses until the entry is re-saved. Sessions can add, update and remove nicknames (`telegram_save_chat`, `telegram_remove_chat`). They cannot change `rules`, `footer` or `guides`, and they cannot repoint, create or remove a name that the rules use: only you can, by editing the file or renaming it on the [Contacts page](#contacts).

## Tools

| Tool | |
| --- | --- |
| `telegram_status` | connection, account, config errors, this session's watches |
| `telegram_get_rules` | guides, footer, lists, saved nicknames |
| `telegram_list_chats` | recent chats with unread counts and what sending there would do; filter by kind (`type`: private, groups, channels, bots), sort by `recent` / `unread` / `name`, and `categorize` under a heading per kind |
| `telegram_search_chats` | find a person or group to save |
| `telegram_read_messages` | read a chat or forum topic |
| `telegram_send_message` | send, following the rules |
| `telegram_delete_message` | delete a message this session sent recently, for everyone in the chat; same limits as edit (its own messages only; at once where sending needs no approval, after your approval where it does, refused where blocked), logged, can't be undone |
| `telegram_edit_message` | change the text of a text message this session sent recently (chat and message id). The chat sees the new text, so it follows the sending rules: at once where sending needs no approval, after your approval where it does (you see the old and the new text), refused where blocked. Never another session's message, yours (the Page button's included), the pager's or an away reply. The footer is added again, Recently sent shows it as edited and keeps the original, and `daemon.log` has a line for each edit |
| `telegram_send_file` | send a local file with a caption; it always waits for your approval (see files, above) and blocked chats refuse it. As a safety net, common credential files (SSH keys, `.env` files, `.git-credentials`, cloud logins, `~/.claude` and `~/.claude.json`), hard-linked files and this tool's own files are refused too; the list isn't complete, so your approval is what protects you |
| `telegram_send_sticker` | re-send a sticker someone posted (by chat and message id), following the same rules; stickers take no caption, so no footer |
| `telegram_page` | page the user for something that needs a human now: the desktop rings until they ack, and the phone gets a push (see [Pages](#pages)) |
| `telegram_list_topics` | list a forum group's topics (id and title), to find the one named after a project before watching it |
| `telegram_create_topic` | create a forum topic in a group with topics on (needs the manage-topics right) and return its id for `topicId`; follows the sending rules but has no approval step, so it works only where sending is automatic and is refused elsewhere |
| `telegram_create_chat` | create a broadcast channel or supergroup on your account, optionally public (`username`) and, for a channel, with a discussion group (a new one or an existing supergroup). Off by default (`chatCreation.enabled`), and every create waits for you in the menu bar or tray app, never in chat (see [Creating chats](#creating-chats)) |
| `telegram_answer_reply` | make this session answer `/reply`: type `/reply` (or `/reply <what to say>`) in any chat from your own account and that chat is handed to the session; `/reply stop` takes it back |
| `telegram_message_readers` | whether one of your own messages has been read: in a private chat whether the other person did, in a group of up to 100 people who did and when (about a week); only what Telegram shows, read-only |
| `telegram_download_media` | save a message's file, photo, video or voice note and return the path |
| `telegram_confirm_send` / `telegram_cancel_send` | approval fallback for clients without dialogs (sends, edits and deletes) |
| `telegram_save_chat` / `telegram_remove_chat` | manage nicknames |
| `telegram_watch` / `telegram_unwatch` | subscribe to an autoReply chat (optionally one sender, one topic) |
| `telegram_get_events` | collect watched messages nobody pushed yet |
| `telegram_mark_read` | mark a chat read |

## Watching ("tell me when Leo replies")

`telegram_watch` subscribes the session to a chat on the autoReply list until it calls `telegram_unwatch` or ends. Each new incoming message reaches every subscribed session once, by the first of these that is available to that session:

1. **Monitor** (the default): `telegram_watch` returns a `ws://127.0.0.1…/events?session=…&key=…` URL, and Claude opens its Monitor tool on it. The key opens that one session's stream and nothing else, so the URL (which Claude Code keeps in its transcripts) never carries the token. Each message becomes a notification in the session: a one-line header such as `Telegram message from Anna (@anna, id 123) in Team QA [qa] · chat_id … · message_id … · topic … · reply to … · watch …`, then the text with every line quoted (`> `). The sender's numeric id is always there, so two people with the same display name, or one named like someone else, can still be told apart. Names lose their own brackets (`( )`, `[ ]` and look-alikes become spaces), so the only `(…id N)` on the line is the real one: a sender named `Leo (@leo, id 1188107983)` shows as `Leo @leo, id 1188107983 (id 555)`. A Monitor stops after 30 minutes, or when the daemon restarts. Claude is told to restart it straight away with the same URL whenever it ends while watches are active (`telegram_status` shows the URL again). Nothing is lost in between, because messages queue up and are flushed when the Monitor reconnects.
2. **Channel push** (optional: `tgmcp mcp --channel`, plus `claude --dangerously-load-development-channels server:<name>`): messages appear in the session by themselves as `<channel>` events, with no Monitor needed. This uses Claude Code's channels research preview.
3. **Queue**: `telegram_get_events` drains it. Every other tool result also mentions when messages are waiting.

A session's watches outlive a daemon restart, because the proxy re-sends them. They also outlive a proxy blip for 5 minutes. They end when the Claude session ends.

## Pages

A page is for something that needs you now: production down, a blocker someone is waiting on, "call me". The menu bar app (macOS) or the tray app (Windows) plays a looping alarm and opens a window above everything, and it keeps ringing until you press **Ack** or **Snooze** (15 minutes or an hour). With a pager bot, your phone gets the page as a push too, with the same buttons. An Ack anywhere stops it everywhere.

Only the daemon decides what pages, from the `paging` section of the rules file:

```jsonc
"paging": {
  "pageFrom": [5550001111],          // numeric user ids whose "/page <reason>" pages you (a username can change hands)
  "vip": ["team-qa"],                // chats where a keyword alone pages you
  "keywords": ["urgent", "down", "prod", "asap"],
  "retryMinutes": 5, "tries": 3,     // phone retries while nobody acks
  "perSenderMinutes": 10             // at most one page per sender in this window
}
```

- **`/page <reason>`** from someone on `pageFrom` pages you. Anyone else's `/page` is ignored, and so is your own.
- **A keyword** (as a whole word) pages you only in a `vip` chat. Elsewhere, "urgent" pages no one.
- **Claude** can page you with `telegram_page`, under the same rate limit.

On the [Contacts page](#contacts), **Can page me** puts a person on `pageFrom` (by their user id) or takes them off, and **Page** sends them `/page <reason>` from your account. It rings them if you're on *their* `pageFrom`, and you get their daemon's replies in that chat.

**Your own alarm sound.** Put `alarm.mp3` (or `.m4a`, `.wav`, `.aiff`, `.caf`) in the home folder and the menu bar app plays it instead of the built-in beep. The tray app plays `alarm.wav` (its sound player takes WAV only). Both look for the file on each new page, so no restart is needed, and both fall back to the beep if the file is missing or unreadable. To make a WAV from an MP3: `ffmpeg -i alarm.mp3 alarm.wav`.

The sender gets fixed replies, never text Claude wrote and never their own reason echoed back: "Paging Leo now. I'll tell you when they've seen it.", "Leo saw it.", and, if nobody acks after the last try on the phone, "Leo hasn't seen it yet. Try calling." The desktop keeps ringing after that. A page only ever notifies you; its reason is shown as text and nothing in it is acted on. Every page, retry, ack and snooze is written to `pages.jsonl` in the home folder (without the reason). Pages live in the daemon's memory, so a restart drops the ones still ringing.

**The phone.** Messages from your own account don't buzz your phone, so pages reach it through a bot of your own:

1. Make one with [@BotFather](https://t.me/BotFather) (`/newbot`), then run `tgmcp page setup` and paste its token. It goes to the keystore.
2. Open the bot, press **Start**, and keep that chat unmuted, or the phone won't buzz.
3. `tgmcp restart`, then `tgmcp page test` to hear the alarm, check the volume and try Ack.

The bot only messages the account you're logged in as, and ignores button presses from anyone else.

## Moderator commands

When several people's Claude sessions auto-reply in the same group, they can end up answering each other non-stop. Moderator commands let a moderator stop that in one message. **They are off by default**: nobody else's command steers your account until you turn them on with `tgmcp bots on` (or `"enabled": true`). Once on, the moderators are Leo (user id `1188107983`) and Iddhi (`1269534379`) unless you list others. All of this is in the `moderation` section of `config.json`:

```jsonc
"moderation": {
  "enabled": false,                         // true (or `tgmcp bots on`) to obey; while false, /bots from anyone is just a message
  "moderators": [1188107983, 1269534379],   // numeric user ids, never usernames or names
  "defaultMinutes": 60,                     // how long "/bots stop" lasts if they don't say
  "maxMinutes": 1440                        // the longest a stop can last
}
```

A moderator types one of these in a chat, and the message must be exactly that (any letter case):

| Command | What happens on your account |
| --- | --- |
| `/bots stop` · `/bots stop 30m` · `/bots stop 2h` | Claude is paused **in that chat** for an hour, or the time given |
| `/bots stop all` · `/bots stop all 2h` | Claude is paused **in every chat** |
| `/bots resume` · `/bots resume all` | The pause in that chat, or every pause, is lifted |

Anything else, like `/bots stop now`, `/bots@x stop`, a forwarded command, or a command written as a photo or file caption, is an ordinary message. Only the moderator's numeric user id counts, so someone with the same name or a look-alike username can't pause you. **A moderator's own account never obeys moderator commands**, from themselves or another moderator.

**While a chat is paused**, the daemon enforces it, whatever a session tries:
- `telegram_send_message`, `telegram_send_file` and `telegram_send_sticker` to it are refused, and so are edits and new topics. Drafts waiting for approval are refused even if you approve them. A session can still delete its own messages there.
- Its messages don't reach watching sessions, `telegram_watch` on it is refused, a `/reply` takeover there ends, and a new `/reply` there isn't handed over.
- No away reply goes there.
- Your own Saved Messages are never paused. Neither are you: anything you type yourself goes out as usual, and so does the pager.

The moderator's text never reaches a Claude session as an instruction. The daemon recognises a fixed set of commands and does the pausing itself.

**What you see**: a note in your Saved Messages saying who paused what and until when, and how to undo it. One line in the chat (for example "🤖 Claude on this account is paused here for 1h, by a moderator."), only where sending needs no approval: an Always allow chat, or an auto-reply chat one of your sessions is watching. A line in `daemon.log`. Each watching session is told to stop replying. `tgmcp bots`, `telegram_status` and `telegram_get_rules` show the pauses. A pause ends on time even if the command arrived late, and a restart doesn't lift it.

**You can always override it** on your own account:

```sh
tgmcp bots                  # on or off, the moderators, and what's paused now
tgmcp bots resume           # lift every pause now (or: tgmcp bots resume <chat id>)
tgmcp bots on | off         # obey moderator commands, or ignore them again (pauses in force stop applying too)
```

Typing `/bots resume` (or `/bots resume all`) yourself in a chat also lifts the pause on your account. Claude can't send or edit in a message that starts with `/bots`, so a moderator's own session can't be talked into posting one.

## Creating chats

`telegram_create_chat` creates a broadcast channel or a supergroup on your account. **It is off by default.** Turn it on in `config.json` (it applies as soon as you save):

```jsonc
"chatCreation": {
  "enabled": false   // true lets sessions ask to create channels and supergroups; each one still waits for you
}
```

- **You approve every create, in the menu bar or tray app.** The card and its notification show the type, the name, the description, the public link if there is one, and the discussion group, with **Deny** / **Create**. It can't be approved in the Claude Code dialog or in chat (`telegram_confirm_send` refuses it), and it is refused while the app isn't running. A menu bar or tray app older than this feature never sees the request (it would show it as a message to send), so update the app before you turn this on. A session can have at most 3 requests waiting. A session can drop its own request with `telegram_cancel_send`. Requests expire after 20 minutes like drafts.
- **Public or private.** With `username` (5 to 32 letters, digits and underscores, starting with a letter) the chat gets `t.me/<username>`. If Telegram refuses the name (taken, or not allowed), the chat is still created, as private, and the result says why.
- **Discussion group** (channels only): `{ "kind": "new" }` creates a supergroup called "<title> Chat" (or `title`) and links it; `{ "kind": "existing", "chat": "<nickname or id>" }` links a supergroup you administer. A blocked chat is never linked (with `defaultPolicy: "block"` that includes every group on none of your lists), and neither is a group a moderator paused; both are checked again when you approve. A basic group is refused: Telegram links only supergroups. If linking fails, the channel stays and the result says what happened.
- **Nothing else changes.** The new chat is put on no list and saved under no nickname, so sending there follows `defaultPolicy` until you decide. Nothing is deleted or rolled back.
- It is checked again when you approve: turned off meanwhile, or a moderator's `/bots stop all`, refuses it. `daemon.log` has a line for the ask and for what came of it, and `telegram_status` says whether it is on.

## Away auto-reply

When you're away from the keyboard, people who write to you in a private chat get a reply saying so. It's **off by default**. It runs on **schedules**, each with its own hours, days, dates, wait and message. Out of the box there are two:

| Schedule | Hours | Waits | Replies |
| --- | --- | --- | --- |
| **Daytime** | 08:00 to 21:00, every day | 30 seconds, then again after an hour if they write again | Hi! Thanks for contacting me 🙏 I'm unavailable right now and will reply as soon as I'm back at my seat. |
| **Night** | 21:00 to 08:00, every day | replies at once, once a night | Hi! Thanks for your message. I'm unavailable for the rest of the day and will get back to you when I'm back at work tomorrow 🌙 |

Hours are in the laptop's local time; the start is included and the end is not, and a window that ends before it starts runs past midnight. `{name}` in a message becomes your first name, and the [footer](#footer) is added as with any message. The reply goes out plain (not as a reply to their message) and **without approval**.

**The wait lets you answer first.** A schedule with a wait holds the reply for that long (up to 10 minutes). If you come back in the meantime, nothing is sent. Coming back means reading a chat or sending a message yourself, on any device (phone, desktop or web). Claude's messages, the Page button's and the away reply's own don't count. `daemon.log` says "you're back, no away reply to …" when one is dropped.

**Each schedule** has:

- **Hours** (from, until), and **days** of the week (all, weekdays, weekends, or any you pick).
- **Dates** (optional): only from one date, until another, or between the two, e.g. a holiday. Outside them the schedule does nothing.
- **Wait**: 0 (reply at once) to 600 seconds.
- **Repeat**: 0 means once per chat per window; a number of minutes means again after that long (30 at the least), if they write again.
- **Message**: at most 1000 characters.

Up to 12 schedules. When two cover the same moment, the more specific one replies: one with dates beats one without, then the shorter window wins. So a "Lunch break" 13:00–14:00 schedule takes over from Daytime for that hour, and a "Time off" schedule with dates covers whole days.

The rules, so it never gets in the way:

- Only private chats with people: not groups, bots, Saved Messages, or Telegram's service and support accounts.
- Never a chat on `away.skip`: people you never want an away reply to go to, such as a manager. Their other rules (sending, watching, auto-reply) stay as they are. Switch them off under **Who gets away replies** on the tray's Away tab, or list them (nickname, @username or id) in `config.json`.
- Never a **Blocked** chat, nor a chat that isn't saved when `defaultPolicy` is `"block"`. **Ask every time** chats do get it: the reply is your own fixed text, so there is nothing to approve.
- Once per chat per window (or per the schedule's repeat), and never twice to the same chat within 30 minutes, even across schedules (no Daytime reply at 20:59 and Night's at 21:01). At most 20 replies in any hour and 30 in one window in all, so a wave of messages doesn't look like spam from your account. A restart doesn't reset any of these.
- Only while it's still the same away window: a message from 07:58 that the laptop picks up at 08:05 gets nothing, and one from 20:58 picked up at 21:01 gets neither reply.
- Not for 30 minutes after anything was sent from your account in that chat, whether you typed it or Claude sent it (`quietMinutes`; 0 turns this off). The Page button's message and the away reply itself don't count.
- Not while a Claude session is handling the chat (watching it, or after `/reply`).
- Not to someone who is paging you, or whose page is still waiting.
- Only for messages less than 10 minutes old (plus the wait), so catching up after the laptop sleeps doesn't send night-time replies in the morning. A wait that ends late because the laptop slept through it sends nothing either.

Set it up on the **Away** tab of the tray app (Windows), with `tgmcp away`, or in `config.json`. The menu bar app's Away page (macOS) shows and changes one schedule: the one that would reply now, else the first switched on. `hours` and `message` change that one too, unless you name another.

```
tgmcp away                          # every schedule, and what's replying now
tgmcp away on | off
tgmcp away quiet 60
tgmcp away night hours 21:30 07:30  # a schedule's hours, by name or id
tgmcp away night message "Gone to bed, back tomorrow 🌙"
tgmcp away message "Back soon."     # without a name: the schedule replying now
```

```jsonc
"away": {
  "enabled": true,
  "quietMinutes": 30,
  "skip": ["pahan", "@someone", 491741918],   // never get an away reply
  "schedules": [
    { "id": "day", "name": "Daytime", "enabled": true, "from": "08:00", "until": "21:00",
      "days": [0, 1, 2, 3, 4, 5, 6], "delaySeconds": 30, "repeatMinutes": 60, "message": "…" },
    { "id": "night", "name": "Night", "enabled": true, "from": "21:00", "until": "08:00",
      "days": [0, 1, 2, 3, 4, 5, 6], "delaySeconds": 0, "repeatMinutes": 0, "message": "…" },
    { "id": "trip", "name": "Time off", "enabled": true, "from": "00:00", "until": "00:00",
      "startDate": "2026-12-24", "endDate": "2026-12-31", "delaySeconds": 0, "repeatMinutes": 0, "message": "…" }
  ]
}
```

`days` is 0 (Sunday) to 6 (Saturday); from and until equal means all day. A file from an earlier build (`enabled`, `from`, `until`, `message` at the top of `away`, any of them) still works: it's read as one schedule with that build's defaults for what's missing (18:00 to 09:00), so upgrading never starts replying all day. Only a file with no `away` gets Daytime and Night.

An away reply shows under Recently sent as "away reply", and `daemon.log` names the schedule. No MCP tool can change these settings, so sessions can't turn it on or rewrite the message; only you can, through the file, the CLI, the menu bar app or the tray (`POST /ui/away` with the token).

## Footer

The footer goes under everything sent from your account for you: Claude's messages, away replies and the pager's fixed replies (not what you type yourself, and not stickers or `/page`). It's `"\n\n✨ sᴇɴᴛ ᴠɪᴀ ᴄʟᴀᴜᴅᴇ"` unless you change it. Make it anything you like, up to 300 characters, emoji and line breaks included (not control characters, text direction marks, or nothing but invisible characters), or switch it off: off keeps its text (`savedFooter`) for when you switch it back on. In a markdown or html message it's escaped, so it always reads as typed. A file's caption with the footer has to fit Telegram's 1024 characters, or the send is refused before anything goes. A session editing a message after the footer changed gets the new footer instead of the old one.

```
tgmcp footer                        # show it, and whether it's on
tgmcp footer on | off
tgmcp footer "— sent by my assistant"   # new text; a blank line goes above it
```

The tray's **Footer** tab edits it with a live preview, ready-made ideas, letter styles that look the same in every Telegram app (𝗯𝗼𝗹𝗱, 𝘪𝘵𝘢𝘭𝘪𝘤, 𝚖𝚘𝚗𝚘, sᴍᴀʟʟ ᴄᴀᴘs) and the space above it (a blank line, a new line or the same line). Sessions can't change it.

## Menu bar app

`tgmcp menubar` builds `menubar/build/Telegram MCP.app` (SwiftUI, no Dock icon) and starts it at login. Choosing Quit keeps it closed until your next login. The panel has the tray app's look (smoked glass with frosted cards, following light or dark mode, [Lucide](https://lucide.dev) icons) and three tabs:

- The header shows the connection as a status pill (green connected, yellow reconnecting, red logged out, grey offline) with the whole of your name, on two lines if it needs them, plus **Rules** and **Log** buttons.
- **Home** has three tiles, **Waiting**, **Listening** and **Sent**. Each shows a count and a word ("needs you", "2 sessions", "1 paused"), and the one you click is the section shown below them, so the panel stays short. A new draft switches back to Waiting.
  - **Waiting for approval**: the exact text, recipient, "Asked by …" and the reason on separate lines, and when it was asked ("just now", "5m ago"), with Deny / **Send**. A new chat says it's the first message, gets an editable nickname, and offers **Send, ask next time** / **Send, always allow** instead. An edit shows the message's text **Now** and what it **Will say**, with Deny / **Edit**; a delete shows the message that would go, with Keep / **Delete**.
  - **Listening now**: each session watching chats, whether its Monitor is connected, and a **switch on each chat** to pause or resume listening there. A session watching several saved chats also gets an **all** switch. A switch is the chat's auto-reply: off, the daemon stops passing that chat's messages to every session at once (the watches stay, so switching it back on resumes them). Under it, **Chats Claude may listen to** lists your saved chats, each with its switch, so you can choose who Claude may watch without opening Contacts.
  - **Recently sent**: the last 5 chats you sent to. Click a chat to see its messages, when they went, how they were approved, and from which session; click again to close it.
- **Contacts**: every saved chat, to change its rules without editing `config.json`. See [Contacts](#contacts).
- **Away**: the [away auto-reply](#away-auto-reply). The switch saves at once; the hours and message of the schedule shown (the one replying now, else the first switched on) and the quiet minutes save with **Save** (⌘S), with a preview of the reply. It says whether it's away now and until when. While it is, the tab shows a green dot and Home shows a line saying so.

Avatars show each chat's Telegram profile photo, with initials (or a glyph for groups, channels and bots) until it loads and when there's none. See [Avatars](#avatars).

Results flash under the header: a green check when it worked, a red warning when it didn't (VoiceOver reads them out). Esc clears a search, then closes the panel; ⌘1 to ⌘3 switch tabs and ⌘F searches contacts.

<p>
  <img src="docs/menubar-approvals.png" width="370" alt="The menu bar panel's Home tab: the status pill, the Home, Contacts and Away tabs, the Waiting, Listening and Sent tiles, and two drafts waiting for approval (one to a saved group with Deny and Send, one to a new chat with Send, ask next time and Send, always allow)">
  <img src="docs/menubar-history.png" width="370" alt="Home with the Sent tile picked: recently sent, expanded, each chat listing the messages sent there, when, how they were approved and from which session">
</p>

Each new draft also posts a notification, so you can decide without opening the panel. Its **Options** menu has the same choices as the panel: **Send** / **Deny** for a chat that is already on a list, and **Send, ask next time** / **Send, always allow** / **Deny** for the first message to a new chat.

<img src="docs/notification-options.png" width="384" alt="Two draft notifications; the Options menu of a first message to a new chat shows Approve, ask next time; Approve, always allow; and Deny">

A long draft shows its first 4 lines: click it (or **Show all**) to see all of it. Nothing in the panel opens on hover. The panel never runs past the bottom of the screen: when a long draft (or many of them) would, the middle scrolls and the header and footer stay put.

The menu bar icon is the app's paper plane in the same colours as the status pill (blue when connected), with a green dot while a session listens and a badge: the number of drafts waiting on amber, or "!" when the daemon or Telegram is down. `tgmcp menubar uninstall` removes it.

### Contacts

**Contacts** lists every saved chat (`chats` in the rules file) with tags for how it's set up. Search by nickname, name, @username or id, and filter to **All**, **Listening** (Claude may listen) or **Not listening**. In the menu bar app each row has a **Listen** switch, which is the chat's auto-reply (below), so you can choose who Claude may listen to without opening the chat. Click a chat to change the rest. An open chat says what happens there in plain words first:

- **Nickname**: type a new one and press Rename. Rules that used the old name are rewritten to the new one, so the chat keeps its lists. A name that already means another chat is refused, and so is a name the rules mention that matches no chat yet (taking it would quietly put this chat on those lists). One of the chat's own aliases can become its nickname.
- **When Claude sends a message here**: **Always allow** (`autoSend`), **Ask every time** (`requireApproval`) or **Blocked** (`blocked`). The chat ends up on exactly that list: every other entry that means the same chat is taken out of the other two, whether it's a nickname, an alias, an id, an @username or `"me"`. A chat on none of them shows as *not set*.
- **Auto-reply** (the **Listen** switch in the menu bar app): **On** puts it on `autoReply`, so sessions may watch it and reply without asking. **Off** takes out every entry that means the chat, and sessions watching it stop getting its messages at once. The text under the buttons says when the sending rule overrides this (Ask every time still asks; Blocked still refuses).
- **Can page me** (people only, not groups, bots or yourself): **On** puts their user id on `paging.pageFrom`, so their `/page <reason>` rings you (see [Pages](#pages)). **Off** takes it out. The row gets a *can page me* tag.
- **Page *nickname***: type a reason (or none) and press **Page** or Return. The daemon sends `/page <reason>` to that person from your account, as one line of at most 200 characters and without the footer, since everything after `/page` is their reason. It shows under Recently sent. A chat whose sending rule blocks it (Blocked, or on no list with `defaultPolicy: "block"`) is refused.

Each click saves to `config.json` at once, the same way an approval does: the file is read fresh first, so a hand edit made a moment ago is kept, and a broken file is reported, never overwritten. A click that changes nothing writes nothing. Each change is noted in `daemon.log`. Rules are per chat, so if two nicknames point to the same chat, changing one changes both; the details line under the buttons names the other.

<img src="docs/menubar-contacts.png" width="370" alt="The Contacts tab: search, the All, Listening and Not listening filter, four saved chats with their tags and Listen switches, and Team QA opened with its explanation, the sending choices (Ask every time selected) and its nickname">

This page is the menu bar's own: it goes through the daemon's local API with the token (`POST /ui/contacts` and `POST /ui/contacts/page`, like approvals). No MCP tool offers the same, so sessions still can't change the rules through the server.

### Avatars

In both apps the avatars on Home's cards, in Contacts and on a page's alarm window show the chat's real Telegram profile photo. The daemon fetches the small (160×160) photo the first time an app asks for it (`GET /ui/avatars/<chat id>`, with the token, like `/ui/state`), keeps it in `avatars/` in the home folder, and fetches it again at most once a day. Each app asks once per chat when the avatar first shows and again every 6 hours, never on each poll. Only chats the panel shows (saved chats, drafts, watched chats, recent sends and pages) are fetched. A chat with no photo, or one that hides it from you, keeps its initials, and so does every avatar while Telegram can't be reached. The demo daemon and the screenshots use made-up gradient pictures, never real photos.

## Tray app (Windows)

On Windows, `tgmcp menubar` starts the tray app and sets it to start at login. Settings → Apps → Startup lists it as "Telegram MCP".

- **From a release**, it uses the prebuilt `TelegramMCPTray.exe` that the installer put next to `tgmcp.exe`. It's self-contained, so it needs no .NET. Set `TELEGRAM_MCP_TRAY_APP` to use one somewhere else.
- **From a checkout**, it first builds `tray/build/TelegramMCPTray.exe` (C#/WPF), which needs the [.NET SDK 10](https://dotnet.microsoft.com/download).

It is the menu bar app's counterpart:

- **The tray icon** is the paper plane from `docs/icon.svg`, coloured by status: blue when connected, yellow while it reconnects, red when logged out, grey when the daemon can't be reached. A green dot means a session is listening. The amber badge is the number of drafts waiting for you, and `!` means something is wrong. Hover it for a summary.
- **Click it for the panel**, a frosted-glass flyout (acrylic on Windows 11, following light or dark mode) with four tabs. **Home** shows the connection as a status pill and four tiles, two by two: **Waiting**, **Listening**, **Sent** and **Auto-reply**. The tile you click picks the one section shown below them, and a new draft switches back to Waiting:
  - **Waiting for approval**: who asked and why, with Send / Deny. A new chat says it's the first message, gets a nickname box, and offers Deny / **Send, ask next time** / **Send, always allow**.
  - **Listening now**: each session and the chats it watches, each chat with a **switch** to pause or resume listening there, plus an **all** switch for a session watching several saved chats. A switch is the chat's auto-reply. Off, the daemon stops passing that chat's messages to every session at once; the watches stay, so on resumes them.
  - **Auto-reply**: both kinds in one place. The **away auto-reply** with its switch (on or off at once; **Schedules and messages** opens the Away tab), then **Auto-reply in chats**: your saved chats, each with its auto-reply switch, so you can choose who Claude may watch and answer without opening Contacts. The tile counts the chats with auto-reply on, and its chip says whether the away reply is off, on or replying now.
  - **Recently sent**: click a chat to see its messages.

  Each empty card says what would show up there. As in the menu bar app, a long draft and a recent chat open on click, never on hover. Results flash under the header: a green check when it worked, red when it didn't. Esc clears a search, then closes the panel; Ctrl+1 to Ctrl+4 switch tabs, Ctrl+F searches contacts, and Tab reaches every button, with a focus ring.
- **Contacts** (the second tab) is the same page as the menu bar's (see [Contacts](#contacts) above): rename a saved chat, choose what happens when Claude sends there, turn its **Auto-reply** on or off, choose who can page you, and page someone. Each row also has an **Auto-reply** switch, and a filter shows **All**, **Auto-reply on** or **Auto-reply off** chats.
- **Away** (the third tab) is the [away auto-reply](#away-auto-reply). The top card has the master switch, what's replying now and until when, how many replies are waiting out their wait, and a timeline of today with each schedule's hours and a line at now. Under it, each **schedule** is a card you can switch on or off (at once) and click to edit: name, from and until (time pickers in quarter hours), days (with Every day / Weekdays / Weekends), optional start and end dates (a calendar picker), the wait and repeat, and the message with a preview as people will get it. **Save** saves that schedule, **Discard** puts it back, **Delete** asks once more. **Add** starts a new one, blank or from a template (Lunch break, Weekend, Time off). The quiet minutes are under **How away replies work**. While replies can go out, the tab shows a green dot and Home says until when. Ctrl+3 opens it.
- **Footer** (the fourth tab) is the [footer](#footer): switch it on or off (at once, keeping the text), change the words with a counter, start from an idea, pick a letter style and the space above it, and see a message as people will get it. **Save** saves, **Discard** puts it back, **Reset** goes back to the default. Ctrl+4 opens it.
- **A Windows notification** for each draft has the same choices as buttons. Click the notification itself to open the panel.

Right-click the icon for Open, Contacts, Rules, Log and Quit. Quit keeps it closed until your next login. `tgmcp menubar uninstall` quits it and stops it starting at login.

The icons in the panel are [Lucide](https://lucide.dev) (ISC license), drawn from `tray/App/Icons.xaml`.

It reads the daemon's token from Windows Credential Manager (the `telegram-mcp/token` entry the daemon keeps there), or from the `token` file with `TELEGRAM_MCP_SECRET_STORE=file`. It talks only to 127.0.0.1. Problems it can't show in the panel go to `%LOCALAPPDATA%\TelegramMCPTray\tray.log`.

Nothing supervises the daemon on Windows yet (`tgmcp install` is launchd-only), so keep `tgmcp daemon` running in a terminal. For the same reason the panel has no Restart button.

## Development

```sh
bun test          # unit tests + an end-to-end test that spawns the real proxy against a daemon with a fake Telegram
bun run typecheck
bun scripts/demo-daemon.ts      # daemon with a fake Telegram and sample state, for working on the menu bar app
dotnet run --project tray/Tests # the tray app's logic, and its client against a demo daemon (.NET SDK 10; runs on any OS)
```

The screenshots above come from the demo daemon, rendered offscreen by the app itself:

```sh
APP="menubar/build/Telegram MCP.app/Contents/MacOS/TelegramMCPBar"
export TELEGRAM_MCP_HOME=/tmp/tgmcp-demo TELEGRAM_MCP_PORT=47901 TELEGRAM_MCP_SECRET_STORE=file SNAPSHOT_DARK=1
"$APP" --snapshot docs/menubar-approvals.png
SNAPSHOT_SECTION=sent SNAPSHOT_EXPAND=recent SNAPSHOT_SCREEN_HEIGHT=4000 "$APP" --snapshot docs/menubar-history.png   # SNAPSHOT_EXPAND: 1, approvals or recent
SNAPSHOT_PAGE=contacts SNAPSHOT_OPEN=team-qa "$APP" --snapshot docs/menubar-contacts.png    # SNAPSHOT_OPEN: a nickname to open
SNAPSHOT_PAGE=away "$APP" --snapshot /tmp/menubar-away.png
SNAPSHOT_SECTION=listening "$APP" --snapshot /tmp/menubar-listening.png                      # SNAPSHOT_SECTION: listening or sent (Home)
"$APP" --icons /tmp/menubar-icons.png                                                        # every menu bar icon state
```

### Releasing

Releases are built by [`.github/workflows/release.yml`](.github/workflows/release.yml), like key-vault-for-llm's:

1. Set the new version in `package.json` and add a `## <version>` section at the top of [CHANGELOG.md](CHANGELOG.md). It becomes the release's "What's new".
2. Merge that to `main`, then tag it and push the tag:
   ```sh
   git tag v1.2.3 && git push origin v1.2.3
   ```

The workflow runs the tests and `bun scripts/release.ts`. That builds `tgmcp` for Apple Silicon and Intel macOS, x64 and ARM64 Linux, and x64 Windows (`bun build --compile`, so no Bun is needed to run it), plus a universal menu bar app for the macOS archives. It writes a SHA-256 checksum for every file, and the two installers with the version filled in. Each build is then installed with its own installer on its own platform, and the daemon is started there. Only if all of that passes is the GitHub release published. A tag that doesn't match `package.json`, or a version without a CHANGELOG section, stops the build. A tag with a suffix (`v1.3.0-rc.1`) is published as a prerelease. Pull requests that touch these files run the same build and install checks without publishing.

To build locally (the cross-compile downloads Bun for each platform into Bun's install cache):

```sh
bun scripts/release.ts --out /tmp/tgmcp-dist                                # every platform
bun scripts/release.ts --out /tmp/tgmcp-dist --targets aarch64-apple-darwin  # just one
```

## License

MIT. See [LICENSE](LICENSE).
