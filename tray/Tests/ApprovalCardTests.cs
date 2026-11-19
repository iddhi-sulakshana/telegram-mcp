using System.Text.Json;
using TelegramMCPTray.Core;
using Xunit;

namespace TelegramMCPTray.Tests;

/// <summary>
/// An edit or delete of a message Claude sent waits like a draft where sending needs approval. The card
/// and its notification say which it is, show the text, and offer Edit / Deny or Delete / Keep.
/// </summary>
public class ApprovalCardTests
{
    static readonly UiApproval Send = Fixtures.DemoState().Approvals[0];
    static readonly UiApproval Edit = Send with { Action = "edit", MessageId = 1003, PreviousText = "old link", Text = "new link" };
    static readonly UiApproval Delete = Send with { Action = "delete", MessageId = 1004, Text = "the password" };
    static readonly UiApproval Create = Send with
    {
        Action = "create", ChatId = 0, To = "new channel \"Acme News\"", Detail = "channel · public @acme_news",
        Text = "Create a new public channel: \"Acme News\"\nPublic link: https://t.me/acme_news (@acme_news)",
    };

    [Fact]
    public void Parses_an_edit_waiting()
    {
        var a = JsonSerializer.Deserialize<UiApproval>(
            """{"id":"a_x","action":"edit","messageId":1003,"previousText":"old","chatId":-100,"to":"Team QA [kyc-qa]","detail":"d","text":"new","reason":"r","sessionId":"s","sessionLabel":"one","createdAt":"2026-11-05T07:00:00Z","expiresAt":"2026-11-05T07:20:00Z","firstTime":false,"nickname":"kyc-qa","suggestedNickname":"kyc-qa"}""",
            Json.Options)!;

        Assert.True(a.IsEdit);
        Assert.False(a.IsDelete);
        Assert.Equal(1003, a.MessageId);
        Assert.Equal("old", a.PreviousText);
    }

    [Fact]
    public void A_daemon_older_than_edit_approvals_sends_only_sends()
    {
        Assert.Null(Send.Action);
        Assert.False(Send.IsEdit);
        Assert.False(Send.IsDelete);
        Assert.Null(ApprovalCard.ChangeLine(Send));
    }

    [Fact]
    public void A_send_card_is_as_before()
    {
        Assert.Equal("Send", ApprovalCard.ApproveLabel(Send, busy: false));
        Assert.Equal("Sending…", ApprovalCard.ApproveLabel(Send, busy: true));
        Assert.Equal("send", ApprovalCard.ApproveIcon(Send));
        Assert.Equal("Deny", ApprovalCard.DenyLabel(Send));
        Assert.Equal("Send this message now", ApprovalCard.ApproveTip(Send));
        Assert.Equal("Don't send it. Claude is told you said no.", ApprovalCard.DenyTip(Send));
        Assert.Equal("The exact message Claude wants to send", ApprovalCard.BodyTip(Send));
    }

    [Fact]
    public void An_edit_card_says_which_message_and_offers_edit_or_deny()
    {
        Assert.Equal("Edit message #1003, which Claude sent earlier", ApprovalCard.ChangeLine(Edit));
        Assert.Equal("Edit", ApprovalCard.ApproveLabel(Edit, busy: false));
        Assert.Equal("Editing…", ApprovalCard.ApproveLabel(Edit, busy: true));
        Assert.Equal("pencil", ApprovalCard.ApproveIcon(Edit));
        Assert.Equal("Deny", ApprovalCard.DenyLabel(Edit));
        Assert.Equal("Change the message to the new text now", ApprovalCard.ApproveTip(Edit));
        Assert.Equal("Leave the message as it is. Claude is told you said no.", ApprovalCard.DenyTip(Edit));
        Assert.Equal("The message as the chat sees it now, and the exact new text", ApprovalCard.BodyTip(Edit));
    }

