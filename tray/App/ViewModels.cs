using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Windows.Input;
using System.Windows.Media;
using TelegramMCPTray.Core;

namespace TelegramMCPTray;

/// <summary>
/// A round avatar: the chat's Telegram profile photo once it has loaded, and until then (or when
/// it has none) initials on a colour picked by name, the same name always the same colour.
/// </summary>
public sealed record Avatar(string Initials, Brush Fill, AvatarPhoto? Photo)
{
    public static Avatar For(string name, long? chatId = null) =>
        new(Format.Initials(name), Theme.Avatars[Format.AvatarIndex(name, Theme.Avatars.Length)],
            chatId is { } id ? AvatarPhotos.For(id) : null);
}

/// <summary>One chat's photo. Null until it loads, and stays null when the chat has none.</summary>
public sealed class AvatarPhoto : Observable
{
    ImageSource? _image;
    public ImageSource? Image { get => _image; internal set { if (Set(ref _image, value)) Raise(nameof(HasImage)); } }
    public bool HasImage => _image is not null;
    internal DateTimeOffset LoadedAt { get; set; } = DateTimeOffset.MinValue;
    internal bool Loading { get; set; }
}

/// <summary>
/// The panel's photo cache: each chat's photo is asked for once when its avatar first shows (the
/// daemon fetches it from Telegram and keeps it on disk), and again at most every 6 hours, never per poll.
/// </summary>
public static class AvatarPhotos
{
    static readonly TimeSpan Refresh = TimeSpan.FromHours(6);
    static readonly Dictionary<long, AvatarPhoto> Photos = [];
    static Func<long, System.Threading.Tasks.Task<byte[]?>>? _load;

    /// <summary>Set once by the panel: how to get a photo's bytes from the daemon.</summary>
    public static void Use(Func<long, System.Threading.Tasks.Task<byte[]?>> load) => _load = load;

    public static AvatarPhoto For(long chatId)
    {
        if (!Photos.TryGetValue(chatId, out var photo)) Photos[chatId] = photo = new AvatarPhoto();
        if (_load is { } load && !photo.Loading && DateTimeOffset.UtcNow - photo.LoadedAt > Refresh) _ = LoadAsync(chatId, photo, load);
        return photo;
    }

    static async System.Threading.Tasks.Task LoadAsync(long chatId, AvatarPhoto photo, Func<long, System.Threading.Tasks.Task<byte[]?>> load)
    {
        photo.Loading = true;
        try
        {
            var bytes = await load(chatId);
            photo.LoadedAt = DateTimeOffset.UtcNow;
            // No photo, or the daemon couldn't be reached: keep what's shown (the old photo or the initials).
            if (bytes is null) return;
            photo.Image = Decode(bytes) ?? photo.Image;
        }
        catch
        {
            photo.LoadedAt = DateTimeOffset.UtcNow;
        }
        finally
        {
            photo.Loading = false;
        }
    }

    /// <summary>Decoded at 2× the 34 px avatar, so it stays sharp at 200% scaling and small in memory.</summary>
    static ImageSource? Decode(byte[] bytes)
    {
        try
        {
            var image = new System.Windows.Media.Imaging.BitmapImage();
            image.BeginInit();
            image.CacheOption = System.Windows.Media.Imaging.BitmapCacheOption.OnLoad;
            image.DecodePixelWidth = 68;
            image.StreamSource = new System.IO.MemoryStream(bytes);
            image.EndInit();
            image.Freeze();
            return image;
        }
        catch
        {
            return null; // not a picture WPF can read: the initials stay
        }
    }
}

/// <summary>
/// A tile at the top of Home. Clicking it shows its <see cref="Section"/> below the tiles. The panel
/// keeps the same three and updates them in place, so the tile with keyboard focus keeps it.
/// </summary>
public sealed class StatVM(HomeSection section, Stat stat, ICommand pick) : Observable
{
    Stat _stat = stat;
    bool _selected;

