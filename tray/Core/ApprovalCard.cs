namespace TelegramMCPTray.Core;

/// <summary>
/// What a card under Waiting says and offers. Most are messages to send; an edit or delete of a message
/// Claude sent waits the same way where sending needs approval, and offers Edit / Deny or Delete / Keep.
/// A new channel or supergroup Claude wants to create offers Create / Deny. The words match the menu bar app's.
/// </summary>
public static class ApprovalCard
{
    /// <summary>"Edit message #1003, which Claude sent earlier"; null for a send.</summary>
    public static string? ChangeLine(UiApproval a) =>
        a.IsEdit ? $"Edit message #{a.MessageId}, which Claude sent earlier"
        : a.IsDelete ? $"Delete message #{a.MessageId} for everyone in the chat"
        : a.IsCreate ? "Create a new chat on your Telegram account"
        : null;

    public static string ApproveLabel(UiApproval a, bool busy) =>
        a.IsEdit ? (busy ? "Editing…" : "Edit")
        : a.IsDelete ? (busy ? "Deleting…" : "Delete")
        : a.IsCreate ? (busy ? "Creating…" : "Create")
        : busy ? "Sending…" : "Send";

    /// <summary>The Lucide icon on the approve button (icon.* in Icons.xaml).</summary>
    public static string ApproveIcon(UiApproval a) => a.IsEdit ? "pencil" : a.IsDelete ? "trash-2" : a.IsCreate ? "plus" : "send";

    public static string ApproveTip(UiApproval a) =>
        a.IsEdit ? "Change the message to the new text now"
        : a.IsDelete ? "Delete the message for everyone in the chat now. It can't be undone."
        : a.IsCreate ? "Create this chat on your account now, exactly as described"
        : "Send this message now";

    public static string DenyLabel(UiApproval a) => a.IsDelete ? "Keep" : "Deny";

    public static string DenyTip(UiApproval a) =>
        a.IsEdit ? "Leave the message as it is. Claude is told you said no."
        : a.IsDelete ? "Keep the message. Claude is told you said no."
        : a.IsCreate ? "Don't create it. Claude is told you said no."
        : "Don't send it. Claude is told you said no.";

    public static string BodyTip(UiApproval a) =>
        a.IsEdit ? "The message as the chat sees it now, and the exact new text"
        : a.IsDelete ? "The message Claude wants to delete for everyone"
        : a.IsCreate ? "The chat Claude wants to create: type, name, username and discussion group"
        : "The exact message Claude wants to send";
}
