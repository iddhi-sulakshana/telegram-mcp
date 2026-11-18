// Menu bar companion for the telegram-mcp daemon.
// Three tabs, like the Windows tray app. Home: tiles for Waiting, Listening and Sent pick the section
// below them: drafts to send or deny; which Claude sessions listen to which chats, with a switch to
// pause or resume each chat (or all of a session's) and a list of the chats Claude may listen to; and
// the chats you last sent to (click one to see what was sent). Contacts: every saved chat with its
// Listen switch on the row, a filter, and its sending rule, paging and nickname in config.json.
// Away: the away auto-reply, on or off, its hours, quiet minutes and message.
// Talks only to the local daemon on 127.0.0.1, authenticated with the token the daemon keeps in
// the login Keychain (service "telegram-mcp"; a file instead with TELEGRAM_MCP_SECRET_STORE=file).

import AppKit
import AVFoundation
import Security
import SwiftUI
import UserNotifications

// MARK: - What the daemon sends (GET /ui/state)

struct TelegramState: Decodable {
    let phase: String
    let me: Peer?
    let lastError: String?
    let reconnects: Int
}

struct Peer: Decodable {
    let id: Int
    let name: String
    let username: String?
}

struct WatchSpec: Decodable, Identifiable {
    let id: String
    let chatId: Int
    let chatLabel: String
    let fromLabel: String?
    let topicId: Int?
    let note: String?
}

struct UiSession: Decodable, Identifiable {
    let id: String
    let label: String
    let connected: Bool
    let channel: Bool
    let monitors: Int
    let pending: Int
    let watches: [WatchSpec]
}

struct UiApproval: Decodable, Identifiable {
    let id: String
    /// "send", "edit", "delete" or "create". Nil from a daemon older than edit and delete approvals: a send.
    let action: String?
    /// The message an edit or delete is for.
    let messageId: Int?
    /// An edit: the text the chat sees now (`text` is the new text). A delete: nil, `text` is the message to remove.
    let previousText: String?
    /// The chat it goes to, for its avatar. Nil from a daemon older than avatars.
    let chatId: Int?
    let to: String
    let detail: String
    let text: String
    let reason: String
    let sessionLabel: String
    let createdAt: String
    let expiresAt: String
    let firstTime: Bool
    let nickname: String?
    let suggestedNickname: String

    var isEdit: Bool { action == "edit" }
    var isDelete: Bool { action == "delete" }
    /// A new channel or supergroup (telegram_create_chat): `to` names it, `text` describes it. Only the user can approve it.
    var isCreate: Bool { action == "create" }
    /// "message #123", for an edit or delete.
    var messageLabel: String { messageId.map { "message #\($0)" } ?? "a message" }
}

struct SentRecord: Decodable, Identifiable {
    var id: String { "\(chatId):\(messageId)" }
    let at: String
    let chatId: Int
    let chatLabel: String
    let text: String
    let messageId: Int
    let via: String
    let sessionLabel: String?
    /// Set once a session edited it (telegram_edit_message); absent from older daemons.
    let edited: SentEdit?
}

struct SentEdit: Decodable {
    let at: String
    let by: String?
    let original: String
}

/// A saved chat and the rules that apply to it (the Contacts page).
struct UiContact: Decodable, Identifiable {
    var id: String { nickname }
    let nickname: String
    let chatId: Int
    let name: String?
    let username: String?
    let type: String?
    let topicId: Int?
    let aliases: [String]
    let notes: String?
    /// "autoSend" | "requireApproval" | "blocked" | "none"
    let sendMode: String
    let autoReply: Bool
    let policy: String
    let sameChat: [String]
    /// A person other than you, so paging works both ways. Missing from a daemon older than this app.
    let pageable: Bool?
    /// On paging.pageFrom: their "/page <reason>" rings you.
    let pageFrom: Bool?

    var canPage: Bool { pageable ?? false }
    var pagesMe: Bool { pageFrom ?? false }
}

/// A page: something that needs you now. Rings until you ack or snooze it here, in the tray or on the phone.
struct UiPage: Decodable, Identifiable, Equatable {
    let id: String
    /// "command" | "keyword" | "claude" | "test"
    let source: String
    /// "ringing" | "unanswered" | "snoozed"
    let state: String
    let from: String
    let chat: String?
    let chatId: Int?
    let messageId: Int?
    let reason: String
    let createdAt: String
    let snoozedUntil: String?

    var ringing: Bool { state != "snoozed" }

    /// Opens the message in Telegram: users by id, supergroups through t.me/c, basic groups by chat id.
    var messageURL: URL? {
        guard let chatId, let messageId else { return nil }
        if chatId > 0 { return URL(string: "tg://openmessage?user_id=\(chatId)&message_id=\(messageId)") }
        if chatId <= -1_000_000_000_000 { return URL(string: "https://t.me/c/\(-chatId - 1_000_000_000_000)/\(messageId)") }
        return URL(string: "tg://openmessage?chat_id=\(-chatId)&message_id=\(messageId)")
    }
}

/// The away auto-reply settings and where the clock puts them (UiAway in src/shared/protocol.ts).
struct UiAway: Decodable, Equatable {
    let enabled: Bool
    /// "HH:MM", this Mac's time.
    let from: String
    let until: String
    let message: String
    let quietMinutes: Int
    /// Switched on and inside the hours: a message now gets a reply.
    let active: Bool
    /// When it next turns on or off (ISO time); nil while it's off.
    let nextChange: String?
    /// The saved message as it goes out: {name} filled in, footer added.
    let preview: String
}

struct UiState: Decodable {
    let telegram: TelegramState
    let configError: String?
    let footer: String
    let approvals: [UiApproval]
    let sessions: [UiSession]
    let recent: [SentRecord]
    /// Missing from a daemon older than this app; the Contacts page then asks for a restart.
    let contacts: [UiContact]?
    let defaultPolicy: String?
    /// Missing from a daemon older than this app.
    let pages: [UiPage]?
    /// Missing from a daemon older than this app; the Away page then asks for a restart.
    let away: UiAway?
}

/// The chats you last sent to, newest first, each with the messages sent there.
struct RecentChat: Identifiable {
    let id: Int
    let label: String
    let messages: [SentRecord]
}

// MARK: - Talking to the daemon

/// Reads the daemon's token. Mirrors src/shared/secrets.ts: service "telegram-mcp", account
/// "token" for the default home and "token@<home>" for any other TELEGRAM_MCP_HOME.
enum TokenSource {
    struct Result: Sendable {
        let token: String?
        let status: OSStatus
    }

    static var usesFile: Bool {
        ProcessInfo.processInfo.environment["TELEGRAM_MCP_SECRET_STORE"]?.lowercased() == "file"
    }

    static func account(home: URL) -> String {
        let defaultHome = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".config/telegram-mcp")
        return home.path == defaultHome.path ? "token" : "token@\(home.path)"
    }

    /// Blocks while macOS asks "allow access?" the first time, so call it off the main thread.
    static func read(home: URL) -> Result {
        if usesFile {
            let t = (try? String(contentsOf: home.appendingPathComponent("token"), encoding: .utf8))?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            return Result(token: t?.isEmpty == false ? t : nil, status: t == nil ? errSecItemNotFound : errSecSuccess)
        }
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "telegram-mcp",
            kSecAttrAccount as String: account(home: home),
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var out: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &out)
        guard status == errSecSuccess, let data = out as? Data, let t = String(data: data, encoding: .utf8) else {
            return Result(token: nil, status: status == errSecSuccess ? errSecDecode : status)
        }
        let token = t.trimmingCharacters(in: .whitespacesAndNewlines)
        return Result(token: token.isEmpty ? nil : token, status: status)
    }

    static func problem(_ status: OSStatus) -> String {
        switch status {
        case errSecItemNotFound:
            return "No token yet. Is the daemon installed? (tgmcp install)"
        case errSecUserCanceled, errSecAuthFailed:
            return "Keychain access was denied. Quit and reopen the app, then choose Always Allow."
        case errSecInteractionNotAllowed:
            return "The Keychain is locked. Unlock it (log in) and this retries by itself."
        default:
            let why = SecCopyErrorMessageString(status, nil) as String? ?? "OSStatus \(status)"
            return "Could not read the token from the Keychain: \(why)"
        }
    }
}

@MainActor
final class Store: ObservableObject {
    @Published var state: UiState?
    @Published var reachable = false
    @Published var problem: String?
    @Published var busy: Set<String> = []
    @Published var flash: String?
    /// The flash is good news (green check) or a failure (red warning).
    @Published var flashOK = true
    @Published var pages: [UiPage] = []
    /// A listen switch just flipped, by nickname, until the daemon's next state shows it: so the
    /// switch doesn't spring back while the request is out.
    @Published var pendingListen: [String: Bool] = [:]
    private let alarm = PageAlarm()

    static let olderContacts = "The daemon is older than this app. Restart it (Restart, below) to edit contacts."

    let home: URL
    let port: Int
    private var timer: Timer?
    private var notified = Set<String>()