    public HomeSection Section { get; } = section;
    public ICommand Pick { get; } = pick;

    public Stat Stat
    {
        get => _stat;
        set
        {
            if (!Set(ref _stat, value)) return;
            Raise(nameof(Label));
            Raise(nameof(Value));
            Raise(nameof(Chip));
            Raise(nameof(Name));
            Raise(nameof(Tip));
        }
    }

    public bool Selected { get => _selected; set => Set(ref _selected, value); }

    public string Label => _stat.Label;
    public string Value => _stat.Value;
    public Tag Chip => _stat.Chip;
    public string Name => $"{_stat.Label}: {_stat.Value}, {_stat.Chip.Text}";
    public string Tip => $"Show {_stat.Label.ToLowerInvariant()} below";
}

/// <summary>
/// A draft waiting for approval. Kept across polls, so a nickname being typed survives. An edit of a
/// message Claude sent shows its text now and the new text; a delete shows the message that would go.
/// </summary>
public sealed class ApprovalVM : Observable
{
    readonly PanelViewModel _panel;
    string _nick;
    string _ago = "";
    bool _busy;
    bool _expanded;

    public ApprovalVM(PanelViewModel panel, UiApproval item)
    {
        _panel = panel;
        Item = item;
        _nick = item.SuggestedNickname;
        Deny = Command.Async(() => _panel.DecideAsync(this, new Decision(false)));
        Approve = Command.Async(() => _panel.DecideAsync(this, new Decision(true)));
        AskEveryTime = Command.Async(() => _panel.DecideAsync(this, new Decision(true, "requireApproval", Nick)));
        AlwaysAllow = Command.Async(() => _panel.DecideAsync(this, new Decision(true, "autoSend", Nick)));
        ToggleText = new Command(_ => { if (IsLong) Expanded = !Expanded; });
    }

    public UiApproval Item { get; }
    public string Id => Item.Id;
    public string To => Item.To;
    public Avatar Avatar => Avatar.For(Item.Nickname ?? Item.To, Item.ChatId);
    public string Text => Item.Text;
    public string Detail => Item.Detail;
    public string ReasonLine => $"{Item.Reason} · {Item.SessionLabel}";
    /// <summary>Why it waits for you, as the daemon puts it ("this chat is on the requireApproval list").</summary>
    public string Reason => Item.Reason;
    /// <summary>"Asked by api-server · pid 4121": which Claude session wants to send it.</summary>
    public string AskedBy => $"Asked by {Item.SessionLabel}";
    public bool FirstTime => Item.FirstTime;
    /// <summary>First message to a chat that has no nickname yet: the nickname box shows.</summary>
    public bool AsksNickname => Item.FirstTime && Item.Nickname is null;
    public bool HasNickname => Item.FirstTime && Item.Nickname is not null;
    public string? ExistingNickname => Item.Nickname;

    public string Nick { get => _nick; set => Set(ref _nick, value); }

    /// <summary>An edit or delete of a message Claude sent, or a new chat, rather than a new message.</summary>
    public bool IsChange => Item.IsEdit || Item.IsDelete || Item.IsCreate;
    public bool IsEdit => Item.IsEdit;
    public bool IsDelete => Item.IsDelete;
    /// <summary>"Edit message #1003, which Claude sent earlier"; null for a send.</summary>
    public string? ChangeLine => ApprovalCard.ChangeLine(Item);
    public string ChangeIcon => Item.IsEdit ? "pencil" : Item.IsCreate ? "plus" : "trash-2";
    /// <summary>An edit: the text the chat sees now.</summary>
    public string PreviousText => Item.PreviousText ?? "";
    public string ApproveLabel => ApprovalCard.ApproveLabel(Item, _busy);
    public string ApproveIcon => ApprovalCard.ApproveIcon(Item);
    public string ApproveTip => ApprovalCard.ApproveTip(Item);
    public string DenyLabel => ApprovalCard.DenyLabel(Item);
    public string DenyTip => ApprovalCard.DenyTip(Item);
    public string BodyTip => ApprovalCard.BodyTip(Item);

