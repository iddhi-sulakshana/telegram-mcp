using System.Text.Json;

namespace TelegramMCPTray.Core;

// What the daemon sends on GET /ui/state (src/shared/protocol.ts, UiState).

public sealed record Peer(long Id, string Name, string? Username);

public sealed record TelegramState(string Phase, Peer? Me, string? LastError, int Reconnects);

public sealed record WatchSpec(string Id, long ChatId, string ChatLabel, string? FromLabel, long? TopicId, string? Note);

public sealed record UiSession(
    string Id, string Label, bool Connected, bool Channel, int Monitors, int Pending, IReadOnlyList<WatchSpec> Watches);

public sealed record UiApproval(
    string Id, string To, string Detail, string Text, string Reason, string SessionLabel,
    DateTimeOffset CreatedAt, DateTimeOffset ExpiresAt, bool FirstTime, string? Nickname, string SuggestedNickname,
    /// <summary>The chat it goes to, for its avatar. Null from a daemon older than avatars.</summary>
    long? ChatId = null,
    /// <summary>"send" | "edit" | "delete" | "create". Null from a daemon older than edit and delete approvals: a send.</summary>
    string? Action = null,
    /// <summary>The message an edit or delete is for.</summary>
    long? MessageId = null,
    /// <summary>An edit: the text the chat sees now (Text is the new text). Null for a send or a delete (Text is the message to remove).</summary>
    string? PreviousText = null)
{
    /// <summary>An edit of a message Claude sent, where sending needs approval.</summary>
    public bool IsEdit => Action == "edit";
    /// <summary>A delete of a message Claude sent, for everyone, where sending needs approval.</summary>
    public bool IsDelete => Action == "delete";
    /// <summary>A new channel or supergroup (telegram_create_chat): To names it, Text describes it in full. Only you can approve it.</summary>
    public bool IsCreate => Action == "create";
}

public sealed record SentRecord(
    DateTimeOffset At, long ChatId, string ChatLabel, string Text, long MessageId, string Via, string? SessionLabel,
    /// <summary>Set once a session edited it (telegram_edit_message). Null from a daemon older than edits.</summary>
    SentEdit? Edited = null);

/// <summary>When a sent message was edited, by which session, and its text before the first edit.</summary>
public sealed record SentEdit(DateTimeOffset At, string? By, string Original);

/// <summary>A saved chat and the rules that apply to it (the Contacts page).</summary>
public sealed record UiContact(
    string Nickname, long ChatId, string? Name, string? Username, string? Type, long? TopicId,
    IReadOnlyList<string> Aliases, string? Notes,
    /// <summary>"autoSend" | "requireApproval" | "blocked" | "none"</summary>
    string SendMode, bool AutoReply, string Policy, IReadOnlyList<string> SameChat,
    /// <summary>A person other than you, so paging works both ways. Null from a daemon older than paging contacts.</summary>
    bool? Pageable = null,
    /// <summary>On paging.pageFrom: their "/page &lt;reason&gt;" rings you.</summary>
    bool? PageFrom = null)
{
    public bool CanPage => Pageable == true;
    public bool PagesMe => PageFrom == true;
}

/// <summary>A page: something that needs you now. Rings until it is acked or snoozed here, in the menu bar or on the phone.</summary>
public sealed record UiPage(
    string Id,
    /// <summary>"command" | "keyword" | "claude" | "test"</summary>
    string Source,
    /// <summary>"ringing" | "unanswered" | "snoozed"</summary>
    string State,
    string From, string? Chat, long? ChatId, long? MessageId, string Reason,
    DateTimeOffset CreatedAt, DateTimeOffset? SnoozedUntil)
{
    public bool Ringing => State != "snoozed";
}

public sealed record UiState(
    TelegramState Telegram, string? ConfigError, string Footer,
    IReadOnlyList<UiApproval> Approvals, IReadOnlyList<UiSession> Sessions, IReadOnlyList<SentRecord> Recent,
    /// <summary>Null from a daemon older than the Contacts page.</summary>
    IReadOnlyList<UiContact>? Contacts = null, string? DefaultPolicy = null,
    /// <summary>Null from a daemon older than pages.</summary>
    IReadOnlyList<UiPage>? Pages = null,
    /// <summary>Null from a daemon older than away hours.</summary>
    UiAway? Away = null,
    /// <summary>The footer's text even while it's off. Null from a daemon older than the footer editor.</summary>
    string? FooterText = null,
    bool? FooterOn = null);

/// <summary>
/// The away auto-reply settings and where the clock puts them (UiAway in src/shared/protocol.ts).
/// From, Until, Message and Preview are the schedule replying now (else the first one on).
/// </summary>
public sealed record UiAway(
    bool Enabled, string From, string Until, string Message, int QuietMinutes,
    bool Active, DateTimeOffset? NextChange, string Preview,
    /// <summary>The schedule replying now. Null when none is, or from a daemon older than schedules.</summary>
    string? Current = null,
    DateTimeOffset? CurrentUntil = null,
    /// <summary>Chats whose reply is waiting for you right now.</summary>
    int Waiting = 0,
    /// <summary>Null from a daemon older than schedules (it has one window: From, Until, Message).</summary>
    IReadOnlyList<UiAwaySchedule>? Schedules = null,
    /// <summary>away.skip: chats that never get an away reply. Null from a daemon older than the skip list.</summary>
    IReadOnlyList<UiAwaySkip>? Skip = null);

/// <summary>One away.skip entry: the ref as saved (a nickname, @username or id) and the saved chat it points at, if any.</summary>
public sealed record UiAwaySkip(JsonElement Ref, long? ChatId);

/// <summary>One away schedule (UiAwaySchedule in src/shared/protocol.ts). Days: 0 = Sunday … 6 = Saturday.</summary>
public sealed record UiAwaySchedule(
    string Id, string Name, bool Enabled, string From, string Until, IReadOnlyList<int> Days,
    string? StartDate, string? EndDate, int DelaySeconds, int RepeatMinutes, string Message,
    bool Active, string Preview)
{
    /// <summary>What POST /ui/away takes back for it.</summary>
    public ScheduleData ToData() => new(Id, Name, Enabled, From, Until, Days, StartDate, EndDate, DelaySeconds, RepeatMinutes, Message);
}

/// <summary>A schedule as POST /ui/away saves it.</summary>
public sealed record ScheduleData(
    string Id, string Name, bool Enabled, string From, string Until, IReadOnlyList<int> Days,
    string? StartDate, string? EndDate, int DelaySeconds, int RepeatMinutes, string Message);

public static class Json
{
    /// <summary>camelCase names; fields this app doesn't know are skipped, missing ones are null.</summary>
    public static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web);

    public static UiState ParseState(string json) =>
        JsonSerializer.Deserialize<UiState>(json, Options) ?? throw new JsonException("GET /ui/state returned null");
}