    init(polling: Bool = true) {
        let env = ProcessInfo.processInfo.environment
        if let h = env["TELEGRAM_MCP_HOME"], !h.isEmpty {
            home = URL(fileURLWithPath: h)
        } else {
            home = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".config/telegram-mcp")
        }
        port = Int(env["TELEGRAM_MCP_PORT"] ?? "") ?? 47823
        guard polling else { return }
        let t = Timer(timeInterval: 2, repeats: true) { [weak self] _ in
            Task { @MainActor in await self?.poll() }
        }
        RunLoop.main.add(t, forMode: .common) // keep polling while the panel is open
        timer = t
        Task { await poll() }
    }

    /// Read once and kept in memory. Cleared when the daemon says no, so a new token is picked up.
    private var token: String?
    private var tokenProblem: String?
    private var readingToken = false
    private var tokenRetryAt = Date.distantPast

    private func currentToken() async -> String? {
        if let token { return token }
        // One read at a time, and after a "Deny" wait a minute: a prompt every 2 s would be awful.
        guard !readingToken, Date() >= tokenRetryAt else { return nil }
        readingToken = true
        defer { readingToken = false }
        let home = self.home
        let result = await Task.detached { TokenSource.read(home: home) }.value
        if let t = result.token {
            token = t
            tokenProblem = nil
            return t
        }
        tokenProblem = TokenSource.problem(result.status)
        tokenRetryAt = Date().addingTimeInterval(result.status == errSecItemNotFound ? 2 : 60)
        return nil
    }

    private func request(_ path: String, method: String = "GET", body: [String: Any]? = nil) async -> URLRequest? {
        guard let token = await currentToken(), let url = URL(string: "http://127.0.0.1:\(port)\(path)") else { return nil }
        var req = URLRequest(url: url, timeoutInterval: 4)
        req.httpMethod = method
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        // The newer approval kinds this app shows as such (UI_FEATURES_HEADER in src/shared/protocol.ts):
        // without it the daemon keeps new-chat requests from it, since it would show one as a send.
        req.setValue("create", forHTTPHeaderField: "X-Tgmcp-Features")
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        }
        return req
    }

    func poll() async {
        guard let req = await request("/ui/state") else {
            reachable = false
            problem = tokenProblem ?? "Reading the token from the Keychain…"
            return
        }
        do {
            let (data, resp) = try await URLSession.shared.data(for: req)
            let code = (resp as? HTTPURLResponse)?.statusCode
            guard code == 200 else {
                if code == 401 { token = nil } // the token changed: read it again next time
                reachable = false
                problem = "The daemon refused the request (token mismatch?)."
                return
            }
            let next = try JSONDecoder().decode(UiState.self, from: data)
            state = next
            reachable = true
            problem = nil
            notifyNewApprovals(next.approvals)
            showPages(next.pages ?? [])
        } catch {
            reachable = false
            problem = "The daemon is not running. It restarts by itself; or run tgmcp install."
        }
    }

    // MARK: Avatars

    /// Contacts' profile photos by chat id, as the daemon serves them (GET /ui/avatars/:chatId).
    @Published private(set) var avatars: [Int: NSImage] = [:]
    private var avatarAskedAt: [Int: Date] = [:]
    private var avatarLoading = Set<Int>()

    /// The chat's photo once it has loaded, else nil (the avatar shows initials). The first time a
    /// chat's avatar shows, and then at most every 6 hours, it asks the daemon, never on each poll.
    func avatar(_ chatId: Int?) -> NSImage? {
        guard let chatId else { return nil }
        if !avatarLoading.contains(chatId), Date().timeIntervalSince(avatarAskedAt[chatId] ?? .distantPast) > 6 * 3600 {
            avatarLoading.insert(chatId)
            Task { @MainActor in await self.loadAvatar(chatId) } // after this view update, never during it
        }
        return avatars[chatId]
    }

    func loadAvatar(_ chatId: Int) async {
        avatarLoading.insert(chatId)
        defer {
            avatarLoading.remove(chatId)
            avatarAskedAt[chatId] = Date()
        }
        guard let req = await request("/ui/avatars/\(chatId)"),
              let got = try? await URLSession.shared.data(for: req),
              (got.1 as? HTTPURLResponse)?.statusCode == 200,
              let image = NSImage(data: got.0) else { return } // no photo, an older daemon, or offline: initials stay
        avatars[chatId] = image
    }

    /// Snapshots render at once, so they load every avatar on screen first.
    func loadAllAvatars() async {
        guard let s = state else { return }
        var ids = Set(s.contacts?.map(\.chatId) ?? [])
        ids.formUnion(s.approvals.compactMap(\.chatId))
        ids.formUnion(s.recent.map(\.chatId))
        ids.formUnion((s.pages ?? []).compactMap(\.chatId))
        for id in ids { await loadAvatar(id) }
    }

    private func showPages(_ next: [UiPage]) {
        if next != pages { pages = next }
        alarm.update(ringing: next.filter(\.ringing), store: self)
    }

    /// Ack, or snooze for `minutes` (15 or 60). Stops the alarm here at once; the daemon tells the rest.
    func page(_ id: String, ack: Bool, minutes: Int = 15) async {
        var body: [String: Any] = ["action": ack ? "ack" : "snooze", "from": "menubar"]
        if !ack { body["minutes"] = minutes }
        guard let req = await request("/ui/pages/\(id)", method: "POST", body: body) else {
            show(tokenProblem ?? "No token for the daemon yet.", ok: false)
            return
        }
        showPages(pages.filter { $0.id != id })
        do {
            _ = try await URLSession.shared.data(for: req)
        } catch {
            show("Could not reach the daemon: \(error.localizedDescription)", ok: false)
        }
        await poll()
    }

    /// `remember` (first message to a chat): "autoSend" = always allow, "requireApproval" = ask every time.
    func decide(_ id: String, approve: Bool, remember: String? = nil, nickname: String? = nil) async {
        var body = ["decision": approve ? "approve" : "deny"]
        if let remember { body["remember"] = remember }
        if let nickname, !nickname.trimmingCharacters(in: .whitespaces).isEmpty { body["nickname"] = nickname }
        guard let req = await request("/ui/approvals/\(id)", method: "POST", body: body) else {
            show(tokenProblem ?? "No token for the daemon yet.", ok: false)
            return
        }
        busy.insert(id)
        defer { busy.remove(id) }
        do {
            let (data, resp) = try await URLSession.shared.data(for: req)
            let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            let ok = (obj?["ok"] as? Bool) ?? ((resp as? HTTPURLResponse)?.statusCode == 200)
            show((obj?["text"] as? String) ?? (!ok ? "Not done." : approve ? "Sent." : "Denied."), ok: ok)
        } catch {
            show("Could not reach the daemon: \(error.localizedDescription)", ok: false)
        }
        UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: [id])
        await poll()
    }

    /// A Contacts-page edit: "sendMode", "autoReply" and/or "rename". Returns the chat's nickname
    /// afterwards (a rename changes it), or nil when it wasn't saved.
    @discardableResult
    func editContact(_ nickname: String, _ change: [String: Any]) async -> String? {
        var body = change
        body["nickname"] = nickname
        guard let req = await request("/ui/contacts", method: "POST", body: body) else {
            show(tokenProblem ?? "No token for the daemon yet.", ok: false)
            return nil
        }
        let key = "contact:\(nickname)"
        busy.insert(key)
        defer { busy.remove(key) }
        var saved: String?
        do {
            let (data, resp) = try await URLSession.shared.data(for: req)
            let code = (resp as? HTTPURLResponse)?.statusCode
            let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            if code == 404 {
                show(Self.olderContacts, ok: false)
            } else {
                show((obj?["text"] as? String) ?? (code == 200 ? "Saved." : "Not changed."), ok: code == 200)
                if code == 200 { saved = (obj?["nickname"] as? String) ?? nickname }
            }
        } catch {
            show("Could not reach the daemon: \(error.localizedDescription)", ok: false)
        }
        await poll()
        return saved
    }

    /// The Page button: the daemon sends "/page <reason>" to that person. True when it went out.
    @discardableResult
    func pageContact(_ nickname: String, reason: String) async -> Bool {
        guard let req = await request("/ui/contacts/page", method: "POST", body: ["nickname": nickname, "reason": reason]) else {
            show(tokenProblem ?? "No token for the daemon yet.", ok: false)
            return false
        }
        let key = "page:\(nickname)"
        busy.insert(key)
        defer { busy.remove(key) }
        var sent = false
        do {
            let (data, resp) = try await URLSession.shared.data(for: req)
            let code = (resp as? HTTPURLResponse)?.statusCode
            let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            if code == 404 {
                show("The daemon is older than this app. Restart it (Restart, below) to page from here.", ok: false)
            } else {
                sent = code == 200
                show((obj?["text"] as? String) ?? (sent ? "Paged." : "Not paged."), ok: sent)
            }
        } catch {
            show("Could not reach the daemon: \(error.localizedDescription)", ok: false)
        }
        await poll()
        return sent
    }

    /// An Away-page edit for POST /ui/away: any of "enabled", "from", "until", "message", "quietMinutes".
    /// True when the daemon saved it.
    @discardableResult
    func saveAway(_ change: [String: Any]) async -> Bool {
        guard let req = await request("/ui/away", method: "POST", body: change) else {
            show(tokenProblem ?? "No token for the daemon yet.", ok: false)
            return false
        }
        busy.insert("away")
        defer { busy.remove("away") }
        var saved = false
        do {
            let (data, resp) = try await URLSession.shared.data(for: req)
            let code = (resp as? HTTPURLResponse)?.statusCode
            let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            if code == 404 {
                show(Away.olderDaemon, ok: false)
            } else {
                saved = code == 200
                show((obj?["text"] as? String) ?? (saved ? "Saved." : "Not changed."), ok: saved)
            }
        } catch {
            show("Could not reach the daemon: \(error.localizedDescription)", ok: false)
        }
        await poll()
        return saved
    }

    /// The listen switches: turn auto-reply on or off for these saved chats. The daemon passes a chat's
    /// messages to sessions only while it's on, so off pauses listening there (the watches stay) and on
    /// resumes it. One flash for the lot; it stops at the first one that fails.
    func setListening(_ nicknames: [String], on: Bool, label: String) async {
        guard !nicknames.isEmpty else { return }
        for n in nicknames { pendingListen[n] = on }
        var failed: String?
        for n in nicknames {
            guard let req = await request("/ui/contacts", method: "POST", body: ["nickname": n, "autoReply": on]) else {
                failed = tokenProblem ?? "No token for the daemon yet."
                break
            }
            let key = "contact:\(n)"
            busy.insert(key)
            defer { busy.remove(key) }
            do {
                let (data, resp) = try await URLSession.shared.data(for: req)
                let code = (resp as? HTTPURLResponse)?.statusCode
                if code == 404 {
                    failed = Self.olderContacts
                    break
                }
                if code != 200 {
                    let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
                    failed = (obj?["text"] as? String) ?? "\(n) wasn\u{2019}t changed."
                    break
                }
            } catch {
                failed = "Could not reach the daemon: \(error.localizedDescription)"
                break
            }
        }
        if let failed {
            show(failed, ok: false)
        } else if on {
            show("Claude may listen to \(label) again.", ok: true)
        } else {
            show("Paused \(label): new messages there aren\u{2019}t passed to Claude.", ok: true)
        }
        await poll()
        for n in nicknames { pendingListen[n] = nil }
    }

    /// Shows a line under the header for 6 seconds, and reads it out with VoiceOver.
    private func show(_ text: String, ok: Bool = true) {
        flash = text
        flashOK = ok
        NSAccessibility.post(element: NSApp as Any, notification: .announcementRequested, userInfo: [
            .announcement: text,
            .priority: NSAccessibilityPriorityLevel.high.rawValue,
        ])
        Task {
            try? await Task.sleep(for: .seconds(6))
            if flash == text { flash = nil }
        }
    }

    private func notifyNewApprovals(_ approvals: [UiApproval]) {
        let ids = Set(approvals.map(\.id))
        let center = UNUserNotificationCenter.current()
        let gone = notified.subtracting(ids)
        if !gone.isEmpty { center.removeDeliveredNotifications(withIdentifiers: Array(gone)) }
        for a in approvals where !notified.contains(a.id) {
            let content = UNMutableNotificationContent()
            content.title = "Send this Telegram message?"
            content.subtitle = "To \(a.to) (\(a.detail))"
            content.body = a.text
            content.categoryIdentifier = a.firstTime ? "APPROVAL_NEW" : "APPROVAL"
            if a.firstTime { content.title = "First message to \(a.to): send it?" }
            if a.isEdit {
                content.title = "Edit this Telegram message?"
                content.subtitle = "\(a.messageLabel) in \(a.to)"
                content.body = "Now: \(a.previousText ?? "")\nWill say: \(a.text)"
                content.categoryIdentifier = "APPROVAL_EDIT"
            } else if a.isDelete {
                content.title = "Delete this Telegram message for everyone?"
                content.subtitle = "\(a.messageLabel) in \(a.to)"
                content.categoryIdentifier = "APPROVAL_DELETE"
            } else if a.isCreate {
                content.title = "Create this Telegram chat?"
                content.subtitle = "\(a.to) (\(a.detail))"
                content.categoryIdentifier = "APPROVAL_CREATE"
            }
            content.userInfo = ["approvalId": a.id]
            content.sound = .default
            center.add(UNNotificationRequest(identifier: a.id, content: content, trigger: nil))
        }
        notified = ids
    }

    var recentChats: [RecentChat] {
        var order: [Int] = []
        var byChat: [Int: [SentRecord]] = [:]
        for r in state?.recent ?? [] {
            if byChat[r.chatId] == nil { order.append(r.chatId) }
            byChat[r.chatId, default: []].append(r)
        }
        return order.prefix(5).map { id in
            RecentChat(id: id, label: byChat[id]!.first!.chatLabel, messages: byChat[id]!)
        }
    }

    /// The message without the footer, for the recent list (approval cards show the exact text).
    func body(_ text: String) -> String {
        let mark = (state?.footer ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !mark.isEmpty, t.hasSuffix(mark) else { return t }
        return String(t.dropLast(mark.count)).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var listening: [UiSession] { (state?.sessions ?? []).filter { !$0.watches.isEmpty } }

    /// The saved chat with this id: its auto-reply is the listen switch. Nil when it isn't saved, or
    /// the daemon is older than the Contacts page.
    func contact(chatId: Int) -> UiContact? {
        state?.contacts?.first { $0.chatId == chatId }
    }

    /// Whether Claude may listen to this chat, counting a switch that was just flipped.
    func listens(_ c: UiContact) -> Bool { pendingListen[c.nickname] ?? c.autoReply }

    /// Chats sessions watch whose listen switch is off.
    var pausedChats: Int {
        Set(listening.flatMap { $0.watches.map(\.chatId) })
            .filter { id in contact(chatId: id).map { !listens($0) } ?? false }
            .count
    }

    /// The connection, in one word and one line, for the header and the menu bar icon.
    var status: (health: Health, text: String) {
        switch reachable ? (state?.telegram.phase ?? "") : "unreachable" {
        case "connected":
            let me = state?.telegram.me
            return (.good, "Connected as \(me?.name ?? "?")\(me?.username.map { " (@\($0))" } ?? "")")
        case "connecting", "starting": return (.busy, "Reconnecting\u{2026} (it retries on its own)")
        case "logged_out": return (.bad, "Logged out. Run tgmcp login")
        case "no_credentials": return (.bad, "No API credentials. Run tgmcp login")
        default: return (.off, "Daemon not reachable")
        }
    }

    /// The count of drafts waiting, else "!" when the daemon or Telegram is down. Unreachable shows
    /// "!" even with drafts from the last good poll: those can't be decided until it's back.
    var iconState: IconState {
        let health = status.health
        let waiting = reachable ? (state?.approvals.count ?? 0) : 0
        let on = !listening.isEmpty
        if waiting > 0 { return IconState(health: health, listening: on, badge: MenuBarIcon.badgeText(waiting), pending: true) }
        return IconState(health: health, listening: on, badge: health == .good ? nil : "!")
    }

    /// What VoiceOver says for the menu bar icon.
    var iconDescription: String {
        let waiting = reachable ? (state?.approvals.count ?? 0) : 0
        var bits = ["Telegram MCP", status.text]
        if waiting > 0 { bits.append("\(waiting) waiting for approval") }
        if !listening.isEmpty { bits.append("listening") }
        return bits.joined(separator: ", ")
    }

    func openFile(_ name: String) {
        NSWorkspace.shared.open(home.appendingPathComponent(name))
    }

    func restartDaemon() {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        p.arguments = ["kickstart", "-k", "gui/\(getuid())/com.telegram-mcp.daemon"]
        try? p.run()
        show("Restarting the daemon\u{2026}")
    }
}

// MARK: - Notification actions (approve / deny straight from the banner)

final class NotificationHandler: NSObject, UNUserNotificationCenterDelegate {
    weak var store: Store?

    func setUp(store: Store) {
        self.store = store
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        let approve = UNNotificationAction(identifier: "APPROVE", title: "Send", options: [])
        let deny = UNNotificationAction(identifier: "DENY", title: "Deny", options: [.destructive])
        let askNext = UNNotificationAction(identifier: "APPROVE", title: "Send, ask next time", options: [])
        let always = UNNotificationAction(identifier: "ALWAYS", title: "Send, always allow", options: [])
        // An edit or delete of a message Claude sent: approving makes the change, denying leaves it.
        let edit = UNNotificationAction(identifier: "APPROVE", title: "Edit", options: [])
        let delete = UNNotificationAction(identifier: "APPROVE", title: "Delete", options: [.destructive])
        let keep = UNNotificationAction(identifier: "DENY", title: "Keep", options: [])
        let create = UNNotificationAction(identifier: "APPROVE", title: "Create", options: [.authenticationRequired])
        center.setNotificationCategories([
            UNNotificationCategory(identifier: "APPROVAL", actions: [approve, deny], intentIdentifiers: [], options: []),
            UNNotificationCategory(identifier: "APPROVAL_NEW", actions: [askNext, always, deny], intentIdentifiers: [], options: []),
            UNNotificationCategory(identifier: "APPROVAL_EDIT", actions: [edit, deny], intentIdentifiers: [], options: []),
            UNNotificationCategory(identifier: "APPROVAL_DELETE", actions: [delete, keep], intentIdentifiers: [], options: []),
            UNNotificationCategory(identifier: "APPROVAL_CREATE", actions: [create, deny], intentIdentifiers: [], options: []),
        ])
        center.requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in }
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler done: @escaping () -> Void) {
        let id = response.notification.request.content.userInfo["approvalId"] as? String
        let action = response.actionIdentifier
        Task { @MainActor in
            if let id, action == "APPROVE" { await self.store?.decide(id, approve: true, remember: "requireApproval") }
            if let id, action == "ALWAYS" { await self.store?.decide(id, approve: true, remember: "autoSend") }
            if let id, action == "DENY" { await self.store?.decide(id, approve: false) }
            done()
        }
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler done: @escaping (UNNotificationPresentationOptions) -> Void) {
        done([.banner, .list, .sound])
    }
}

// MARK: - Helpers

let isSnapshot = CommandLine.arguments.contains("--snapshot")
/// `SNAPSHOT_EXPAND=1` starts approval cards and recent chats expanded, as if clicked open;
/// `approvals` or `recent` expands only that section. (`SNAPSHOT_HOVER` is its old name.)
let snapshotExpandMode = ProcessInfo.processInfo.environment["SNAPSHOT_EXPAND"]
    ?? ProcessInfo.processInfo.environment["SNAPSHOT_HOVER"] ?? ""
let snapshotExpandApprovals = ["1", "approvals"].contains(snapshotExpandMode)
let snapshotExpandRecent = ["1", "recent"].contains(snapshotExpandMode)

/// Whether a draft runs past the 4 lines an approval card shows (about 55 characters a line), so
/// the card offers Show all. Nothing in the panel opens on hover: hovering past it shouldn't
/// make the panel jump.
func isLongDraft(_ text: String) -> Bool {
    text.split(separator: "\n", omittingEmptySubsequences: false)
        .reduce(0) { $0 + max(1, ($1.count + 54) / 55) } > 4
}
/// `SNAPSHOT_PAGE=contacts` renders the Contacts tab and `SNAPSHOT_PAGE=away` the Away tab;
/// `SNAPSHOT_OPEN=<nickname>` opens that contact. On Home, `SNAPSHOT_SECTION=listening` or `sent`
/// picks the section below the tiles (Waiting by default).
let snapshotPage: PanelPage = {
    switch ProcessInfo.processInfo.environment["SNAPSHOT_PAGE"] {
    case "contacts": return .contacts
    case "away": return .away
    default: return .home
    }
}()
let snapshotSection: HomeSection = {
    switch ProcessInfo.processInfo.environment["SNAPSHOT_SECTION"] {
    case "listening": return .listening
    case "sent": return .sent
    default: return .waiting
    }
}()
let snapshotOpenContact = ProcessInfo.processInfo.environment["SNAPSHOT_OPEN"]

private let isoWithFraction: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f
}()

func ago(_ iso: String) -> String {
    guard let date = isoWithFraction.date(from: iso) ?? ISO8601DateFormatter().date(from: iso) else { return "" }
    let s = Int(-date.timeIntervalSinceNow)
    if s < 60 { return "now" }
    if s < 3600 { return "\(s / 60)m" }
    if s < 86400 { return "\(s / 3600)h" }
    return "\(s / 86400)d"
}

/// "just now", "5m ago" (the tray's AgoWords).
func agoWords(_ iso: String) -> String {
    let a = ago(iso)
    if a.isEmpty { return "" }
    return a == "now" ? "just now" : "\(a) ago"
}

/// One or two letters for an avatar: "Leo Gavin" → "LG", "team-qa" → "TQ", "@anna_k" → "AK",
/// "leo" → "L" (Format.Initials in the tray). Emoji and symbols are skipped; nothing usable gives "?".
/// A label's trailing " [nickname]" is not part of the name: "Leo Perera [leo]" → "LP", not "LL".
func initials(_ name: String) -> String {
    var name = name
    if name.hasSuffix("]"), let open = name.range(of: " [", options: .backwards), open.lowerBound > name.startIndex {
        name = String(name[..<open.lowerBound])
    }
    let separators: Set<Character> = [" ", "-", "_", ".", "@", "(", ")"]
    let firsts = name.split(whereSeparator: { separators.contains($0) })
        .compactMap { $0.first(where: { $0.isLetter || $0.isNumber }) }
    guard let first = firsts.first else { return "?" }
    let head = String(first).uppercased()
    return firsts.count == 1 ? head : head + String(firsts[firsts.count - 1]).uppercased()
}

// MARK: - Look: colours, icons, avatars

extension Color {
    /// 0xAARRGGBB, as the tray app writes its colours (tray/App/Theme.cs).
    init(argb: UInt32) {
        self.init(.sRGB,
                  red: Double((argb >> 16) & 0xFF) / 255,
                  green: Double((argb >> 8) & 0xFF) / 255,
                  blue: Double(argb & 0xFF) / 255,
                  opacity: Double((argb >> 24) & 0xFF) / 255)
    }
}

/// What a chip or a dot means: green good, amber needs you, red bad, blue listening, grey idle.
enum Tone { case good, warn, bad, info, muted }

/// The daemon and Telegram, in one word: green online, yellow reconnecting, red logged out, grey offline.
enum Health: Equatable { case good, busy, bad, off }

/// The panel's colours, the same as the tray's (tray/App/Theme.cs), light and dark. Every colour used
/// for text is at least 4.5:1 (WCAG AA) against a card in its theme and against a wash of its own colour.
struct Palette {
    let dark: Bool
    init(_ scheme: ColorScheme) { dark = scheme == .dark }

    private func c(_ darkValue: UInt32, _ lightValue: UInt32) -> Color { Color(argb: dark ? darkValue : lightValue) }

    var fg: Color { c(0xFFF7F5F3, 0xFF1E1A17) }
    var fg2: Color { c(0xFFC9C3BE, 0xFF5B544F) }
    var fg3: Color { c(0xFFB8B1AC, 0xFF6B635D) }
    var card: Color { c(0x14FFFFFF, 0x8CFFFFFF) }
    var cardBorder: Color { c(0x1CFFFFFF, 0x14000000) }
    var subtle: Color { c(0x0FFFFFFF, 0x0A000000) }
    var subtle2: Color { c(0x1AFFFFFF, 0x12000000) }
    var divider: Color { c(0x1AFFFFFF, 0x14000000) }
    var accent: Color { c(0xFFFF8A63, 0xFFC23A12) }
    var accentSoft: Color { c(0x2EFF6A3D, 0x24EE4F22) }
    var green: Color { c(0xFF5BE3A0, 0xFF0F6B37) }
    var orange: Color { c(0xFFFFBE4D, 0xFF8A5200) }
    var yellow: Color { c(0xFFF5D547, 0xFF7A6200) }
    var red: Color { c(0xFFFFB0B0, 0xFFA61F15) }
    var blue: Color { c(0xFF7CCBF7, 0xFF0D5C99) }
    var gray: Color { c(0xFFC2BBB6, 0xFF5F5852) }
    var accentFill: Color { c(0xFFE0501F, 0xFFC93C14) }
    var badgeBg: Color { c(0xFFFFBE4D, 0xFF8A5200) }
    var badgeFg: Color { c(0xFF1E1A17, 0xFFFFFFFF) }
    /// An ordinary window (the page alarm): opaque, no glass.
    var surface: Color { c(0xFF2B2725, 0xFFF6F2EE) }