    /// <summary>A draft longer than the card's 4 lines: clicking it (or Show all) opens it. Nothing opens on hover.</summary>
    public bool IsLong => Format.IsLongDraft(Item.Text) || Format.IsLongDraft(Item.PreviousText ?? "");

    public bool Expanded
    {
        get => _expanded;
        set
        {
            if (Set(ref _expanded, value)) Raise(nameof(ExpandLabel));
        }
    }

    public string ExpandLabel => _expanded ? "Show less" : "Show all";
    public string Ago
    {
        get => _ago;
        set
        {
            if (Set(ref _ago, value)) Raise(nameof(AgoText));
        }
    }

    /// <summary>"just now", "5m ago".</summary>
    public string AgoText => AgoWords(_ago);

    internal static string AgoWords(string ago) => ago == "now" ? "just now" : $"{ago} ago";

    public bool Busy
    {
        get => _busy;
        set
        {
            if (Set(ref _busy, value))
            {
                Raise(nameof(Idle));
                Raise(nameof(ApproveLabel));
            }
        }
    }

    public bool Idle => !_busy;

    public ICommand Deny { get; }
    public ICommand Approve { get; }
    public ICommand AskEveryTime { get; }
    public ICommand AlwaysAllow { get; }
    public ICommand ToggleText { get; }
}

/// <summary>
/// A chat a session listens to. <see cref="Contact"/>: its saved chat, whose Listen switch (auto-reply)
/// pauses and resumes listening; null when the chat isn't saved, so there is no switch. The switch,
/// "listening" / "paused" and the dot bind to the contact itself, so they show what is saved (or being
/// saved) right now, and a click there is the same as one on Contacts.
/// </summary>
public sealed record WatchVM(string ChatLabel, string? From, string? Topic, string Tooltip, ContactVM? Contact, bool ContactsKnown)
{
    public bool CanToggle => Contact is not null;

    /// <summary>
    /// After "listening" or "paused": " · from Anna · topic 42", and " · not a saved chat" when the daemon
    /// lists contacts and this one isn't among them. An older daemon lists none, so that can't be told.
    /// </summary>
    public string DetailRest => string.Concat(new[] { From, Topic, Contact is null && ContactsKnown ? "not a saved chat" : null }
        .Where(s => s is not null).Select(s => " · " + s));
}

/// <summary>
/// A Claude session listening to chats. With two or more saved chats it gets an "all" switch for them
/// together. Rebuilt only when its watches change; <see cref="Sync"/> keeps the switch in step.
/// </summary>
public sealed class SessionVM : Observable
{
    readonly IReadOnlyList<ContactVM> _contacts;
    bool _anyOn, _idle = true;

    SessionVM(PanelViewModel panel, string label, Tag tag, IReadOnlyList<WatchVM> watches, IReadOnlyList<ContactVM> contacts)
    {
        Label = label;
        Tag = tag;
        Watches = watches;
        _contacts = contacts;
        // Worked out at the click from what the switches show now, not from when this was built.
        ToggleAll = new Command(_ => _ = panel.SetListeningAsync(contacts.Select(c => c.Nickname).ToList(), !contacts.Any(c => c.Listens),
            $"every chat {label} listens to"));
        Sync();
    }

    public string Label { get; }
    public Tag Tag { get; }
    public IReadOnlyList<WatchVM> Watches { get; }
    public bool HasAll => _contacts.Count > 1;
    public ICommand ToggleAll { get; }

    public bool AnyOn
    {
        get => _anyOn;
        private set
        {
            if (Set(ref _anyOn, value)) Raise(nameof(AllName));
        }
    }

    /// <summary>Off while any of its chats is saving a change: the "all" switch waits for it.</summary>
    public bool Idle { get => _idle; private set => Set(ref _idle, value); }