    [Fact]
    public void A_delete_card_says_which_message_and_offers_delete_or_keep()
    {
        Assert.Equal("Delete message #1004 for everyone in the chat", ApprovalCard.ChangeLine(Delete));
        Assert.Equal("Delete", ApprovalCard.ApproveLabel(Delete, busy: false));
        Assert.Equal("Deleting…", ApprovalCard.ApproveLabel(Delete, busy: true));
        Assert.Equal("trash-2", ApprovalCard.ApproveIcon(Delete));
        Assert.Equal("Keep", ApprovalCard.DenyLabel(Delete));
        Assert.Equal("Delete the message for everyone in the chat now. It can't be undone.", ApprovalCard.ApproveTip(Delete));
        Assert.Equal("Keep the message. Claude is told you said no.", ApprovalCard.DenyTip(Delete));
        Assert.Equal("The message Claude wants to delete for everyone", ApprovalCard.BodyTip(Delete));
    }

    [Fact]
    public void An_edit_notice_shows_the_old_and_new_text_with_edit_and_deny()
    {
        var n = ApprovalNotices.Content(Edit);

        Assert.Equal("Edit Telegram message?", n.Title);
        Assert.Equal("Message #1003 in Team QA [team-qa] · topic 42", n.Subtitle);
        Assert.Equal("Now: old link\nWill say: new link", n.Body);
        Assert.Equal([new NoticeButton("Edit", NoticeAction.Approve), new NoticeButton("Deny", NoticeAction.Deny)], n.Buttons);
    }

    [Fact]
    public void A_delete_notice_shows_the_message_with_delete_and_keep()
    {
        var n = ApprovalNotices.Content(Delete);

        Assert.Equal("Delete Telegram message for everyone?", n.Title);
        Assert.Equal("Message #1004 in Team QA [team-qa] · topic 42", n.Subtitle);
        Assert.Equal("the password", n.Body);
        Assert.Equal([new NoticeButton("Delete", NoticeAction.Approve), new NoticeButton("Keep", NoticeAction.Deny)], n.Buttons);
    }

    [Fact]
    public void Parses_a_create_waiting()
    {
        var a = JsonSerializer.Deserialize<UiApproval>(
            """{"id":"a_c","action":"create","messageId":null,"previousText":null,"chatId":0,"to":"new supergroup \"Team\"","detail":"supergroup · private","text":"Create a new private supergroup: \"Team\"","reason":"r","sessionId":"s","sessionLabel":"one","createdAt":"2026-11-05T07:00:00Z","expiresAt":"2026-11-05T07:20:00Z","firstTime":false,"nickname":null,"suggestedNickname":""}""",
            Json.Options)!;

        Assert.True(a.IsCreate);
        Assert.False(a.IsEdit);
        Assert.False(a.IsDelete);
        Assert.Equal(0, a.ChatId);
    }

    [Fact]
    public void A_create_card_offers_create_and_deny()
    {
        Assert.Equal("Create a new chat on your Telegram account", ApprovalCard.ChangeLine(Create));
        Assert.Equal("Create", ApprovalCard.ApproveLabel(Create, busy: false));
        Assert.Equal("Creating…", ApprovalCard.ApproveLabel(Create, busy: true));
        Assert.Equal("plus", ApprovalCard.ApproveIcon(Create));
        Assert.Equal("Deny", ApprovalCard.DenyLabel(Create));
        Assert.Equal("Don't create it. Claude is told you said no.", ApprovalCard.DenyTip(Create));
        Assert.False(Create.IsEdit || Create.IsDelete);
    }

    [Fact]
    public void A_create_notice_describes_the_chat_with_create_and_deny()
    {
        var n = ApprovalNotices.Content(Create);

        Assert.Equal("Create Telegram chat?", n.Title);
        Assert.Equal("new channel \"Acme News\" (channel · public @acme_news)", n.Subtitle);
        Assert.Contains("t.me/acme_news", n.Body);
        Assert.Equal([new NoticeButton("Create", NoticeAction.Approve), new NoticeButton("Deny", NoticeAction.Deny)], n.Buttons);
    }
}