    /// The panel's warm smoke, top to bottom. Opaque for snapshots, which can't draw the glass behind it.
    func smoke(top: Bool, opaque: Bool) -> Color {
        let v: UInt32 = dark ? (top ? 0xC83A3532 : 0xD8262322) : (top ? 0xD9F6F2EE : 0xE6ECE7E2)
        return Color(argb: opaque ? v | 0xFF00_0000 : v)
    }

    /// A faint fill of a status colour, for pills and banners.
    func wash(_ color: Color) -> Color { color.opacity(dark ? 0.15 : 0.133) }

    func tone(_ t: Tone) -> Color {
        switch t {
        case .good: return green
        case .warn: return orange
        case .bad: return red
        case .info: return blue
        case .muted: return gray
        }
    }

    func health(_ h: Health) -> Color {
        switch h {
        case .good: return green
        case .busy: return yellow
        case .bad: return red
        case .off: return gray
        }
    }

    // Solid fills behind white text, each at least 4.5:1 with white in both themes.
    static let greenFill = Color(argb: 0xFF157A41)
    static let orangeFill = Color(argb: 0xFFA85A00)
    static let redFill = Color(argb: 0xFFC42B2B)
    static let blueFill = Color(argb: 0xFF1565A8)
    static let grayFill = Color(argb: 0xFF6B6560)

    /// Avatar colours: the same name always gets the same one (FNV-1a, like the tray).
    static let avatars: [Color] = ([0xFFFF6A3D, 0xFF4CC75A, 0xFF62AEFF, 0xFFFFAA3B, 0xFFB57BFF, 0xFF2EC4B6, 0xFFFF5F8F, 0xFF8D8A85] as [UInt32])
        .map { Color(argb: $0) }

    static func avatar(_ name: String) -> Color {
        var h: UInt32 = 2_166_136_261
        for unit in name.lowercased().utf16 {
            h ^= UInt32(unit)
            h = h &* 16_777_619
        }
        return avatars[Int(h % UInt32(avatars.count))]
    }
}

/// SVG path data to a SwiftUI path: M L H V C S Q A Z, absolute and relative. Enough for the
/// Lucide icons and the app's paper plane.
enum SVGPath {
    static func parse(_ d: String) -> Path {
        var path = Path()
        let s = Array(d.utf8)
        var i = 0
        var cmd: UInt8 = 0
        var cur = CGPoint.zero
        var start = CGPoint.zero
        var lastCubic: CGPoint?

        func isSpace(_ c: UInt8) -> Bool { c == 32 || c == 44 || c == 9 || c == 10 || c == 13 }
        func isCommand(_ c: UInt8) -> Bool { ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) && c != 101 && c != 69 }
        func skip() { while i < s.count, isSpace(s[i]) { i += 1 } }
        func number() -> CGFloat? {
            skip()
            let from = i
            if i < s.count, s[i] == 43 || s[i] == 45 { i += 1 }
            var dot = false
            var digits = false
            while i < s.count {
                let c = s[i]
                if c >= 48 && c <= 57 {
                    digits = true
                    i += 1
                } else if c == 46 && !dot {
                    dot = true
                    i += 1
                } else if (c == 101 || c == 69) && digits {
                    i += 1
                    if i < s.count, s[i] == 43 || s[i] == 45 { i += 1 }
                } else {
                    break
                }
            }
            guard digits, let v = Double(String(decoding: s[from..<i], as: UTF8.self)) else {
                i = from
                return nil
            }
            return CGFloat(v)
        }
        func flag() -> Bool? {
            skip()
            guard i < s.count, s[i] == 48 || s[i] == 49 else { return nil }
            let on = s[i] == 49
            i += 1
            return on
        }

        parsing: while true {
            skip()
            guard i < s.count else { break }
            if isCommand(s[i]) {
                cmd = s[i]
                i += 1
            } else if cmd == 0 {
                break
            }
            let rel = cmd >= 97
            let base = rel ? cur : CGPoint.zero
            func pt(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: base.x + x, y: base.y + y) }
            switch cmd | 0x20 {
            case 109: // m
                guard let x = number(), let y = number() else { break parsing }
                cur = pt(x, y)
                start = cur
                path.move(to: cur)
                cmd = rel ? 108 : 76 // more pairs after a move are lines
                lastCubic = nil
            case 108: // l
                guard let x = number(), let y = number() else { break parsing }
                cur = pt(x, y)
                path.addLine(to: cur)
                lastCubic = nil
            case 104: // h
                guard let x = number() else { break parsing }
                cur = CGPoint(x: rel ? cur.x + x : x, y: cur.y)
                path.addLine(to: cur)
                lastCubic = nil
            case 118: // v
                guard let y = number() else { break parsing }
                cur = CGPoint(x: cur.x, y: rel ? cur.y + y : y)
                path.addLine(to: cur)
                lastCubic = nil
            case 99: // c
                guard let x1 = number(), let y1 = number(), let x2 = number(), let y2 = number(),
                      let x = number(), let y = number() else { break parsing }
                let c2 = pt(x2, y2)
                let end = pt(x, y)
                path.addCurve(to: end, control1: pt(x1, y1), control2: c2)
                lastCubic = c2
                cur = end
            case 115: // s
                guard let x2 = number(), let y2 = number(), let x = number(), let y = number() else { break parsing }
                let c1 = lastCubic.map { CGPoint(x: 2 * cur.x - $0.x, y: 2 * cur.y - $0.y) } ?? cur
                let c2 = pt(x2, y2)
                let end = pt(x, y)
                path.addCurve(to: end, control1: c1, control2: c2)
                lastCubic = c2
                cur = end
            case 113: // q
                guard let x1 = number(), let y1 = number(), let x = number(), let y = number() else { break parsing }
                let end = pt(x, y)
                path.addQuadCurve(to: end, control: pt(x1, y1))
                cur = end
                lastCubic = nil
            case 97: // a
                guard let rx = number(), let ry = number(), let rotation = number(), let large = flag(),
                      let sweep = flag(), let x = number(), let y = number() else { break parsing }
                let end = pt(x, y)
                arc(&path, from: cur, to: end, rx: rx, ry: ry, degrees: rotation, large: large, sweep: sweep)
                cur = end
                lastCubic = nil
            case 122: // z
                path.closeSubpath()
                cur = start
                cmd = 0
                lastCubic = nil
            default:
                break parsing
            }
        }
        return path
    }

    /// An elliptical arc as cubic curves (SVG 1.1, appendix F.6.5).
    private static func arc(_ path: inout Path, from p0: CGPoint, to p1: CGPoint, rx rx0: CGFloat, ry ry0: CGFloat,
                            degrees: CGFloat, large: Bool, sweep: Bool) {
        var rx = abs(rx0)
        var ry = abs(ry0)
        guard rx > 0, ry > 0, p0 != p1 else {
            path.addLine(to: p1)
            return
        }
        let phi = degrees * .pi / 180
        let cosP = cos(phi)
        let sinP = sin(phi)
        let dx = (p0.x - p1.x) / 2
        let dy = (p0.y - p1.y) / 2
        let x1 = cosP * dx + sinP * dy
        let y1 = -sinP * dx + cosP * dy
        let lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry)
        if lambda > 1 {
            rx *= lambda.squareRoot()
            ry *= lambda.squareRoot()
        }
        let num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1
        let den = rx * rx * y1 * y1 + ry * ry * x1 * x1
        var coef = den == 0 ? 0 : max(0, num / den).squareRoot()
        if large == sweep { coef = -coef }
        let cxp = coef * rx * y1 / ry
        let cyp = -coef * ry * x1 / rx
        let cx = cosP * cxp - sinP * cyp + (p0.x + p1.x) / 2
        let cy = sinP * cxp + cosP * cyp + (p0.y + p1.y) / 2
        let first = atan2((y1 - cyp) / ry, (x1 - cxp) / rx)
        var delta = atan2((-y1 - cyp) / ry, (-x1 - cxp) / rx) - first
        if sweep && delta < 0 { delta += 2 * .pi }
        if !sweep && delta > 0 { delta -= 2 * .pi }
        let n = max(1, Int((abs(delta) / (.pi / 2)).rounded(.up)))
        let step = delta / CGFloat(n)
        let t = 4 / 3 * tan(step / 4)
        func point(_ a: CGFloat) -> CGPoint {
            CGPoint(x: cx + rx * cos(a) * cosP - ry * sin(a) * sinP, y: cy + rx * cos(a) * sinP + ry * sin(a) * cosP)
        }
        func slope(_ a: CGFloat) -> CGPoint {
            CGPoint(x: -rx * sin(a) * cosP - ry * cos(a) * sinP, y: -rx * sin(a) * sinP + ry * cos(a) * cosP)
        }
        var a = first
        for k in 0..<n {
            let b = a + step
            let pa = point(a)
            let da = slope(a)
            let pb = k == n - 1 ? p1 : point(b)
            let db = slope(b)
            path.addCurve(to: pb,
                          control1: CGPoint(x: pa.x + t * da.x, y: pa.y + t * da.y),
                          control2: CGPoint(x: pb.x - t * db.x, y: pb.y - t * db.y))
            a = b
        }
    }
}

/// Icons from Lucide (https://lucide.dev), lucide-static 0.460.0, ISC License, the same set the tray
/// app draws (tray/App/Icons.xaml). Copyright (c) for portions of Lucide are held by Cole Bemis
/// 2013-2022 as part of Feather (MIT); all other copyright (c) for Lucide is held by Lucide Contributors 2022.
/// Each is a 24x24 outline drawn with a round stroke.
enum Lucide {
    static let raw: [String: String] = [
        "bell-ring": "M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9 M10.3 21a1.94 1.94 0 0 0 3.4 0 M4 2C2.8 3.7 2 5.7 2 8 M22 8c0-2.3-.8-4.3-2-6",
        "bot": "M12 8V4H8 M6,8 H18 A2,2 0 0 1 20,10 V18 A2,2 0 0 1 18,20 H6 A2,2 0 0 1 4,18 V10 A2,2 0 0 1 6,8 Z M2 14h2 M20 14h2 M15 13v2 M9 13v2",
        "check": "M20 6 9 17l-5-5",
        "chevron-down": "M6 9 l6 6 6-6",
        "chevron-up": "M18 15 l-6-6-6 6",
        "circle-check": "M2,12 A10,10 0 1 0 22,12 A10,10 0 1 0 2,12 Z M9 12 l2 2 4-4",
        "clock": "M2,12 A10,10 0 1 0 22,12 A10,10 0 1 0 2,12 Z M12,6 L12,12 L16,14",
        "external-link": "M15 3h6v6 M10 14 21 3 M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6",
        "house": "M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8 M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
        "info": "M2,12 A10,10 0 1 0 22,12 A10,10 0 1 0 2,12 Z M12 16v-4 M12 8h.01",
        "megaphone": "M3 11 l18-5v12L3 14v-3z M11.6 16.8a3 3 0 1 1-5.8-1.6",
        "message-circle": "M7.9 20A9 9 0 1 0 4 16.1L2 22Z",
        "moon": "M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z",
        "pencil": "M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z M15 5l4 4",
        "plus": "M5 12h14 M12 5v14",
        "power": "M12 2v10 M18.4 6.6a9 9 0 1 1-12.77.04",
        "radio": "M4.9 19.1C1 15.2 1 8.8 4.9 4.9 M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.5 M10,12 A2,2 0 1 0 14,12 A2,2 0 1 0 10,12 Z M16.2 7.8c2.3 2.3 2.3 6.1 0 8.5 M19.1 4.9C23 8.8 23 15.1 19.1 19",
        "rotate-cw": "M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8 M21 3v5h-5",
        "scroll-text": "M15 12h-5 M15 8h-5 M19 17V5a2 2 0 0 0-2-2H4 M8 21h12a2 2 0 0 0 2-2v-1a1 1 0 0 0-1-1H11a1 1 0 0 0-1 1v1a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v2a1 1 0 0 0 1 1h3",
        "search": "M3,11 A8,8 0 1 0 19,11 A8,8 0 1 0 3,11 Z M21 21 l-4.3-4.3",
        "send": "M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z M21.854 2.147 l-10.94 10.939",
        "settings": "M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z M9,12 A3,3 0 1 0 15,12 A3,3 0 1 0 9,12 Z",
        "trash-2": "M3 6h18 M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6 M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2 M10 11v6 M14 11v6",
        "terminal": "M4,17 L10,11 L4,5 M12,19 L20,19",
        "triangle-alert": "M21.73 18 l-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3 M12 9v4 M12 17h.01",
        "unplug": "M19 5 l3-3 M2 22 l3-3 M6.3 20.3a2.4 2.4 0 0 0 3.4 0L12 18l-6-6-2.3 2.3a2.4 2.4 0 0 0 0 3.4Z M7.5 13.5 10 11 M10.5 16.5 13 14 M12 6 l6 6 2.3-2.3a2.4 2.4 0 0 0 0-3.4l-2.6-2.6a2.4 2.4 0 0 0-3.4 0Z",
        "user-plus": "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M5,7 A4,4 0 1 0 13,7 A4,4 0 1 0 5,7 Z M19,8 L19,14 M22,11 L16,11",
        "user": "M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2 M8,7 A4,4 0 1 0 16,7 A4,4 0 1 0 8,7 Z",
        "users": "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M5,7 A4,4 0 1 0 13,7 A4,4 0 1 0 5,7 Z M22 21v-2a4 4 0 0 0-3-3.87 M16 3.13a4 4 0 0 1 0 7.75",
        "x": "M18 6 6 18 M6 6 l12 12",
    ]

    static let paths: [String: Path] = raw.mapValues { SVGPath.parse($0) }
}

/// The app's paper plane (docs/icon.svg, a 100x100 drawing), for the panel's logo and the menu bar icon.
enum Brand {
    static let plane = SVGPath.parse(
        "M88.723,12.142C76.419,17.238,23.661,39.091,9.084,45.047c-9.776,3.815-4.053,7.392-4.053,7.392s8.345,2.861,15.499,5.007c7.153,2.146,10.968-0.238,10.968-0.238l33.62-22.652c11.922-8.107,9.061-1.431,6.199,1.431c-6.199,6.2-16.452,15.975-25.036,23.844c-3.815,3.338-1.908,6.199-0.238,7.63c6.199,5.246,23.129,15.976,24.082,16.691c5.037,3.566,14.945,8.699,16.452-2.146c0,0,5.961-37.435,5.961-37.435c1.908-12.637,3.815-24.321,4.053-27.659C97.307,8.804,88.723,12.142,88.723,12.142z")
    static let gradient = LinearGradient(colors: [Color(argb: 0xFF37AEE2), Color(argb: 0xFF1B92D1)],
                                         startPoint: .topLeading, endPoint: .bottomTrailing)
}

/// A path drawn on a `box`-unit square, scaled to the frame.
struct ScaledShape: Shape {
    let shape: Path
    var box: CGFloat = 24
    func path(in rect: CGRect) -> Path {
        shape.applying(CGAffineTransform(translationX: rect.minX, y: rect.minY).scaledBy(x: rect.width / box, y: rect.height / box))
    }
}

/// A Lucide icon by name, in the current foreground colour. Decorative: the control it sits on is named.
struct LucideIcon: View {
    let name: String
    let size: CGFloat
    init(_ name: String, size: CGFloat = 15) {
        self.name = name
        self.size = size
    }
    var body: some View {
        ScaledShape(shape: Lucide.paths[name] ?? Path())
            .stroke(style: StrokeStyle(lineWidth: max(1.1, 2 * size / 24), lineCap: .round, lineJoin: .round))
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}

/// The window behind the panel: macOS's glass with the tray's warm smoke over it.
struct PanelBackground: View {
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        let p = Palette(scheme)
        ZStack {
            if !isSnapshot { Rectangle().fill(.ultraThinMaterial) }
            LinearGradient(colors: [p.smoke(top: true, opaque: isSnapshot), p.smoke(top: false, opaque: isSnapshot)],
                           startPoint: .top, endPoint: UnitPoint(x: 0.35, y: 1))
        }
        .ignoresSafeArea()
    }
}

/// A frosted card: the panel's sections sit in these.
struct CardBackground: ViewModifier {
    @Environment(\.colorScheme) private var scheme
    var padding: CGFloat
    var highlighted: Bool
    func body(content: Content) -> some View {
        let p = Palette(scheme)
        content
            .padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(p.card))
            .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous)
                .strokeBorder(highlighted ? p.accent.opacity(0.55) : p.cardBorder, lineWidth: highlighted ? 1.5 : 1))
    }
}

extension View {
    func card(padding: CGFloat = 14, highlighted: Bool = false) -> some View {
        modifier(CardBackground(padding: padding, highlighted: highlighted))
    }
}