    public string AllName => _anyOn ? $"Pause every chat {Label} listens to" : $"Resume every chat {Label} listens to";

    internal void Sync()
    {
        AnyOn = _contacts.Any(c => c.Listens);
        Idle = _contacts.All(c => c.Idle);
    }

    /// <param name="contactFor">The Contacts row for a chat id, or null when it isn't saved.</param>
    public static SessionVM From(PanelViewModel panel, UiSession s, bool contactsKnown, Func<long, ContactVM?> contactFor)
    {
        var watches = s.Watches.Select(w => new WatchVM(
            w.ChatLabel,
            w.FromLabel is null ? null : $"from {w.FromLabel}",
            w.TopicId is null ? null : $"topic {w.TopicId}",
            w.Note ?? w.ChatLabel,
            contactFor(w.ChatId),
            contactsKnown)).ToList();
        var contacts = watches.Select(w => w.Contact).OfType<ContactVM>().Distinct().OrderBy(c => c.Nickname, StringComparer.Ordinal).ToList();
        return new(panel, s.Label, Presenter.SessionTag(s), watches, contacts);
    }
}

public sealed record RecentMessageVM(string Body, string Meta);

/// <summary>
/// A chat sent to lately; clicking it shows (or hides) the last three messages. Rebuilt when the
/// list changes, so the panel keeps which chats are open (<see cref="PanelViewModel"/>).
/// </summary>
public sealed class RecentChatVM : Observable
{
    bool _open;

    RecentChatVM(long chatId, string label, string? count, string ago, IReadOnlyList<RecentMessageVM> messages, bool open, Action<RecentChatVM> toggle)
    {
        ChatId = chatId;
        Label = label;
        Count = count;
        Ago = ago;
        Messages = messages;
        _open = open;
        Toggle = new Command(_ => toggle(this));
    }

    public static RecentChatVM From(RecentChat c, string footer, DateTimeOffset now, bool open, Action<RecentChatVM> toggle) => new(
        c.ChatId,
        c.Label,
        c.Messages.Count > 1 ? c.Messages.Count.ToString(System.Globalization.CultureInfo.InvariantCulture) : null,
        Format.Ago(c.Messages[0].At, now),
        c.Messages.Take(3).Select(m => new RecentMessageVM(
            Format.StripFooter(m.Text, footer),
            $"{Format.Ago(m.At, now)} · {Format.ViaLabel(m.Via)}{(m.SessionLabel is null ? "" : $" · {m.SessionLabel}")}{(m.Edited is null ? "" : $" · edited {Format.Ago(m.Edited.At, now)}")}")).ToList(),
        open,
        toggle);

    public long ChatId { get; }
    public string Label { get; }
    public Avatar Avatar => Avatar.For(Label, ChatId);
    /// <summary>"3 messages · 5m": how many were sent there lately, and when the last one went.</summary>
    public string Summary => $"{(Count is null ? "1 message" : $"{Count} messages")} · last sent {ApprovalVM.AgoWords(Ago)}";
    public string? Count { get; }
    public string Ago { get; }
    public IReadOnlyList<RecentMessageVM> Messages { get; }

    public bool IsOpen
    {
        get => _open;
        set
        {
            if (Set(ref _open, value)) Raise(nameof(Chevron));
        }
    }

    public string Chevron => _open ? "chevron-up" : "chevron-down";
    public ICommand Toggle { get; }
}

/// <summary>A saved chat on the Contacts page. Updated in place, so the open row and a half-typed name survive polls.</summary>
public sealed class ContactVM : Observable
{
    readonly PanelViewModel _panel;
    UiContact _c;
    string? _defaultPolicy;
    string _renameText;
    string _pageReason = "";
    bool _busy;
    bool _paging;
    bool? _pending;
    bool? _awayPending;

