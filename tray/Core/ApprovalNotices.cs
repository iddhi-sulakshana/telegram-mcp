namespace TelegramMCPTray.Core;

public enum NoticeAction { Approve, AlwaysAllow, Deny }

public sealed record NoticeButton(string Label, NoticeAction Action);

public sealed record Notice(string Title, string Subtitle, string Body, IReadOnlyList<NoticeButton> Buttons);

/// <summary>
/// A Windows notification for each draft waiting for approval, as the menu bar app posts them: one
/// per draft, removed once it's decided anywhere, with the panel's choices as buttons.
/// </summary>
public static class ApprovalNotices
{
    /// <summary>Which drafts need a notification, and which notifications (by draft id) to take down.</summary>
    public static (IReadOnlyList<UiApproval> Show, IReadOnlyList<string> Remove) Diff(
        IReadOnlySet<string> shown, IReadOnlyList<UiApproval> waiting)
    {
        var ids = waiting.Select(a => a.Id).ToHashSet();
        return (waiting.Where(a => !shown.Contains(a.Id)).ToList(), shown.Where(id => !ids.Contains(id)).ToList());
    }

    public static Notice Content(UiApproval a) =>
        a.IsEdit ? new(
            "Edit Telegram message?",
            $"Message #{a.MessageId} in {a.To}",
            $"Now: {a.PreviousText}\nWill say: {a.Text}",
            [new("Edit", NoticeAction.Approve), new("Deny", NoticeAction.Deny)])
        : a.IsDelete ? new(
            "Delete Telegram message for everyone?",
            $"Message #{a.MessageId} in {a.To}",
            a.Text,
            [new("Delete", NoticeAction.Approve), new("Keep", NoticeAction.Deny)])
        : a.IsCreate ? new(
            "Create Telegram chat?",
            $"{a.To} ({a.Detail})",
            a.Text,
            [new("Create", NoticeAction.Approve), new("Deny", NoticeAction.Deny)])
        : SendContent(a);

    static Notice SendContent(UiApproval a) => new(
        a.FirstTime ? $"First message to {a.To}: approve?" : "Approve Telegram message?",
        $"To {a.To} ({a.Detail})",
        a.Text,
        a.FirstTime
            ?
            [
                new("Approve, ask next time", NoticeAction.Approve),
                new("Approve, always allow", NoticeAction.AlwaysAllow),
                new("Deny", NoticeAction.Deny),
            ]
            : [new("Approve", NoticeAction.Approve), new("Deny", NoticeAction.Deny)]);

    /// <summary>
    /// "remember" only matters for a first message (the daemon ignores it otherwise): Approve keeps
    /// asking next time, like the panel's "Ask every time".
    /// </summary>
    public static Decision DecisionFor(NoticeAction action) => action switch
    {
        NoticeAction.Approve => new(true, "requireApproval"),
        NoticeAction.AlwaysAllow => new(true, "autoSend"),
        _ => new(false),
    };
}