/// A capsule button. With `fill`: a solid fill and white text (pass a fill from Palette, dark enough for
/// 4.5:1). Without: the tint's text on a faint wash of it. `wide` stretches it to the space it gets.
struct Pill: ButtonStyle {
    var tint: Color
    var fill: Color? = nil
    var wide = false
    @Environment(\.isEnabled) private var enabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 12, weight: .semibold))
            .lineLimit(1)
            .padding(.horizontal, 14)
            .padding(.vertical, 6)
            .frame(maxWidth: wide ? .infinity : nil)
            .foregroundStyle(fill == nil ? tint : Color.white)
            .background(Capsule().fill(fill ?? tint.opacity(0.14)))
            .contentShape(Capsule())
            .opacity(configuration.isPressed ? 0.75 : enabled ? 1 : 0.5)
    }
}

/// A round icon-only button in the header (Rules, Log).
struct RoundButton: View {
    @Environment(\.colorScheme) private var scheme
    let icon: String
    let label: String
    let help: String
    let action: () -> Void
    var body: some View {
        let p = Palette(scheme)
        Button(action: action) {
            LucideIcon(icon, size: 16)
                .foregroundStyle(p.fg2)
                .frame(width: 32, height: 32)
                .background(Circle().fill(p.card))
                .overlay(Circle().strokeBorder(p.cardBorder))
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .help(help)
        .accessibilityLabel(Text(verbatim: label))
    }
}

/// A plain icon + text button for the footer.
struct FooterButton: View {
    @Environment(\.colorScheme) private var scheme
    let icon: String
    let title: String
    let help: String
    let action: () -> Void
    var body: some View {
        let p = Palette(scheme)
        Button(action: action) {
            HStack(spacing: 5) {
                LucideIcon(icon, size: 13)
                Text(verbatim: title).font(.system(size: 11, weight: .medium))
            }
            .foregroundStyle(p.fg2)
            .padding(.horizontal, 8).padding(.vertical, 5)
            .background(Capsule().fill(p.subtle))
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .help(help)
    }
}

/// A word in a coloured capsule: "needs you", "always allow", "Monitor on".
struct Chip: View {
    @Environment(\.colorScheme) private var scheme
    let text: String
    let tone: Tone
    init(_ text: String, _ tone: Tone) {
        self.text = text
        self.tone = tone
    }
    var body: some View {
        let p = Palette(scheme)
        let c = p.tone(tone)
        Text(verbatim: text)
            .font(.system(size: 10, weight: .semibold))
            .foregroundStyle(c)
            .lineLimit(1).fixedSize() // never wrap: the name next to it truncates instead
            .padding(.horizontal, 7).padding(.vertical, 2)
            .background(Capsule().fill(p.wash(c)))
    }
}

/// A count on amber: the drafts waiting.
struct CountBadge: View {
    @Environment(\.colorScheme) private var scheme
    let count: Int
    var body: some View {
        let p = Palette(scheme)
        Text(verbatim: count > 99 ? "99+" : "\(count)")
            .font(.system(size: 10, weight: .bold))
            .foregroundStyle(p.badgeFg)
            .padding(.horizontal, 6).padding(.vertical, 1)
            .frame(minWidth: 18)
            .background(Capsule().fill(p.badgeBg))
            .accessibilityLabel(Text(verbatim: "\(count) waiting"))
    }
}

/// A round avatar: the chat's profile photo when it has one, else initials on a colour picked by
/// name, or a glyph (groups, channels, bots).
struct AvatarView: View {
    let name: String
    var glyph: String? = nil
    var size: CGFloat = 34
    /// From `store.avatar(chatId)`: nil until it loads, and when the chat has no photo.
    var photo: NSImage? = nil
    var body: some View {
        ZStack {
            Circle().fill(Palette.avatar(name))
            if let photo {
                Image(nsImage: photo).resizable().scaledToFill().frame(width: size, height: size).clipShape(Circle())
            } else if let glyph {
                LucideIcon(glyph, size: size / 2).foregroundStyle(.white)
            } else {
                Text(verbatim: initials(name))
                    .font(.system(size: size * 0.36, weight: .semibold))
                    .foregroundStyle(.white)
            }
            Circle().strokeBorder(Color.white.opacity(0.2))
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

/// An icon in a soft circle, for empty states and session rows.
struct Disc: View {
    @Environment(\.colorScheme) private var scheme
    let icon: String
    var tone: Tone? = nil
    var size: CGFloat = 34
    var body: some View {
        let p = Palette(scheme)
        LucideIcon(icon, size: size / 2)
            .foregroundStyle(tone.map { p.tone($0) } ?? p.fg2)
            .frame(width: size, height: size)
            .background(Circle().fill(tone.map { p.wash(p.tone($0)) } ?? p.subtle2))
    }
}

/// A card's title, with an optional count and something on the right.
struct CardTitle<Trailing: View>: View {
    let title: String
    var count = 0
    @ViewBuilder var trailing: () -> Trailing
    var body: some View {
        HStack(spacing: 8) {
            Text(verbatim: title).font(.system(size: 13, weight: .semibold))
                .accessibilityAddTraits(.isHeader)
            if count > 0 { CountBadge(count: count) }
            Spacer(minLength: 4)
            trailing()
        }
    }
}

extension CardTitle where Trailing == EmptyView {
    init(_ title: String, count: Int = 0) {
        self.title = title
        self.count = count
        self.trailing = { EmptyView() }
    }
}

/// Nothing here yet: what would show up, and how it gets here.
struct EmptyRow: View {
    @Environment(\.colorScheme) private var scheme
    let icon: String
    var tone: Tone? = nil
    let title: String
    let text: String
    var body: some View {
        let p = Palette(scheme)
        HStack(alignment: .top, spacing: 10) {
            Disc(icon: icon, tone: tone)
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: title).font(.system(size: 12, weight: .semibold)).foregroundStyle(p.fg2)
                Text(verbatim: text).font(.system(size: 11)).foregroundStyle(p.fg3)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .combine)
    }
}

/// A line of explanation with an icon: "what happens here, in plain words".
struct Hint: View {
    @Environment(\.colorScheme) private var scheme
    var icon = "info"
    let text: String
    var boxed = true
    var body: some View {
        let p = Palette(scheme)
        HStack(alignment: .top, spacing: 8) {
            LucideIcon(icon, size: 14).foregroundStyle(p.accent).padding(.top, 1)
            Text(verbatim: text).font(.system(size: 11)).foregroundStyle(p.fg2)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, boxed ? 10 : 0).padding(.vertical, boxed ? 8 : 0)
        .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(boxed ? p.subtle : .clear))
    }
}

/// A coloured banner: the away line on Home, a config error, the flash after an action.
struct Banner: View {
    @Environment(\.colorScheme) private var scheme
    let icon: String
    let tone: Tone
    let text: String
    var bold: String? = nil
    var body: some View {
        let p = Palette(scheme)
        HStack(alignment: .top, spacing: 8) {
            LucideIcon(icon, size: 15).foregroundStyle(p.tone(tone)).padding(.top, 1)
            (bold.map { Text(verbatim: $0).fontWeight(.semibold) + Text(verbatim: ": ") } ?? Text(verbatim: ""))
                .font(.system(size: 11))
                + Text(verbatim: text).font(.system(size: 11))
            Spacer(minLength: 0)
        }
        .foregroundStyle(p.fg)
        .fixedSize(horizontal: false, vertical: true)
        .padding(.horizontal, 12).padding(.vertical, 9)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(p.wash(p.tone(tone))))
        .accessibilityElement(children: .combine)
    }
}

/// One choice out of a few, like a segmented control: the chosen one is filled.
struct Segments: View {
    @Environment(\.colorScheme) private var scheme
    struct Option {
        let title: String
        let value: String
        let fill: Color
        let help: String
    }
    let options: [Option]
    let selected: String
    let choose: (String) -> Void
    var body: some View {
        let p = Palette(scheme)
        HStack(spacing: 2) {
            ForEach(options.indices, id: \.self) { i in
                let o = options[i]
                let on = o.value == selected
                Button { if !on { choose(o.value) } } label: {
                    Text(verbatim: o.title)
                        .font(.system(size: 11, weight: .semibold))
                        .lineLimit(1)
                        .padding(.horizontal, 12).padding(.vertical, 5)
                        .foregroundStyle(on ? Color.white : p.fg2)
                        .background(Capsule().fill(on ? o.fill : Color.clear))
                        .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .help(o.help)
                .accessibilityAddTraits(on ? .isSelected : [])
            }
        }
        .padding(2)
        .background(Capsule().fill(p.subtle2))
    }
}

/// The on/off switch that lets Claude listen to a chat (its auto-reply). Blue while on.
struct ListenSwitch: View {
    let on: Bool
    var busy = false
    let label: String
    let change: (Bool) -> Void
    var body: some View {
        if isSnapshot {
            SnapshotSwitch(on: on, tint: Palette.blueFill, mini: true)
        } else {
            Toggle(isOn: Binding(get: { on }, set: { change($0) })) { Text(verbatim: label) }
                .toggleStyle(.switch)
                .controlSize(.mini)
                .labelsHidden()
                .tint(Palette.blueFill)
                .disabled(busy)
                .accessibilityLabel(Text(verbatim: label))
        }
    }
}

/// The offscreen snapshot renderer can't draw a native switch (it leaves a yellow placeholder),
/// so snapshots get this drawing of one instead.
struct SnapshotSwitch: View {
    let on: Bool
    let tint: Color
    var mini = false
    var body: some View {
        let size = mini ? CGSize(width: 26, height: 15) : CGSize(width: 38, height: 22)
        Capsule()
            .fill(on ? tint : Color.primary.opacity(0.18))
            .frame(width: size.width, height: size.height)
            .overlay(alignment: on ? .trailing : .leading) {
                Circle().fill(Color.white)
                    .shadow(color: .black.opacity(0.25), radius: 0.5, y: 0.5)
                    .padding(1.5)
            }
    }
}

/// A text box on a soft fill. The offscreen snapshot renderer can't draw text fields, so it shows the text.
struct FieldBox: View {
    @Environment(\.colorScheme) private var scheme
    let placeholder: String
    @Binding var text: String
    var width: CGFloat? = nil
    var center = false
    var monospaced = false
    var name: String
    var submit: () -> Void = {}
    var body: some View {
        let p = Palette(scheme)
        Group {
            if isSnapshot {
                Text(verbatim: text.isEmpty ? placeholder : text)
                    .foregroundStyle(text.isEmpty ? p.fg3 : p.fg)
                    .frame(maxWidth: .infinity, alignment: center ? .center : .leading)
            } else {
                TextField(placeholder, text: $text)
                    .textFieldStyle(.plain)
                    .multilineTextAlignment(center ? .center : .leading)
                    .onSubmit(submit)
                    .accessibilityLabel(Text(verbatim: name))
            }
        }
        .font(monospaced ? .system(size: 12, weight: .medium).monospacedDigit() : .system(size: 12, weight: .medium))
        .frame(width: width)
        .padding(.horizontal, 10).padding(.vertical, 6)
        .background(RoundedRectangle(cornerRadius: 9, style: .continuous).fill(p.subtle2))
        .overlay(RoundedRectangle(cornerRadius: 9, style: .continuous).strokeBorder(p.cardBorder))
    }
}

/// A setting's name and a line saying what it does, above its control.
struct Setting<Content: View>: View {
    @Environment(\.colorScheme) private var scheme
    let title: String
    let hint: String
    @ViewBuilder var content: () -> Content
    var body: some View {
        let p = Palette(scheme)
        VStack(alignment: .leading, spacing: 0) {
            Text(verbatim: title).font(.system(size: 12, weight: .semibold))
            Text(verbatim: hint).font(.system(size: 11)).foregroundStyle(p.fg3)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 2).padding(.bottom, 7)
            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - Panel

enum PanelPage: Int { case home = 1, contacts, away }

/// What Home shows under its tiles: one section at a time, so the panel stays short.
enum HomeSection { case waiting, listening, sent }

/// The Contacts tab's filter: everything, or only the chats Claude may (or may not) listen to.
enum ContactFilter: String, CaseIterable {
    case all = "All"
    case on = "Listening"
    case off = "Not listening"
}

struct PanelView: View {
    static let width: CGFloat = 392

    @EnvironmentObject var store: Store
    @Environment(\.colorScheme) private var scheme
    @State private var page: PanelPage = snapshotPage
    @State private var section: HomeSection = snapshotSection
    @State private var query = ""
    @State private var filter: ContactFilter = .all
    @FocusState private var searchFocused: Bool

    private var p: Palette { Palette(scheme) }

    /// macOS doesn't keep a menu bar panel on screen: a long draft (opened with Show all), or many of
    /// them, pushed the buttons below the bottom of the screen. So the panel is at most as tall as
    /// the screen, and the middle scrolls; the header (status, tabs) and footer stay put.
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 12) {
                header
                tabs
                if page == .contacts { contactTools }
                if let flash = store.flash { flashBanner(flash) }
            }
            .padding(.horizontal, 18).padding(.top, 18).padding(.bottom, 12)
            middle
            footer
                .padding(.horizontal, 18).padding(.top, 8).padding(.bottom, 12)
        }
        .frame(width: Self.width)
        .frame(maxHeight: maxPanelHeight)
        // MenuBarExtra sizes its window to the content's minimum height, and a ScrollView's is 0;
        // pin it to the ideal height instead (the content's, capped by the frame above).
        .fixedSize(horizontal: false, vertical: true)
        .foregroundStyle(p.fg)
        .background(PanelBackground())
        .background(shortcuts)
        .onExitCommand(perform: escape)
        .onChange(of: store.state?.approvals.count ?? 0) { old, new in
            // A new draft needs you more than whatever was open.
            if new > old, page == .home { withAnimation(.easeOut(duration: 0.15)) { section = .waiting } }
        }
    }

    /// A ScrollView is as tall as its content until the panel's height cap squeezes it.
    @ViewBuilder private var middle: some View {
        if isSnapshot {
            // The offscreen snapshot renderer draws a ScrollView blank; this sizes the same, and clips.
            content.fixedSize(horizontal: false, vertical: true)
                .frame(minHeight: 0, maxHeight: .infinity, alignment: .top).clipped()
        } else {
            ScrollView(.vertical) { content }.scrollBounceBehavior(.basedOnSize)
        }
    }

    /// The screen the panel is on, below the menu bar and above the Dock, less a small gap.
    private var maxPanelHeight: CGFloat {
        let forced = ProcessInfo.processInfo.environment["SNAPSHOT_SCREEN_HEIGHT"].flatMap(Double.init) // for snapshots
        let visible = forced.map { CGFloat($0) } ?? (NSScreen.main ?? NSScreen.screens.first)?.visibleFrame.height ?? 800
        return max(300, visible - 16)
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let state = store.state, store.reachable {
                if let err = state.configError { Banner(icon: "triangle-alert", tone: .bad, text: err) }
                switch page {
                case .home: home(state)
                case .contacts:
                    ContactsList(contacts: state.contacts, query: query, filter: filter,
                                 defaultPolicy: state.defaultPolicy ?? "approve", waiting: state.approvals.count) {
                        page = .home
                        section = .waiting
                    }
                case .away:
                    if let away = state.away {
                        AwayEditor(away: away, name: state.telegram.me?.name, footer: state.footer)
                    } else {
                        EmptyRow(icon: "moon", title: "Away needs a newer daemon", text: Away.olderDaemon).card()
                    }
                }
            } else {
                offline(store.problem ?? "Connecting to the daemon\u{2026}")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 18).padding(.bottom, 4)
    }

    // MARK: Header

    /// The logo, the name, the connection status and the Rules and Log buttons. The status gets all the
    /// width the buttons leave (two lines if it needs them), so a long name is never cut off.
    private var header: some View {
        let status = store.status
        return HStack(alignment: .center, spacing: 12) {
            ZStack {
                Circle().fill(p.card)
                Circle().strokeBorder(p.cardBorder)
                ScaledShape(shape: Brand.plane, box: 100).fill(Brand.gradient)
                    .frame(width: 24, height: 24).offset(x: -0.5, y: 0.5)
            }
            .frame(width: 42, height: 42)
            .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                Text("Telegram MCP").font(.system(size: 16, weight: .semibold))
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Circle().fill(p.health(status.health)).frame(width: 7, height: 7)
                        .alignmentGuide(.firstTextBaseline) { $0[.bottom] - 1 }
                    Text(verbatim: status.text)
                        .font(.system(size: 11))
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(.leading, 7).padding(.trailing, 9).padding(.vertical, 3)
                .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(p.wash(p.health(status.health))))
                .help(status.text)
                .accessibilityElement(children: .combine)
                .accessibilityLabel(Text(verbatim: "Status: \(status.text)"))
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .layoutPriority(1)
            HStack(spacing: 8) {
                RoundButton(icon: "settings", label: "Rules", help: "Rules: open config.json, where every chat\u{2019}s rules live") {
                    store.openFile("config.json")
                }
                RoundButton(icon: "scroll-text", label: "Log", help: "Log: open daemon.log, for when something looks wrong") {
                    store.openFile("daemon.log")
                }
            }
            .fixedSize()
        }
    }