    public ContactVM(PanelViewModel panel, UiContact contact, string? defaultPolicy)
    {
        _panel = panel;
        _c = contact;
        _defaultPolicy = defaultPolicy;
        _renameText = contact.Nickname;
        Toggle = new Command(_ => _panel.OpenNickname = IsOpen ? null : Nickname);
        Rename = new Command(_ => _ = Edit(new ContactChange(Nickname, Rename: RenameText.Trim())), _ => CanRename);
        SetMode = new Command(p => { if (p is string mode && mode != _c.SendMode) _ = Edit(new ContactChange(Nickname, SendMode: mode)); });
        SetPageFrom = new Command(p =>
        {
            var on = p is "on";
            if (on != _c.PagesMe) _ = Edit(new ContactChange(Nickname, PageFrom: on));
        });
        SendPage = new Command(_ => _ = _panel.PageContactAsync(this), _ => CanSendPage);
        ToggleListen = new Command(_ => _ = _panel.SetListeningAsync([Nickname], !Listens, Nickname));
        SetListen = new Command(p =>
        {
            var on = p is "on";
            if (on != Listens) _ = _panel.SetListeningAsync([Nickname], on, Nickname);
        });
        ToggleAway = new Command(_ => _ = _panel.SetAwayReplyAsync(this, !GetsAway), _ => _awayPending is null && !_panel.SkipBusy);
    }

    /// <summary>The Away tab's switch: on while this person gets away replies, off while they're on away.skip.</summary>
    public bool GetsAway => _awayPending ?? !_panel.AwaySkips(_c.ChatId);
    public string AwayCaption => GetsAway ? "Gets away replies" : "Never gets an away reply";
    public string AwayName => $"Away replies to {_c.Nickname}";
    public ICommand ToggleAway { get; }
    internal long ChatId => _c.ChatId;
    /// <summary>A person other than you: the only chats an away reply can go to.</summary>
    internal bool IsPerson => _c.Type is null or "user" && _c.Pageable != false;

    /// <summary>The value the away switch is saving, or null once the poll after it shows what was saved.</summary>
    internal bool? AwayPending
    {
        set
        {
            _awayPending = value;
            AwayResync();
        }
    }

    internal void AwayResync()
    {
        Raise(nameof(GetsAway));
        Raise(nameof(AwayCaption));
    }

    /// <summary>
    /// The Listen switch: Claude may listen to this chat (its auto-reply). While a change is being saved
    /// it shows the value clicked, so a click then is worked out from what the switch shows, not from a
    /// poll that may predate the change.
    /// </summary>
    public bool Listens => _pending ?? _c.AutoReply;
    public string ListenCaption => Contacts.ListenCaption(_c with { AutoReply = Listens });
    public string ListenName => $"Auto-reply in {_c.Nickname}";
    /// <summary>The open contact's Auto-reply choice: Off is filled while auto-reply is off.</summary>
    public bool NotListens => !Listens;
    /// <summary>Home → Listening now: the state word before a watched chat's details.</summary>
    public string ListenWord => Listens ? "listening" : "paused";
    public string ListenTip => Listens
        ? $"Pause: stop passing {_c.Nickname}'s messages to Claude (turns auto-reply off; the watch stays)"
        : $"Resume: {_c.Nickname}'s messages reach Claude again (turns auto-reply back on)";
    public ICommand ToggleListen { get; }
    /// <summary>The open contact's Auto-reply On / Off: "on" or "off", saved at once.</summary>
    public ICommand SetListen { get; }

    /// <summary>The value a listen switch is saving, or null once a poll after it shows what was saved.</summary>
    internal bool? Pending
    {
        set
        {
            if (_pending == value) return;
            _pending = value;
            Resync();
        }
    }

    /// <summary>Shows the listen state again: after a change, or a click that was refused.</summary>
    internal void Resync()
    {
        Raise(nameof(Listens));
        Raise(nameof(NotListens));
        Raise(nameof(ListenCaption));
        Raise(nameof(ListenWord));
        Raise(nameof(ListenTip));
        Raise(nameof(Explanation));
        _panel.ListenChanged();
    }