    /// Home (drafts, listening, sent), Contacts (each chat's rules) and Away (the away auto-reply).
    private var tabs: some View {
        let waiting = store.reachable ? (store.state?.approvals.count ?? 0) : 0
        let away = Away.badge(store.state?.away) != nil
        return HStack(spacing: 2) {
            tab(.home, "Home", icon: "house", key: "1", help: "Home: drafts waiting, who\u{2019}s listening, what was sent (\u{2318}1)") {
                if waiting > 0 { CountBadge(count: waiting) }
            }
            tab(.contacts, "Contacts", icon: "users", key: "2", help: "Contacts: each chat\u{2019}s rules, and who Claude may listen to (\u{2318}2)") {
                EmptyView()
            }
            tab(.away, "Away", icon: "moon", key: "3", help: "Away: one reply for you while you\u{2019}re off (\u{2318}3)") {
                // Green while away replies can go out.
                if away {
                    Circle().fill(p.green).frame(width: 7, height: 7).accessibilityLabel(Text("away now"))
                }
            }
        }
        .padding(3)
        .background(Capsule().fill(p.subtle))
        .overlay(Capsule().strokeBorder(p.cardBorder))
    }

    private func tab<Extra: View>(_ target: PanelPage, _ title: String, icon: String, key: KeyEquivalent, help: String,
                                  @ViewBuilder extra: () -> Extra) -> some View {
        let on = page == target
        return Button {
            withAnimation(.easeOut(duration: 0.12)) { page = target }
        } label: {
            HStack(spacing: 6) {
                LucideIcon(icon, size: 14)
                Text(verbatim: title).font(.system(size: 12, weight: .semibold)).lineLimit(1)
                extra()
            }
            .foregroundStyle(on ? Color.white : p.fg2)
            .frame(maxWidth: .infinity, minHeight: 28)
            .background(Capsule().fill(on ? p.accentFill : Color.clear))
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .keyboardShortcut(key, modifiers: .command)
        .help(help)
        .accessibilityLabel(Text(verbatim: title))
        .accessibilityAddTraits(on ? .isSelected : [])
    }

    /// Contacts: the search box, the filter, and a line saying what the tab is for.
    private var contactTools: some View {
        let contacts = store.state?.contacts ?? []
        let listening = contacts.filter { store.listens($0) }.count
        return VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                LucideIcon("search", size: 15).foregroundStyle(p.fg3)
                if isSnapshot {
                    Text("Search by nickname, name, @username or id").foregroundStyle(p.fg3)
                } else {
                    TextField("Search by nickname, name, @username or id", text: $query)
                        .textFieldStyle(.plain)
                        .focused($searchFocused)
                        .accessibilityLabel(Text("Search contacts"))
                }
                Spacer(minLength: 0)
                if !query.isEmpty {
                    Button { query = "" } label: { LucideIcon("x", size: 13).foregroundStyle(p.fg3) }
                        .buttonStyle(.plain).help("Clear (Esc)").accessibilityLabel(Text("Clear search"))
                }
            }
            .font(.system(size: 12))
            .padding(.horizontal, 12).padding(.vertical, 8)
            .background(Capsule().fill(p.subtle))
            .overlay(Capsule().strokeBorder(p.cardBorder))
            HStack(spacing: 8) {
                Segments(options: ContactFilter.allCases.map {
                    Segments.Option(title: $0.rawValue, value: $0.rawValue, fill: p.accentFill,
                                    help: $0 == .all ? "Every saved chat" : $0 == .on ? "Chats Claude may listen to" : "Chats Claude can\u{2019}t listen to")
                }, selected: filter.rawValue) { v in filter = ContactFilter(rawValue: v) ?? .all }
                Spacer(minLength: 0)
            }
            Text(verbatim: "\(contacts.count) saved \u{00B7} Claude may listen to \(listening) \u{00B7} changes save to config.json at once")
                .font(.system(size: 11)).foregroundStyle(p.fg3).lineLimit(1)
        }
    }

    /// What just happened: a green check when it worked, a red warning when it didn't.
    private func flashBanner(_ text: String) -> some View {
        Banner(icon: store.flashOK ? "circle-check" : "triangle-alert", tone: store.flashOK ? .good : .bad, text: text)
            .transition(.opacity)
    }

    private var footer: some View {
        HStack(spacing: 8) {
            FooterButton(icon: "rotate-cw", title: "Restart", help: "Restart the daemon (launchd starts it again)") { store.restartDaemon() }
            Text("Esc closes \u{00B7} \u{2318}1\u{2013}3 tabs \u{00B7} \u{2318}F find")
                .font(.system(size: 10)).foregroundStyle(p.fg3).lineLimit(1).minimumScaleFactor(0.8)
            Spacer(minLength: 4)
            FooterButton(icon: "power", title: "Quit", help: "Quit the menu bar app (the daemon keeps running)") { NSApp.terminate(nil) }
        }
    }

    /// ⌘F: find a contact. A button nobody sees, so the shortcut works from any tab.
    private var shortcuts: some View {
        Button("Find a contact") {
            page = .contacts
            DispatchQueue.main.async { searchFocused = true }
        }
        .keyboardShortcut("f", modifiers: .command)
        .opacity(0)
        .frame(width: 0, height: 0)
        .accessibilityHidden(true)
    }

    /// Esc clears the search first, then closes the panel.
    private func escape() {
        if page == .contacts && !query.isEmpty {
            query = ""
        } else {
            NSApp.keyWindow?.close()
        }
    }

    private func offline(_ problem: String) -> some View {
        VStack(spacing: 10) {
            Disc(icon: "unplug", size: 44)
            Text(verbatim: problem).font(.system(size: 12, weight: .semibold)).multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
            Text("This panel checks again every 2 seconds and fills in as soon as the daemon answers.")
                .font(.system(size: 11)).foregroundStyle(p.fg3).multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
            Button("Restart the daemon") { store.restartDaemon() }
                .buttonStyle(Pill(tint: p.accent))
        }
        .frame(maxWidth: .infinity)
        .card(padding: 18)
    }

    // MARK: Home

    @ViewBuilder private func home(_ state: UiState) -> some View {
        if let line = Away.badge(state.away) {
            Button { page = .away } label: {
                Banner(icon: "moon", tone: .info, text: "people who message you privately get one reply saying you\u{2019}re away.", bold: line)
            }
            .buttonStyle(.plain)
            .help("Change the away hours or message")
        }
        tiles(state)
        switch section {
        case .waiting: WaitingSection(items: state.approvals)
        case .listening: ListeningSection { page = .contacts }
        case .sent: SentSection()
        }
    }

    /// Three tiles: each is a count and a word, and picks the section below.
    private func tiles(_ state: UiState) -> some View {
        let waiting = state.approvals.count
        let sessions = store.listening
        let chats = Set(sessions.flatMap { $0.watches.map(\.chatId) }).count
        let live = sessions.filter(\.connected).count
        let paused = store.pausedChats
        let listenChip: (String, Tone) = live > 0
            ? (paused > 0 ? ("\(paused) paused", .warn) : ("\(live) session\(live == 1 ? "" : "s")", .good))
            : (sessions.isEmpty ? "idle" : "session gone", .muted)
        let sent = state.recent.count
        return HStack(spacing: 8) {
            StatTile(title: "Waiting", value: waiting, chip: waiting > 0 ? ("needs you", .warn) : ("all clear", .good),
                     selected: section == .waiting) { pick(.waiting) }
            StatTile(title: "Listening", value: chats, chip: listenChip, selected: section == .listening) { pick(.listening) }
            StatTile(title: "Sent", value: sent, chip: sent > 0 ? ("lately", .info) : ("none yet", .muted),
                     selected: section == .sent) { pick(.sent) }
        }
    }

    private func pick(_ s: HomeSection) {
        withAnimation(.easeOut(duration: 0.12)) { section = s }
    }
}

/// A tile at the top of Home: label, big number, chip. Selected: it's the section showing below.
struct StatTile: View {
    @Environment(\.colorScheme) private var scheme
    let title: String
    let value: Int
    let chip: (String, Tone)
    let selected: Bool
    let action: () -> Void
    var body: some View {
        let p = Palette(scheme)
        Button(action: action) {
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: title).font(.system(size: 11, weight: .semibold)).foregroundStyle(p.fg2)
                Text(verbatim: "\(value)").font(.system(size: 24, weight: .semibold, design: .rounded)).foregroundStyle(p.fg)
                Chip(chip.0, chip.1).padding(.top, 2)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 12).padding(.vertical, 10)
            .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(selected ? p.accentSoft : p.card))
            .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous)
                .strokeBorder(selected ? p.accent.opacity(0.6) : p.cardBorder, lineWidth: selected ? 1.5 : 1))
            .contentShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
        .buttonStyle(.plain)
        .help("Show \(title.lowercased()) below")
        .accessibilityLabel(Text(verbatim: "\(title): \(value), \(chip.0)"))
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

// MARK: - Home: Waiting

struct WaitingSection: View {
    let items: [UiApproval]
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            CardTitle("Waiting for approval", count: items.count)
            if items.isEmpty {
                EmptyRow(icon: "check", tone: .good, title: "You\u{2019}re all caught up",
                         text: "When Claude wants to message a chat that needs your OK, the draft waits here.")
                    .padding(.top, 12)
            }
            ForEach(items) { ApprovalCard(item: $0).padding(.top, 12) }
        }
        .card()
    }
}

/// A draft waiting for approval. A long one opens on click (or Show all), never on hover. An edit
/// of a message Claude sent shows its text now and what it will say; a delete shows the message
/// that would go for everyone.
struct ApprovalCard: View {
    @EnvironmentObject var store: Store
    @Environment(\.colorScheme) private var scheme
    let item: UiApproval
    @State private var expanded = snapshotExpandApprovals
    @State private var nick: String

    init(item: UiApproval) {
        self.item = item
        _nick = State(initialValue: item.suggestedNickname)
    }

    private var p: Palette { Palette(scheme) }
    private var busy: Bool { store.busy.contains(item.id) }
    private var long: Bool { isLongDraft(item.text) || isLongDraft(item.previousText ?? "") }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            top
            if item.isEdit {
                infoLine("pencil", "Edit \(item.messageLabel), which Claude sent earlier").padding(.top, 10)
            } else if item.isDelete {
                infoLine("trash-2", "Delete \(item.messageLabel) for everyone in the chat").padding(.top, 10)
            } else if item.isCreate {
                infoLine("plus", "Create a new chat on your Telegram account").padding(.top, 10)
            }
            message.padding(.top, item.isEdit || item.isDelete || item.isCreate ? 6 : 10)
            infoLine("terminal", "Asked by \(item.sessionLabel)").padding(.top, 8)
            infoLine("info", item.reason).padding(.top, 3).help(item.reason)
            if item.firstTime { firstTime.padding(.top, 10) }
            actions.padding(.top, 10)
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(p.subtle))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(p.orange.opacity(0.4)))
    }

    private var top: some View {
        HStack(alignment: .top, spacing: 10) {
            AvatarView(name: item.nickname ?? item.to, photo: store.avatar(item.chatId))
            VStack(alignment: .leading, spacing: 1) {
                Text(verbatim: item.to).font(.system(size: 13, weight: .semibold)).lineLimit(1)
                Text(verbatim: item.detail).font(.system(size: 11)).foregroundStyle(p.fg3).lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            HStack(spacing: 4) {
                LucideIcon("clock", size: 12)
                Text(verbatim: agoWords(item.createdAt)).font(.system(size: 11))
            }
            .foregroundStyle(p.fg3)
            .padding(.top, 2)
        }
    }

    private var message: some View {
        Button(action: toggle) {
            VStack(alignment: .trailing, spacing: 4) {
                if item.isEdit {
                    labeled("Now", item.previousText ?? "", dim: true)
                    labeled("Will say", item.text, dim: false)
                } else if item.isDelete {
                    bubble(item.text, fill: p.wash(p.red))
                } else {
                    bubble(item.text, fill: p.subtle2)
                }
                if long {
                    Text(expanded ? "Show less" : "Show all")
                        .font(.system(size: 11, weight: .semibold)).foregroundStyle(p.accent)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(item.isEdit ? "The message as the chat sees it now, and the exact new text"
              : item.isDelete ? "The message Claude wants to delete for everyone"
              : item.isCreate ? "The chat Claude wants to create: type, name, username and discussion group"
              : "The exact message Claude wants to send")
        .accessibilityLabel(Text(verbatim: item.isEdit ? "Now: \(item.previousText ?? ""). Will say: \(item.text)"
                                 : item.isDelete ? "Message to delete: \(item.text)"
                                 : item.isCreate ? "Chat to create: \(item.text)" : "Message: \(item.text)"))
        .accessibilityHint(long ? Text(expanded ? "Shows less" : "Shows the whole message") : Text(verbatim: ""))
    }

    private func bubble(_ text: String, fill: Color, dim: Bool = false) -> some View {
        Text(verbatim: text)
            .font(.system(size: 12))
            .foregroundStyle(dim ? p.fg2 : p.fg)
            .lineSpacing(2)
            .lineLimit(expanded ? nil : 4)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 10).padding(.vertical, 8)
            .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(fill))
    }

    /// One side of an edit: "Now" (dimmed) or "Will say", over its text.
    private func labeled(_ title: String, _ text: String, dim: Bool) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(verbatim: title).font(.system(size: 11, weight: .semibold)).foregroundStyle(p.fg3)
            bubble(text, fill: dim ? p.subtle : p.subtle2, dim: dim)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func infoLine(_ icon: String, _ text: String) -> some View {
        HStack(alignment: .top, spacing: 6) {
            LucideIcon(icon, size: 13).padding(.top, 1)
            Text(verbatim: text).font(.system(size: 11)).lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .foregroundStyle(p.fg3)
    }

    /// First message to a chat: say so plainly, and it gets saved under this nickname.
    private var firstTime: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 6) {
                LucideIcon("user-plus", size: 15).foregroundStyle(p.blue)
                Text("First message to this chat").font(.system(size: 12, weight: .semibold))
            }
            Text("Pick how to send it: ask you again next time, or trust this chat and send without asking from now on.")
                .font(.system(size: 11)).foregroundStyle(p.fg2)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 3)
            HStack(spacing: 8) {
                Text("Save as").font(.system(size: 11)).foregroundStyle(p.fg2)
                if let existing = item.nickname {
                    Text(verbatim: existing).font(.system(size: 12, weight: .semibold))
                } else {
                    FieldBox(placeholder: "nickname", text: $nick, name: "Nickname for this chat")
                        .frame(maxWidth: 170)
                        .help("The nickname you\u{2019}ll use for this chat, e.g. \u{201C}send to leo\u{201D}")
                }
                Spacer(minLength: 0)
            }
            .padding(.top, 8)
            // The two ways to send it, side by side under the explanation they answer. The menu bar
            // panel is narrower than the tray's, so they stack when both labels don't fit in full.
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 8) { sendChoices(p) }
                VStack(spacing: 6) { sendChoices(p) }
            }
            .padding(.top, 10)
            .disabled(busy)
        }
        .padding(.horizontal, 10).padding(.vertical, 8)
        .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(p.wash(p.blue)))
    }

    @ViewBuilder private func sendChoices(_ p: Palette) -> some View {
        Button(busy ? "Sending\u{2026}" : "Send, ask next time") { decide(remember: "requireApproval") }
            .buttonStyle(Pill(tint: p.orange, wide: true))
            .help("Send now. Future messages to this chat wait for you too (Ask every time).")
        Button(busy ? "Sending\u{2026}" : "Send, always allow") { decide(remember: "autoSend") }
            .buttonStyle(Pill(tint: .white, fill: Palette.greenFill, wide: true))
            .help("Send now and trust this chat: future messages send without asking")
    }

    /// Deny, and Send for a chat that has a rule (a new chat's two ways to send are in its box above).
    /// An edit offers Deny / Edit, a delete Keep / Delete, a new chat Deny / Create.
    private var actions: some View {
        HStack(spacing: 8) {
            Spacer()
            if item.isEdit {
                Button("Deny") { Task { await store.decide(item.id, approve: false) } }
                    .buttonStyle(Pill(tint: p.red))
                    .help("Leave the message as it is. Claude is told you said no.")
                Button { Task { await store.decide(item.id, approve: true) } } label: {
                    HStack(spacing: 6) {
                        LucideIcon("pencil", size: 13)
                        Text(busy ? "Editing\u{2026}" : "Edit")
                    }
                }
                .buttonStyle(Pill(tint: .white, fill: Palette.greenFill))
                .help("Change the message to the new text now")
            } else if item.isDelete {
                Button("Keep") { Task { await store.decide(item.id, approve: false) } }
                    .buttonStyle(Pill(tint: p.fg2))
                    .help("Keep the message. Claude is told you said no.")
                Button { Task { await store.decide(item.id, approve: true) } } label: {
                    HStack(spacing: 6) {
                        LucideIcon("trash-2", size: 13)
                        Text(busy ? "Deleting\u{2026}" : "Delete")
                    }
                }
                .buttonStyle(Pill(tint: .white, fill: Palette.redFill))
                .help("Delete the message for everyone in the chat now. It can\u{2019}t be undone.")
            } else if item.isCreate {
                Button("Deny") { Task { await store.decide(item.id, approve: false) } }
                    .buttonStyle(Pill(tint: p.red))
                    .help("Don\u{2019}t create it. Claude is told you said no.")
                Button { Task { await store.decide(item.id, approve: true) } } label: {
                    HStack(spacing: 6) {
                        LucideIcon("plus", size: 13)
                        Text(busy ? "Creating\u{2026}" : "Create")
                    }
                }
                .buttonStyle(Pill(tint: .white, fill: Palette.greenFill))
                .help("Create this chat on your account now, exactly as described")
            } else {
                Button("Deny") { Task { await store.decide(item.id, approve: false) } }
                    .buttonStyle(Pill(tint: p.red))
                    .help("Don\u{2019}t send it. Claude is told you said no.")
                if !item.firstTime {
                    Button { Task { await store.decide(item.id, approve: true) } } label: {
                        HStack(spacing: 6) {
                            LucideIcon("send", size: 13)
                            Text(busy ? "Sending\u{2026}" : "Send")
                        }
                    }
                    .buttonStyle(Pill(tint: .white, fill: Palette.greenFill))
                    .help("Send this message now")
                }
            }
        }
        .disabled(busy)
    }

    private func decide(remember: String) {
        Task { await store.decide(item.id, approve: true, remember: remember, nickname: nick) }
    }

    /// A click on a long draft (or on Show all) opens it; another closes it.
    private func toggle() {
        guard long else { return }
        withAnimation(.easeOut(duration: 0.12)) { expanded.toggle() }
    }
}

// MARK: - Home: Listening

/// Who Claude is listening to, with a switch on each chat and on each session, and below it the
/// saved chats Claude may listen to. A chat's switch is its auto-reply: the daemon passes a chat's
/// messages to sessions only while it's on (the watches stay), so off pauses and on resumes.
struct ListeningSection: View {
    @EnvironmentObject var store: Store
    let showContacts: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 0) {
                CardTitle("Listening now")
                if store.listening.isEmpty {
                    EmptyRow(icon: "radio", title: "No one is listening",
                             text: "Ask Claude to watch a chat. It can only watch the chats you switch on below.")
                        .padding(.top, 12)
                } else {
                    Hint(text: "Each switch pauses or resumes a chat for every session listening to it. While it\u{2019}s paused, new messages there aren\u{2019}t passed to Claude; the watch stays.")
                        .padding(.top, 10)
                }
                ForEach(store.listening) { SessionBlock(session: $0).padding(.top, 12) }
            }
            .card()
            MayListenCard(showContacts: showContacts)
        }
    }
}

/// A Claude session and the chats it listens to.
struct SessionBlock: View {
    @EnvironmentObject var store: Store
    @Environment(\.colorScheme) private var scheme
    let session: UiSession

    var body: some View {
        let p = Palette(scheme)
        // The saved chats it listens to: those have a switch. One nickname per chat.
        let names = Array(Set(session.watches.compactMap { store.contact(chatId: $0.chatId)?.nickname })).sorted()
        let anyOn = names.contains { n in store.state?.contacts?.first(where: { $0.nickname == n }).map { store.listens($0) } ?? false }
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                Disc(icon: "terminal", size: 30)
                VStack(alignment: .leading, spacing: 3) {
                    Text(verbatim: session.label).font(.system(size: 12, weight: .semibold)).lineLimit(1)
                    let tag = sessionTag
                    Chip(tag.0, tag.1)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                if names.count > 1 {
                    VStack(spacing: 2) {
                        ListenSwitch(on: anyOn, busy: names.contains { store.busy.contains("contact:\($0)") },
                                     label: "Every chat \(session.label) listens to") { on in
                            Task { await store.setListening(names, on: on, label: "every chat \(session.label) listens to") }
                        }
                        Text("all").font(.system(size: 9, weight: .medium)).foregroundStyle(p.fg3)
                    }
                    .help("Pause or resume every chat this session listens to (other sessions on those chats pause too)")
                }
            }
            VStack(alignment: .leading, spacing: 6) {
                ForEach(session.watches) { WatchRow(watch: $0) }
            }
            .padding(.leading, 40)
        }
    }

    private var sessionTag: (String, Tone) {
        if !session.connected { return ("session gone", .muted) }
        if session.channel { return ("push", .good) }
        if session.monitors > 0 { return ("Monitor on", .good) }
        return (session.pending > 0 ? "Monitor off \u{00B7} \(session.pending) queued" : "Monitor off", .warn)
    }
}

/// One chat a session listens to, with its pause / resume switch.
struct WatchRow: View {
    @EnvironmentObject var store: Store
    @Environment(\.colorScheme) private var scheme
    let watch: WatchSpec

    var body: some View {
        let p = Palette(scheme)
        let contact = store.contact(chatId: watch.chatId)
        // A chat that isn't saved is one handed over with /reply: it's listened to while that lasts.
        let on = contact.map { store.listens($0) } ?? true
        let bits: [String?] = [on ? "listening" : "paused", watch.fromLabel.map { "from \($0)" }, watch.topicId.map { "topic \($0)" },
                               contact == nil ? "not a saved chat" : nil]
        let detail = bits.compactMap { $0 }.joined(separator: " \u{00B7} ")
        HStack(spacing: 8) {
            Circle().fill(on ? p.blue : p.fg3).frame(width: 7, height: 7)
            VStack(alignment: .leading, spacing: 1) {
                Text(verbatim: watch.chatLabel).font(.system(size: 12)).foregroundStyle(on ? p.fg : p.fg2).lineLimit(1)
                Text(verbatim: detail).font(.system(size: 10)).foregroundStyle(p.fg3).lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if let contact {
                ListenSwitch(on: on, busy: store.busy.contains("contact:\(contact.nickname)"),
                             label: on ? "Pause listening to \(watch.chatLabel)" : "Resume listening to \(watch.chatLabel)") { want in
                    Task { await store.setListening([contact.nickname], on: want, label: watch.chatLabel) }
                }
                .help(on ? "Pause: stop passing \(watch.chatLabel)\u{2019}s messages to Claude (turns auto-reply off; the watch stays)"
                         : "Resume: \(watch.chatLabel)\u{2019}s messages reach Claude again (turns auto-reply back on)")
            }
        }
        .help(watch.note ?? watch.chatLabel)
    }
}

/// Every saved chat with its listen switch: pick who Claude may watch, without opening Contacts.
struct MayListenCard: View {
    @EnvironmentObject var store: Store
    @Environment(\.colorScheme) private var scheme
    let showContacts: () -> Void
    @State private var showAll = false
    private static let shortList = 6

    var body: some View {
        let p = Palette(scheme)
        VStack(alignment: .leading, spacing: 0) {
            CardTitle(title: "Chats Claude may listen to") {
                Button("All settings", action: showContacts)
                    .buttonStyle(.plain)
                    .font(.system(size: 11, weight: .semibold)).foregroundStyle(p.accent)
                    .help("Open Contacts for every chat\u{2019}s rules")
            }
            Text("Switch a chat on and a Claude session can watch it and reply there without asking while it does. Off: no session can listen.")
                .font(.system(size: 11)).foregroundStyle(p.fg3)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 4)
            if let contacts = store.state?.contacts {
                if contacts.isEmpty {
                    EmptyRow(icon: "users", title: "No saved chats yet", text: "Approving the first message to a chat saves it.")
                        .padding(.top, 12)
                }
                // Alphabetical, so a row doesn't jump away from the pointer when it's switched.
                let sorted = contacts.sorted { $0.nickname.localizedCaseInsensitiveCompare($1.nickname) == .orderedAscending }
                let shown = showAll ? sorted : Array(sorted.prefix(Self.shortList))
                ForEach(shown) { ContactSwitchRow(contact: $0).padding(.top, 10) }
                if sorted.count > Self.shortList {
                    Button(showAll ? "Show fewer" : "Show all \(sorted.count)") {
                        withAnimation(.easeOut(duration: 0.12)) { showAll.toggle() }
                    }
                    .buttonStyle(.plain)
                    .font(.system(size: 11, weight: .semibold)).foregroundStyle(p.accent)
                    .padding(.top, 10)
                }
            } else {
                Text(verbatim: Store.olderContacts).font(.system(size: 11)).foregroundStyle(p.fg2).padding(.top, 10)
            }
        }
        .card()
    }
}

/// A saved chat and its listen switch, for the list above.
struct ContactSwitchRow: View {
    @EnvironmentObject var store: Store
    @Environment(\.colorScheme) private var scheme
    let contact: UiContact

    var body: some View {
        let p = Palette(scheme)
        let on = store.listens(contact)
        HStack(spacing: 10) {
            AvatarView(name: contact.nickname, glyph: contactGlyph(contact), size: 28, photo: store.avatar(contact.chatId))
            VStack(alignment: .leading, spacing: 1) {
                Text(verbatim: contact.nickname).font(.system(size: 12, weight: .semibold)).lineLimit(1)
                Text(verbatim: on ? listenWords(contact) : "Claude can\u{2019}t listen here")
                    .font(.system(size: 10)).foregroundStyle(p.fg3).lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            ListenSwitch(on: on, busy: store.busy.contains("contact:\(contact.nickname)"),
                         label: "Let Claude listen to \(contact.nickname)") { want in
                Task { await store.setListening([contact.nickname], on: want, label: contact.nickname) }
            }
        }
        .accessibilityElement(children: .contain)
    }
}

/// How listening works out with the chat's sending rule, in a few words.
func listenWords(_ c: UiContact) -> String {
    switch c.sendMode {
    case "requireApproval": return "May listen; replies still ask you"
    case "blocked": return "May listen, but can\u{2019}t reply"
    default: return "May listen and reply without asking"
    }
}

/// Groups, channels and bots get a glyph on their avatar instead of initials.
func contactGlyph(_ c: UiContact) -> String? {
    switch c.type {
    case "group": return "users"
    case "channel": return "megaphone"
    case "bot": return "bot"
    default: return nil
    }
}

// MARK: - Home: Sent

struct SentSection: View {
    @EnvironmentObject var store: Store
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            CardTitle("Recently sent")
            if store.recentChats.isEmpty {
                EmptyRow(icon: "send", title: "Nothing sent yet", text: "Messages Claude sends show up here. Click one to see what went out.")
                    .padding(.top, 12)
            }
            VStack(alignment: .leading, spacing: 2) {
                ForEach(store.recentChats) { RecentChatRow(chat: $0) }
            }
            .padding(.top, 6)
        }
        .card()
    }
}

// MARK: - Contacts tab

/// Every saved chat (`chats` in config.json), each with its listen switch on the row. Click one to
/// change its nickname, which list decides sending there, and paging. Each click saves at once.
struct ContactsList: View {
    @EnvironmentObject var store: Store
    @Environment(\.colorScheme) private var scheme
    let contacts: [UiContact]?
    let query: String
    let filter: ContactFilter
    let defaultPolicy: String
    let waiting: Int
    let showApprovals: () -> Void
    @State private var open: String? = snapshotOpenContact

    var body: some View {
        let p = Palette(scheme)
        VStack(alignment: .leading, spacing: 10) {
            if waiting > 0 {
                HStack(spacing: 8) {
                    LucideIcon("clock", size: 16).foregroundStyle(p.orange)
                    Text(verbatim: "\(waiting) waiting for approval").font(.system(size: 12, weight: .semibold))
                    Spacer()
                    Button("Review", action: showApprovals).buttonStyle(Pill(tint: p.orange))
                }
                .padding(.horizontal, 12).padding(.vertical, 8)
                .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(p.wash(p.orange)))
            }
            if let contacts {
                let shown = filtered(contacts)
                if contacts.isEmpty {
                    EmptyRow(icon: "users", title: "No saved chats yet", text: "Approving the first message to a chat saves it here.").card()
                } else if shown.isEmpty {
                    EmptyRow(icon: "search", title: "Nothing matches", text: emptyText).card()
                }
                ForEach(shown) { ContactRow(contact: $0, defaultPolicy: defaultPolicy, open: $open) }
            } else {
                EmptyRow(icon: "users", title: "Contacts need a newer daemon", text: Store.olderContacts).card()
            }
        }
    }

    private var emptyText: String {
        let q = query.trimmingCharacters(in: .whitespaces)
        switch filter {
        case .all: return "No saved chat matches \u{201C}\(q)\u{201D}."
        case .on: return q.isEmpty ? "Claude may listen to none of your chats. Switch one on to let it." : "No chat Claude may listen to matches \u{201C}\(q)\u{201D}."
        case .off: return q.isEmpty ? "Claude may listen to every saved chat." : "No chat Claude can\u{2019}t listen to matches \u{201C}\(q)\u{201D}."
        }
    }

    private func filtered(_ list: [UiContact]) -> [UiContact] {
        let byFilter = list.filter { c in
            switch filter {
            case .all: return true
            case .on: return c.autoReply
            case .off: return !c.autoReply
            }
        }
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        guard !q.isEmpty else { return byFilter }
        return byFilter.filter { c in
            ([c.nickname, c.name ?? "", c.username.map { "@\($0)" } ?? "", String(c.chatId)] + c.aliases)
                .contains { $0.lowercased().contains(q) }
        }
    }
}

struct ContactRow: View {
    @EnvironmentObject var store: Store
    @Environment(\.colorScheme) private var scheme
    let contact: UiContact
    let defaultPolicy: String
    @Binding var open: String?
    @State private var nick: String
    @State private var reason = ""

    init(contact: UiContact, defaultPolicy: String, open: Binding<String?>) {
        self.contact = contact
        self.defaultPolicy = defaultPolicy
        _open = open
        _nick = State(initialValue: contact.nickname)
    }