    System.Threading.Tasks.Task Edit(ContactChange change) => _panel.EditContactAsync(this, change);

    public void Update(UiContact contact, string? defaultPolicy)
    {
        // Records compare their lists by reference, and every poll brings new lists: compare the JSON.
        if (defaultPolicy == _defaultPolicy && JsonSerializer.Serialize(contact) == JsonSerializer.Serialize(_c)) return;
        _c = contact;
        _defaultPolicy = defaultPolicy;
        Raise(string.Empty); // every property
    }

    public string Nickname => _c.Nickname;
    public Avatar Avatar => Avatar.For(_c.Name ?? _c.Nickname, _c.ChatId);
    /// <summary>Groups, channels and bots get a glyph on their avatar instead of initials.</summary>
    public bool ShowsGlyph => Kind is ContactKind.Group or ContactKind.Channel or ContactKind.Bot;
    public string Subtitle => Contacts.Subtitle(_c);
    public ContactKind Kind => Contacts.Kind(_c);
    /// <summary>The Lucide icon on a group's, channel's or bot's avatar.</summary>
    public string KindIcon => Kind switch
    {
        ContactKind.Bot => "bot",
        ContactKind.Group => "users",
        ContactKind.Channel => "megaphone",
        ContactKind.Person => "user",
        _ => "message-circle",
    };
    public Tag? PageFromTag => Contacts.PageFromTag(_c);
    public Tag ModeTag => Contacts.ModeTag(_c, _defaultPolicy);
    public string Explanation => Contacts.Explanation(_c with { AutoReply = Listens }, _defaultPolicy);
    public string Details => Contacts.Details(_c);

    public bool IsAutoSend => _c.SendMode == "autoSend";
    public bool IsAsk => _c.SendMode == "requireApproval";
    public bool IsBlocked => _c.SendMode == "blocked";

    /// <summary>A person: the "Can page me" choice and the Page button show.</summary>
    public bool CanPage => _c.CanPage;
    public bool PageOn => _c.PagesMe;
    public bool PageOff => !_c.PagesMe;
    public string PageTitle => $"Page {_c.Nickname}";

    public string PageReason { get => _pageReason; set => Set(ref _pageReason, value); }

    public bool Paging
    {
        get => _paging;
        set
        {
            if (!Set(ref _paging, value)) return;
            Raise(nameof(PageButtonText));
            CommandManager.InvalidateRequerySuggested(); // the Page button's enabled state
        }
    }

    public string PageButtonText => _paging ? "Paging…" : "Page";
    bool CanSendPage => !_paging && !Contacts.Blocked(_c, _defaultPolicy);

    public bool IsOpen => _panel.OpenNickname == Nickname;
    public string Chevron => IsOpen ? "chevron-up" : "chevron-down";
    internal void OpenChanged()
    {
        Raise(nameof(IsOpen));
        Raise(nameof(Chevron));
    }

    public string RenameText
    {
        get => _renameText;
        set
        {
            if (Set(ref _renameText, value)) Raise(nameof(CanRename));
        }
    }

    public bool CanRename => !_busy && Contacts.CanRename(_c, _renameText);

    public bool Busy
    {
        get => _busy;
        set
        {
            if (!Set(ref _busy, value)) return;
            Raise(nameof(Idle));
            Raise(nameof(CanRename));
            CommandManager.InvalidateRequerySuggested(); // Rename's enabled state
            _panel.ListenChanged(); // the "all" switches wait for every chat they cover
        }
    }

    public bool Idle => !_busy;

    public ICommand Toggle { get; }
    public ICommand Rename { get; }
    public ICommand SetMode { get; }
    public ICommand SetPageFrom { get; }
    public ICommand SendPage { get; }
}