    private var p: Palette { Palette(scheme) }
    private var isOpen: Bool { open == contact.nickname }
    private var busy: Bool { store.busy.contains("contact:\(contact.nickname)") }
    private var paging: Bool { store.busy.contains("page:\(contact.nickname)") }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            summary.padding(12)
            if isOpen {
                editor
                    .padding(.horizontal, 14).padding(.bottom, 14)
                    .transition(.opacity)
            }
        }
        .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(p.card))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous)
            .strokeBorder(isOpen ? p.accent.opacity(0.45) : p.cardBorder, lineWidth: isOpen ? 1.5 : 1))
    }

    private func toggleOpen() {
        withAnimation(.easeOut(duration: 0.12)) { open = isOpen ? nil : contact.nickname }
    }

    private var summary: some View {
        HStack(spacing: 10) {
            Button(action: toggleOpen) {
                HStack(spacing: 10) {
                    AvatarView(name: contact.nickname, glyph: contactGlyph(contact), photo: store.avatar(contact.chatId))
                    VStack(alignment: .leading, spacing: 2) {
                        Text(verbatim: contact.nickname).font(.system(size: 13, weight: .semibold)).lineLimit(1)
                        if !subtitle.isEmpty {
                            Text(verbatim: subtitle).font(.system(size: 11)).foregroundStyle(p.fg3).lineLimit(1)
                        }
                        HStack(spacing: 4) {
                            Chip(modeTag.0, modeTag.1)
                            if contact.pagesMe { Chip("can page me", .warn) }
                        }
                        .padding(.top, 3)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help(isOpen ? "Hide this chat\u{2019}s settings" : "Show this chat\u{2019}s settings")
            .accessibilityLabel(Text(verbatim: "\(contact.nickname), \(modeTag.0)"))
            .accessibilityHint(Text(isOpen ? "Hides its settings" : "Shows its settings"))
            VStack(spacing: 2) {
                ListenSwitch(on: store.listens(contact), busy: busy, label: "Let Claude listen to \(contact.nickname)") { want in
                    Task { await store.setListening([contact.nickname], on: want, label: contact.nickname) }
                }
                Text("Listen").font(.system(size: 9, weight: .medium)).foregroundStyle(p.fg3)
            }
            .help("Listen: a Claude session may watch this chat and answer new messages (auto-reply)")
            Button(action: toggleOpen) {
                LucideIcon(isOpen ? "chevron-up" : "chevron-down", size: 13).foregroundStyle(p.fg3)
                    .frame(width: 20, height: 28).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityHidden(true)
        }
    }

    private var editor: some View {
        VStack(alignment: .leading, spacing: 14) {
            Rectangle().fill(p.divider).frame(height: 1)
            // In plain words first: what happens with this chat right now.
            Hint(text: explanation)
            Setting(title: "When Claude sends a message here",
                    hint: "Always allow sends at once; Ask every time waits for you here; Blocked never sends.") {
                Segments(options: [
                    .init(title: "Always allow", value: "autoSend", fill: Palette.greenFill, help: "Send without asking (autoSend)"),
                    .init(title: "Ask every time", value: "requireApproval", fill: Palette.orangeFill, help: "Every message waits for your approval (requireApproval)"),
                    .init(title: "Blocked", value: "blocked", fill: Palette.redFill, help: "Never send here (blocked)"),
                ], selected: contact.sendMode) { save(["sendMode": $0]) }
            }
            if contact.canPage {
                Setting(title: "Can page me", hint: "Their /page rings an alarm on this Mac until you answer it.") {
                    Segments(options: [
                        .init(title: "On", value: "on", fill: Palette.orangeFill, help: "Their \u{201C}/page <reason>\u{201D} rings your desktop until you ack it (paging.pageFrom)"),
                        .init(title: "Off", value: "off", fill: Palette.grayFill, help: "Their /page is ignored"),
                    ], selected: contact.pagesMe ? "on" : "off") { save(["pageFrom": $0 == "on"]) }
                }
                Setting(title: "Page \(contact.nickname)", hint: "Sends them \u{201C}/page <reason>\u{201D} from your account. It rings if you\u{2019}re on their list.") {
                    HStack(spacing: 8) {
                        FieldBox(placeholder: "Reason (optional)", text: $reason, name: "Reason for the page", submit: page)
                        Button(action: page) {
                            HStack(spacing: 6) {
                                LucideIcon("bell-ring", size: 13)
                                Text(paging ? "Paging\u{2026}" : "Page")
                            }
                        }
                        .buttonStyle(Pill(tint: .white, fill: Palette.redFill))
                        .disabled(paging || blocked)
                        .help(blocked ? "Blocked: the daemon won\u{2019}t send here" : "Sends \u{201C}/page <reason>\u{201D} from your account. It rings them if you\u{2019}re on their pageFrom.")
                    }
                }
            }
            Setting(title: "Nickname", hint: "The name you use with Claude, as in \u{201C}send to leo\u{201D}.") {
                HStack(spacing: 8) {
                    FieldBox(placeholder: "nickname", text: $nick, name: "Nickname", submit: rename)
                    Button("Rename", action: rename)
                        .buttonStyle(Pill(tint: p.accent))
                        .disabled(!renamed || busy)
                }
            }
            Text(verbatim: details)
                .font(.system(size: 10)).foregroundStyle(p.fg3)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
        }
        .disabled(busy)
    }

    private func save(_ change: [String: Any]) {
        guard !busy else { return }
        Task { await store.editContact(contact.nickname, change) }
    }

    /// Blocked by its own rule, or on no list while the default blocks: the daemon refuses a page.
    private var blocked: Bool {
        contact.sendMode == "blocked" || (contact.sendMode == "none" && defaultPolicy == "block")
    }

    private func page() {
        guard !paging, !blocked else { return }
        let why = reason
        Task { if await store.pageContact(contact.nickname, reason: why) { reason = "" } }
    }

    private var renamed: Bool {
        let t = nick.trimmingCharacters(in: .whitespacesAndNewlines)
        return !t.isEmpty && t != contact.nickname
    }

    private func rename() {
        guard renamed, !busy else { return }
        let wanted = nick
        Task {
            // The row is keyed by nickname, so keep the renamed one open.
            if let now = await store.editContact(contact.nickname, ["rename": wanted]) { open = now }
        }
    }

    private var subtitle: String {
        [contact.name, contact.username.map { "@\($0)" }].compactMap { $0 }.joined(separator: " \u{00B7} ")
    }

    private var modeTag: (String, Tone) {
        switch contact.sendMode {
        case "autoSend": return ("always allow", .good)
        case "requireApproval": return ("ask every time", .warn)
        case "blocked": return ("blocked", .bad)
        default: return defaultPolicy == "block" ? ("blocked by default", .bad) : ("not set", .muted)
        }
    }

    private var explanation: String {
        let send: String
        switch contact.sendMode {
        case "autoSend": send = "Messages go out without asking."
        case "requireApproval": send = "Every message waits for your approval."
        case "blocked": send = "Nothing is ever sent here."
        default:
            send = defaultPolicy == "block"
                ? "On no list, so the default rule blocks it."
                : "On no list yet: the next message asks you, and you pick what happens after."
        }
        let listen: String
        if !store.listens(contact) { listen = "Claude can\u{2019}t listen to this chat (switch Listen on to let it)." }
        else if contact.sendMode == "requireApproval" { listen = "Claude may listen here, but its replies still ask first." }
        else if contact.sendMode == "blocked" { listen = "Claude may listen here, but can\u{2019}t reply." }
        else { listen = "Claude may listen here and reply without asking while it does." }
        guard contact.canPage else { return "\(send) \(listen)" }
        let page = contact.pagesMe ? "Their /page rings you." : "Their /page is ignored."
        return "\(send) \(listen) \(page)"
    }

    private var details: String {
        var bits = ["id \(contact.chatId)"]
        if let t = contact.topicId { bits.append("topic \(t)") }
        if !contact.aliases.isEmpty { bits.append("aliases: \(contact.aliases.joined(separator: ", "))") }
        if !contact.sameChat.isEmpty {
            bits.append("same chat as \(contact.sameChat.joined(separator: ", ")), so these rules apply to it too")
        }
        if let n = contact.notes, !n.isEmpty { bits.append(n) }
        return bits.joined(separator: " \u{00B7} ")
    }
}

// MARK: - Away page

/// The away auto-reply's words and the same checks the daemon makes (src/shared/away.ts; the tray
/// app's are tray/Core/Away.cs), so a mistake shows before the request. The daemon does the saving.
enum Away {
    static let olderDaemon = "The daemon is older than this app. Restart it (below) to set away hours."
    static let messageMax = 1000
    static let quietMax = 1440

    private static func digits(_ s: Substring) -> Bool { s.allSatisfy { ("0"..."9").contains($0) } }

    /// "HH:MM", 24-hour.
    static func isTime(_ s: String) -> Bool {
        let parts = s.split(separator: ":", omittingEmptySubsequences: false)
        guard s.count == 5, parts.count == 2, parts.allSatisfy({ $0.count == 2 && digits($0) }),
              let h = Int(parts[0]), let m = Int(parts[1]) else { return false }
        return h < 24 && m < 60
    }

    /// Quiet minutes as typed: a whole number from 0 to a day, or nil.
    static func quiet(_ s: String) -> Int? {
        let t = s.trimmingCharacters(in: .whitespaces)
        guard !t.isEmpty, t.count <= 4, digits(Substring(t)), let n = Int(t), n <= quietMax else { return nil }
        return n
    }

    /// The first problem, in the daemon's words, or nil when the fields are fine.
    static func check(_ f: AwayFields) -> String? {
        if !isTime(f.from) { return "from must be a time like 18:00" }
        if !isTime(f.until) { return "until must be a time like 18:00" }
        if f.from == f.until { return "From and until can't be the same time." }
        if f.message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return "The message can't be empty." }
        if f.message.count > messageMax { return "The message is too long (\(messageMax) characters at most)." }
        if quiet(f.quiet) == nil { return "quietMinutes must be a whole number from 0 to \(quietMax)" }
        return nil
    }

    private static let clockFormat: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "HH:mm"
        return f
    }()

    /// "09:00", or "09:00 tomorrow" when the change isn't today. Falls back to the saved time.
    private static func when(_ iso: String?, or fallback: String) -> String {
        guard let iso, let date = isoWithFraction.date(from: iso) ?? ISO8601DateFormatter().date(from: iso) else { return fallback }
        let time = clockFormat.string(from: date)
        return Calendar.current.isDateInToday(date) ? time : "\(time) tomorrow"
    }

    /// Whether it's on, and if so whether it's away now and when that changes.
    static func status(_ a: UiAway) -> String {
        if !a.enabled { return "Off" }
        if a.active { return "Away now, until \(when(a.nextChange, or: a.until))" }
        return "On, starts at \(when(a.nextChange, or: a.from))"
    }

    /// The line for Home while a reply could go out; nil otherwise.
    static func badge(_ a: UiAway?) -> String? {
        guard let a, a.enabled, a.active else { return nil }
        return "Away until \(a.until)"
    }

    /// What the typed message would send: {name} becomes the first word of your name (left as is when
    /// it's unknown), then the footer, unless the text already ends with it (withFooter in src/shared/policy.ts).
    static func preview(_ message: String, name: String?, footer: String) -> String {
        let first: String? = name?.split(whereSeparator: { $0.isWhitespace }).first.map { String($0) }
        let text = first.map { message.replacingOccurrences(of: "{name}", with: $0) } ?? message
        let mark = footer.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !mark.isEmpty else { return text }
        var body = text
        while let last = body.last, last.isWhitespace { body.removeLast() }
        return body.hasSuffix(mark) ? body : body + footer
    }
}

/// The Away page's typed fields, all text as typed. Quiet minutes are text too, so a half-typed number shows its error.
struct AwayFields: Equatable {
    var from: String
    var until: String
    var message: String
    var quiet: String

    /// As it would be sent: times trimmed, quiet minutes as a plain number.
    var cleaned: AwayFields {
        AwayFields(from: from.trimmingCharacters(in: .whitespaces), until: until.trimmingCharacters(in: .whitespaces),
                   message: message, quiet: Away.quiet(quiet).map { String($0) } ?? quiet)
    }
}

extension AwayFields {
    init(_ a: UiAway) { self.init(from: a.from, until: a.until, message: a.message, quiet: String(a.quietMinutes)) }
}

/// The away auto-reply. The switch saves at once; the hours, quiet minutes and message wait for Save, so a
/// half-typed time never goes out. The fields are filled when the tab opens: polling leaves them alone.
struct AwayEditor: View {
    @EnvironmentObject var store: Store
    @Environment(\.colorScheme) private var scheme
    let away: UiAway
    let name: String?
    let footer: String
    @State private var typed: AwayFields
    /// What the daemon has saved as far as this tab knows: as loaded, then as last sent. Save sends only what differs.
    @State private var saved: AwayFields

    init(away: UiAway, name: String?, footer: String) {
        self.away = away
        self.name = name
        self.footer = footer
        _typed = State(initialValue: AwayFields(away))
        _saved = State(initialValue: AwayFields(away))
    }

    private var p: Palette { Palette(scheme) }
    private var busy: Bool { store.busy.contains("away") }
    private var problem: String? { Away.check(typed.cleaned) }
    private var changed: Bool { typed.cleaned != saved }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .center, spacing: 12) {
                Disc(icon: "moon", tone: away.active ? .info : nil, size: 36)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Reply while I\u{2019}m away").font(.system(size: 13, weight: .semibold))
                    Text(verbatim: Away.status(away)).font(.system(size: 11)).foregroundStyle(away.active ? p.blue : p.fg3)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                if isSnapshot {
                    SnapshotSwitch(on: away.enabled, tint: Palette.greenFill)
                } else {
                    Toggle(isOn: Binding(get: { away.enabled }, set: { toggle($0) })) { Text("Reply while I\u{2019}m away") }
                        .toggleStyle(.switch)
                        .labelsHidden()
                        .tint(Palette.greenFill)
                        .disabled(busy)
                        .help("Saves as soon as you switch it")
                }
            }
            // In plain words first: what happens, and who never gets it.
            Hint(text: "When it\u{2019}s on, someone who messages you privately during these hours gets this reply, once a night. Groups, bots, Blocked and Ask every time chats, and chats Claude is handling, never do.")
            Setting(title: "Hours", hint: "This Mac\u{2019}s time. Overnight works, like 18:00 until 09:00.") {
                HStack(spacing: 8) {
                    Text("From").font(.system(size: 12)).foregroundStyle(p.fg2)
                    FieldBox(placeholder: "HH:MM", text: $typed.from, width: 52, center: true, monospaced: true, name: "Away from")
                    Text("until").font(.system(size: 12)).foregroundStyle(p.fg2)
                    FieldBox(placeholder: "HH:MM", text: $typed.until, width: 52, center: true, monospaced: true, name: "Away until")
                }
            }
            Setting(title: "Quiet after you write",
                    hint: "No away reply in a chat for this long after anything is sent from your account there, by you or by Claude. 0 turns this off.") {
                HStack(spacing: 8) {
                    FieldBox(placeholder: "30", text: $typed.quiet, width: 44, center: true, monospaced: true, name: "Quiet minutes")
                    Text("minutes").font(.system(size: 12)).foregroundStyle(p.fg2)
                }
            }
            Setting(title: "Message", hint: "{name} becomes your first name.") { messageBox }
            Setting(title: "Preview", hint: "What they get, footer included.") {
                Text(verbatim: Away.preview(typed.message, name: name, footer: footer))
                    .font(.system(size: 12))
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 10).padding(.vertical, 7)
                    .background(UnevenRoundedRectangle(topLeadingRadius: 12, bottomLeadingRadius: 4, bottomTrailingRadius: 12,
                                                       topTrailingRadius: 12, style: .continuous).fill(p.accentSoft))
            }
            if let problem {
                HStack(alignment: .top, spacing: 6) {
                    LucideIcon("triangle-alert", size: 14).padding(.top, 1)
                    Text(verbatim: problem).font(.system(size: 11)).fixedSize(horizontal: false, vertical: true)
                }
                .foregroundStyle(p.red)
            }
            HStack(spacing: 8) {
                Text(changed ? "Not saved yet." : "Hours, quiet minutes and message save with Save.")
                    .font(.system(size: 11)).foregroundStyle(changed ? p.orange : p.fg3)
                Spacer(minLength: 4)
                Button(busy ? "Saving\u{2026}" : "Save", action: save)
                    .buttonStyle(Pill(tint: .white, fill: p.accentFill))
                    .disabled(busy || problem != nil || !changed)
                    .keyboardShortcut("s", modifiers: .command)
                    .help("Save the hours, quiet minutes and message (\u{2318}S)")
            }
        }
        .card()
    }

    @ViewBuilder private var messageBox: some View {
        Group {
            if isSnapshot {
                Text(verbatim: typed.message).fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                TextEditor(text: $typed.message)
                    .scrollContentBackground(.hidden)
                    .frame(minHeight: 60, maxHeight: 130)
                    .accessibilityLabel(Text("Away message"))
            }
        }
        .font(.system(size: 12))
        .padding(7)
        .background(RoundedRectangle(cornerRadius: 9, style: .continuous).fill(p.subtle2))
        .overlay(RoundedRectangle(cornerRadius: 9, style: .continuous).strokeBorder(p.cardBorder))
    }

    private func toggle(_ on: Bool) {
        guard on != away.enabled, !busy else { return }
        Task { await store.saveAway(["enabled": on]) }
    }

    private func save() {
        guard !busy, problem == nil else { return }
        let sent = typed.cleaned
        var change: [String: Any] = [:]
        if sent.from != saved.from { change["from"] = sent.from }
        if sent.until != saved.until { change["until"] = sent.until }
        if sent.message != saved.message { change["message"] = sent.message }
        if sent.quiet != saved.quiet, let q = Away.quiet(sent.quiet) { change["quietMinutes"] = q }
        guard !change.isEmpty else { return }
        Task {
            guard await store.saveAway(change) else { return }
            saved = sent
            // Show the cleaned-up values, unless they were typed over during the round trip.
            if typed.cleaned == sent { typed = sent }
        }
    }
}

/// A chat sent to lately. Click it to show (or hide) what was sent; nothing opens on hover.
struct RecentChatRow: View {
    @EnvironmentObject var store: Store
    @Environment(\.colorScheme) private var scheme
    let chat: RecentChat
    @State private var open = snapshotExpandRecent

    var body: some View {
        let p = Palette(scheme)
        VStack(alignment: .leading, spacing: 8) {
            Button {
                withAnimation(.easeOut(duration: 0.12)) { open.toggle() }
            } label: {
                HStack(spacing: 10) {
                    AvatarView(name: chat.label, photo: store.avatar(chat.id))
                    VStack(alignment: .leading, spacing: 1) {
                        Text(verbatim: chat.label).font(.system(size: 12, weight: .semibold)).lineLimit(1)
                        Text(verbatim: summary).font(.system(size: 11)).foregroundStyle(p.fg3).lineLimit(1)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    LucideIcon(open ? "chevron-up" : "chevron-down", size: 13).foregroundStyle(p.fg3)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help(open ? "Hide what was sent" : "Show what was sent")
            .accessibilityLabel(Text(verbatim: "\(chat.label), \(summary)"))
            .accessibilityHint(Text(open ? "Hides what was sent" : "Shows what was sent"))
            if open {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(chat.messages.prefix(3)) { m in
                        VStack(alignment: .leading, spacing: 3) {
                            Text(verbatim: store.body(m.text)).font(.system(size: 12)).fixedSize(horizontal: false, vertical: true)
                            Text(verbatim: "\(agoWords(m.at)) \u{00B7} \(viaLabel(m.via))\(m.sessionLabel.map { " \u{00B7} \($0)" } ?? "")\(m.edited.map { " \u{00B7} edited \(agoWords($0.at))" } ?? "")")
                                .font(.system(size: 10)).foregroundStyle(p.fg3)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 10).padding(.vertical, 7)
                        .background(UnevenRoundedRectangle(topLeadingRadius: 12, bottomLeadingRadius: 4, bottomTrailingRadius: 12,
                                                           topTrailingRadius: 12, style: .continuous).fill(p.accentSoft))
                    }
                }
                .padding(.leading, 44)
                .transition(.opacity)
            }
        }
        .padding(.horizontal, 8).padding(.vertical, 6)
        .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(open ? p.subtle : Color.clear))
        .padding(.horizontal, -8)
    }

    /// "3 messages · last sent 5m ago".
    private var summary: String {
        let n = chat.messages.count
        return "\(n == 1 ? "1 message" : "\(n) messages") \u{00B7} last sent \(agoWords(chat.messages[0].at))"
    }

    private func viaLabel(_ via: String) -> String {
        switch via {
        case "auto": return "auto-sent"
        case "away": return "away reply"
        case "menubar": return "approved in menu bar"
        case "dialog": return "approved in dialog"
        default: return "approved in chat"
        }
    }
}

// MARK: - Menu bar icon

/// What the menu bar icon shows: the plane coloured by health, a green dot while a session listens,
/// and a badge (the count of drafts waiting on amber, or "!" when something is down).
struct IconState: Equatable {
    let health: Health
    let listening: Bool
    let badge: String?
    /// The badge counts drafts waiting (amber), not a problem.
    var pending = false
}

/// The menu bar icon, drawn like the tray's: the app's paper plane in Telegram blue online, yellow
/// reconnecting, red logged out and grey offline; a green dot on its top right while a session listens;
/// and a badge on its lower right. A clear ring separates the dot and badge from the plane. It's in
/// colour (not a template image), so the status colours mean the same on every menu bar.
enum MenuBarIcon {
    private static func rgb(_ v: UInt32) -> NSColor {
        NSColor(srgbRed: CGFloat((v >> 16) & 0xFF) / 255, green: CGFloat((v >> 8) & 0xFF) / 255,
                blue: CGFloat(v & 0xFF) / 255, alpha: 1)
    }

    // The tray's status colours (Theme.Status in tray/App/Theme.cs).
    static let brand = rgb(0x2AA3E0)
    static let offline = rgb(0x8E8E93)
    static let online = rgb(0x2FC97A)
    static let pending = rgb(0xFFA814)
    static let reconnecting = rgb(0xF0C41B)
    static let error = rgb(0xE53E3E)
    static let ink = rgb(0x1E1A17)

    static func planeColour(_ h: Health) -> NSColor {
        switch h {
        case .good: return brand
        case .busy: return reconnecting
        case .bad: return error
        case .off: return offline
        }
    }

    static func image(_ s: IconState) -> NSImage {
        let size = NSSize(width: s.badge == nil ? 19 : 24, height: 18)
        let image = NSImage(size: size, flipped: true) { rect in
            guard let ctx = NSGraphicsContext.current?.cgContext else { return false }
            var t = CGAffineTransform(translationX: 0.5, y: 1).scaledBy(x: 0.165, y: 0.165)
            if let plane = Brand.plane.cgPath.copy(using: &t) {
                ctx.addPath(plane)
                ctx.setFillColor(planeColour(s.health).cgColor)
                ctx.fillPath()
            }
            if s.listening {
                let dot = CGRect(x: 12.5, y: 0.5, width: 6, height: 6)
                ctx.setBlendMode(.clear)
                ctx.fillEllipse(in: dot.insetBy(dx: -1.3, dy: -1.3))
                ctx.setBlendMode(.normal)
                ctx.setFillColor(online.cgColor)
                ctx.fillEllipse(in: dot)
            }
            guard let badge = s.badge else { return true }

            let font = NSFont.systemFont(ofSize: 8.5, weight: .heavy)
            let colour: NSColor = s.pending ? pending : s.health == .busy ? reconnecting : error
            let textColour: NSColor = s.pending || s.health == .busy ? ink : .white
            let attrs: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: textColour]
            let textSize = (badge as NSString).size(withAttributes: attrs)
            let height: CGFloat = 10.5
            let width = max(height, textSize.width + 4.5)
            let pill = NSRect(x: rect.width - width, y: rect.height - height, width: width, height: height)

            ctx.setBlendMode(.clear) // gap between badge and plane
            NSBezierPath(roundedRect: pill.insetBy(dx: -1.4, dy: -1.4), xRadius: height / 2 + 1.4, yRadius: height / 2 + 1.4).fill()
            ctx.setBlendMode(.normal)
            colour.setFill()
            NSBezierPath(roundedRect: pill, xRadius: height / 2, yRadius: height / 2).fill()
            (badge as NSString).draw(
                at: NSPoint(x: pill.midX - textSize.width / 2, y: pill.midY - textSize.height / 2 - 0.3),
                withAttributes: attrs)
            return true
        }
        image.isTemplate = false
        image.accessibilityDescription = "Telegram MCP"
        return image
    }

    static func badgeText(_ n: Int) -> String { n > 99 ? "99+" : "\(n)" }
}

struct MenuIcon: View {
    @ObservedObject var store: Store

    var body: some View {
        let s = store.iconState
        Image(nsImage: MenuBarIcon.image(s))
            .renderingMode(.original)
            .accessibilityLabel(Text(verbatim: store.iconDescription))
    }
}

/// `--icons out.png`: every icon state, on a tinted, a dark and a light menu bar.
@MainActor
enum IconPreview {
    static func run(to path: String) {
        _ = NSApplication.shared
        let states: [IconState] = [
            IconState(health: .good, listening: false, badge: nil),
            IconState(health: .good, listening: true, badge: nil),
            IconState(health: .good, listening: false, badge: "1", pending: true),
            IconState(health: .good, listening: true, badge: "12", pending: true),
            IconState(health: .busy, listening: false, badge: "!"),
            IconState(health: .bad, listening: false, badge: "!"),
            IconState(health: .off, listening: false, badge: "!"),
        ]
        let scale: CGFloat = 6
        let cell = NSSize(width: 34, height: 24)
        let bars: [NSColor] = [
            NSColor(srgbRed: 0.27, green: 0.20, blue: 0.62, alpha: 1), // tinted
            NSColor(white: 0.12, alpha: 1),
            NSColor(white: 0.93, alpha: 1),
        ]
        let size = NSSize(width: cell.width * CGFloat(states.count) * scale, height: cell.height * CGFloat(bars.count) * scale)
        let out = NSImage(size: size, flipped: false) { _ in
            for (row, bar) in bars.enumerated() {
                let y = CGFloat(bars.count - 1 - row) * cell.height * scale
                bar.setFill()
                NSRect(x: 0, y: y, width: size.width, height: cell.height * scale).fill()
                for (col, state) in states.enumerated() {
                    let icon = MenuBarIcon.image(state)
                    let w = icon.size.width * scale, h = icon.size.height * scale
                    let x = CGFloat(col) * cell.width * scale + (cell.width * scale - w) / 2
                    icon.draw(in: NSRect(x: x, y: y + (cell.height * scale - h) / 2, width: w, height: h))
                }
            }
            return true
        }
        if let tiff = out.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
           let png = rep.representation(using: .png, properties: [:]) {
            try? png.write(to: URL(fileURLWithPath: path))
            print("wrote \(path)")
        }
    }
}

// MARK: - Pages

/// The on-call alarm: a looping tone and a window above everything, on every Space, until you
/// ack or snooze. It plays the sound itself, since a notification sound plays once and Focus can
/// silence it.
@MainActor
final class PageAlarm {
    private var player: AVAudioPlayer?
    private var panel: NSPanel?

    func update(ringing: [UiPage], store: Store) {
        guard !ringing.isEmpty else {
            player?.stop()
            player = nil
            panel?.orderOut(nil)
            return
        }
        if player == nil, let p = Self.player(home: store.home) {
            p.numberOfLoops = -1
            p.volume = 1
            p.play()
            player = p
        }
        let panel = self.panel ?? makePanel(store: store)
        self.panel = panel
        let showing = panel.isVisible
        // SwiftUI lays the new pages out on the next pass; size the panel to them after that.
        DispatchQueue.main.async {
            Self.fit(panel)
            if !showing {
                panel.center()
                panel.orderFrontRegardless()
            }
        }
    }

    /// The panel follows its content: taller for another page, shorter when one is acked, and
    /// never taller than the screen. The top edge stays put, so the buttons don't jump.
    static func fit(_ panel: NSPanel) {
        guard let content = panel.contentView else { return }
        let screen = (panel.screen ?? NSScreen.main)?.visibleFrame.height ?? 800
        let size = NSSize(width: PageAlarmView.width, height: min(content.fittingSize.height, screen - 40))
        let current = panel.contentRect(forFrameRect: panel.frame).size
        guard abs(current.height - size.height) > 0.5 || abs(current.width - size.width) > 0.5 else { return }
        var frame = panel.frameRect(forContentRect: NSRect(origin: .zero, size: size))
        frame.origin = NSPoint(x: panel.frame.minX, y: panel.frame.maxY - frame.height)
        panel.setFrame(frame, display: true)
    }

    /// Your own sound if there is one (alarm.mp3, .m4a, .wav, .aiff or .caf in the home folder),
    /// else the built-in beep. Read on each new page, so a new file needs no restart.
    static func player(home: URL) -> AVAudioPlayer? {
        for ext in ["mp3", "m4a", "wav", "aiff", "caf"] {
            let url = home.appendingPathComponent("alarm.\(ext)")
            if FileManager.default.isReadableFile(atPath: url.path), let p = try? AVAudioPlayer(contentsOf: url) { return p }
        }
        return try? AVAudioPlayer(data: AlarmTone.wav, fileTypeHint: AVFileType.wav.rawValue)
    }

    private func makePanel(store: Store) -> NSPanel {
        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: PageAlarmView.width, height: 220),
            styleMask: [.titled, .fullSizeContentView, .nonactivatingPanel],
            backing: .buffered, defer: false)
        panel.titleVisibility = .hidden
        panel.titlebarAppearsTransparent = true
        panel.isFloatingPanel = true
        panel.level = .screenSaver
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        panel.hidesOnDeactivate = false
        panel.isMovableByWindowBackground = true
        // The panel is sized by fit(), not by the hosting view, which would only ever grow it.
        let host = NSHostingView(rootView: PageAlarmView().environmentObject(store))
        host.sizingOptions = []
        panel.contentView = host
        return panel
    }
}

/// A two-tone pager beep, made here so the app needs no sound file.
enum AlarmTone {
    static let wav: Data = {
        let rate = 44_100
        var samples: [Int16] = []
        func tone(_ hz: Double, _ seconds: Double) {
            let n = Int(Double(rate) * seconds)
            for i in 0..<n {
                let fade = min(1, Double(i) / 300, Double(n - i) / 300)
                samples.append(Int16(sin(2 * .pi * hz * Double(i) / Double(rate)) * fade * 0.85 * 32_767))
            }
        }
        func silence(_ seconds: Double) { samples += Array(repeating: 0, count: Int(Double(rate) * seconds)) }
        for _ in 0..<3 { tone(988, 0.12); silence(0.05) }
        tone(740, 0.3)
        silence(0.5)
        var data = Data()
        func put<T: FixedWidthInteger>(_ v: T) { withUnsafeBytes(of: v.littleEndian) { data.append(contentsOf: $0) } }
        let bytes = samples.count * 2
        data.append(contentsOf: Array("RIFF".utf8)); put(UInt32(36 + bytes))
        data.append(contentsOf: Array("WAVEfmt ".utf8)); put(UInt32(16)); put(UInt16(1)); put(UInt16(1))
        put(UInt32(rate)); put(UInt32(rate * 2)); put(UInt16(2)); put(UInt16(16))
        data.append(contentsOf: Array("data".utf8)); put(UInt32(bytes))
        for s in samples { put(s) }
        return data
    }()
}

struct PageAlarmView: View {
    static let width: CGFloat = 420
    /// More than this and the rest wait behind "+N more": the panel has to fit a laptop screen.
    static let maxCards = 3

    @EnvironmentObject var store: Store
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let p = Palette(scheme)
        let ringing = store.pages.filter(\.ringing)
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 12) {
                LucideIcon("bell-ring", size: 20)
                    .foregroundStyle(p.red)
                    .frame(width: 42, height: 42)
                    .background(Circle().fill(p.wash(p.red)))
                VStack(alignment: .leading, spacing: 2) {
                    Text(ringing.count > 1 ? "\(ringing.count) pages" : "Page")
                        .font(.system(size: 17, weight: .bold))
                    Text("Someone needs you now. It rings until you ack or snooze it.")
                        .font(.system(size: 11)).foregroundStyle(p.fg2)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
            }
            ForEach(ringing.prefix(Self.maxCards)) { page in
                PageCard(page: page)
            }
            if ringing.count > Self.maxCards {
                Text("+\(ringing.count - Self.maxCards) more: ack these to see them")
                    .font(.system(size: 11)).foregroundStyle(p.fg2)
            }
        }
        .foregroundStyle(p.fg)
        .padding(18)
        .frame(width: Self.width)
        .fixedSize(horizontal: false, vertical: true)
        .background(p.surface)
    }
}

struct PageCard: View {
    @EnvironmentObject var store: Store
    @Environment(\.colorScheme) private var scheme
    let page: UiPage

    var body: some View {
        let p = Palette(scheme)
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                AvatarView(name: page.from, photo: store.avatar(page.chatId))
                VStack(alignment: .leading, spacing: 1) {
                    Text(verbatim: page.from).font(.system(size: 13, weight: .semibold)).lineLimit(1)
                    if let chat = page.chat {
                        Text(verbatim: chat).font(.system(size: 11)).foregroundStyle(p.fg3).lineLimit(1)
                    }
                }
                Spacer(minLength: 0)
                HStack(spacing: 4) {
                    LucideIcon("clock", size: 12)
                    Text(verbatim: agoWords(page.createdAt)).font(.system(size: 11))
                }
                .foregroundStyle(p.fg3)
            }
            Text(verbatim: page.reason.isEmpty ? "No reason given" : page.reason)
                .font(.system(size: 13))
                .foregroundStyle(page.reason.isEmpty ? p.fg3 : p.fg)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 10).padding(.vertical, 8)
                .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(p.subtle2))
            if page.state == "unanswered" {
                HStack(alignment: .top, spacing: 6) {
                    LucideIcon("triangle-alert", size: 13).padding(.top, 1)
                    Text("Not acked on the phone either; the sender was told to call.")
                        .font(.system(size: 11)).fixedSize(horizontal: false, vertical: true)
                }
                .foregroundStyle(p.orange)
            }
            HStack(spacing: 8) {
                Button("Ack") { Task { await store.page(page.id, ack: true) } }
                    .buttonStyle(Pill(tint: .white, fill: Palette.redFill))
                    .keyboardShortcut(.defaultAction)
                    .help("Stop the alarm everywhere: here, in the tray and on the phone")
                Button("Snooze 15m") { Task { await store.page(page.id, ack: false, minutes: 15) } }
                    .buttonStyle(Pill(tint: p.fg2))
                Button("1h") { Task { await store.page(page.id, ack: false, minutes: 60) } }
                    .buttonStyle(Pill(tint: p.fg2))
                    .accessibilityLabel(Text("Snooze 1 hour"))
                Spacer(minLength: 0)
                if let url = page.messageURL {
                    Button { NSWorkspace.shared.open(url) } label: {
                        HStack(spacing: 5) {
                            LucideIcon("external-link", size: 12)
                            Text("Open")
                        }
                    }
                    .buttonStyle(Pill(tint: p.accent))
                    .help("Open the message in Telegram")
                }
            }
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(p.wash(p.red)))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(p.red.opacity(0.35)))
    }
}

// MARK: - App

struct TelegramMCPBarApp: App {
    @StateObject private var store = Store()
    private let notifications = NotificationHandler()

    var body: some Scene {
        MenuBarExtra {
            PanelView().environmentObject(store).onAppear { notifications.setUp(store: store) }
        } label: {
            MenuIcon(store: store).task { notifications.setUp(store: store) }
        }
        .menuBarExtraStyle(.window)
    }
}

/// `--snapshot out.png` renders the panel with live data to an image and exits (for checking the layout).
@MainActor
enum Snapshot {
    static func run(to path: String) {
        _ = NSApplication.shared
        let store = Store(polling: false)
        Task { @MainActor in
            await store.poll()
            await store.loadAllAvatars()
            let view = PanelView().environmentObject(store)
                .background(Color(nsColor: .windowBackgroundColor))
                .environment(\.colorScheme, ProcessInfo.processInfo.environment["SNAPSHOT_DARK"] == "1" ? .dark : .light)
            let renderer = ImageRenderer(content: view)
            renderer.scale = 2
            if let image = renderer.nsImage, let tiff = image.tiffRepresentation,
               let rep = NSBitmapImageRep(data: tiff), let png = rep.representation(using: .png, properties: [:]) {
                try? png.write(to: URL(fileURLWithPath: path))
                print("wrote \(path)")
            } else {
                print("render failed")
            }
            exit(0)
        }
        RunLoop.main.run()
    }
}

@main
enum Main {
    static func main() {
        let args = CommandLine.arguments
        if let i = args.firstIndex(of: "--icons"), i + 1 < args.count {
            MainActor.assumeIsolated { IconPreview.run(to: args[i + 1]) }
            return
        }
        if let i = args.firstIndex(of: "--snapshot"), i + 1 < args.count {
            MainActor.assumeIsolated { Snapshot.run(to: args[i + 1]) }
            return
        }
        TelegramMCPBarApp.main()
    }
}
