using TelegramMCPTray.Core;
using Xunit;

namespace TelegramMCPTray.Tests;

/// <summary>
/// The Contacts page against the real daemon (its own demo daemon: these edit the rules).
/// The demo saves leo, anna, team-qa and all-hands.
/// </summary>
public class DemoContactsTests(DemoDaemon demo) : IClassFixture<DemoDaemon>
{
    static CancellationToken Ct => TestContext.Current.CancellationToken;

    DaemonApi Api() => new(new HttpClient(), demo.Port, new FileTokenSource(Path.Combine(demo.Home, "ui-token")));

    static UiContact Find(UiState s, string nickname) => s.Contacts!.Single(c => c.Nickname == nickname);

    [Fact]
    public async Task The_daemon_lists_saved_chats_with_their_rules()
    {
        var s = (await Api().PollAsync(Ct)).State!;

        Assert.Equal("approve", s.DefaultPolicy);
        var qa = Find(s, "team-qa");
        Assert.Equal("requireApproval", qa.SendMode);
        Assert.Equal(42, qa.TopicId);
        Assert.Equal("blocked", Find(s, "all-hands").SendMode);
        Assert.Equal(new Tag("ask every time", TagKind.Warn), Contacts.ModeTag(qa, s.DefaultPolicy));
    }

    [Fact]
    public async Task Choosing_a_sending_rule_saves_it()
    {
        var api = Api();

        // anna, not team-qa: these tests share one demo daemon in no fixed order, and the listing test
        // above checks team-qa's rule.
        var r = await api.EditContactAsync(new ContactChange("anna", SendMode: "requireApproval"), Ct);
        var after = Find((await api.PollAsync(Ct)).State!, "anna");

        Assert.True(r.Ok, r.Text);
        Assert.StartsWith("\"anna\": ask every time", r.Text);
        Assert.Equal("requireApproval", after.SendMode);
    }

    [Fact]
    public async Task Renaming_returns_the_new_nickname()
    {
        var r = await Api().EditContactAsync(new ContactChange("leo", Rename: "leo-p"), Ct);

        Assert.True(r.Ok, r.Text);
        Assert.Equal("leo-p", r.Nickname);
    }

    [Fact]
    public async Task A_name_that_means_another_chat_is_refused()
    {
        var r = await Api().EditContactAsync(new ContactChange("all-hands", Rename: "team-qa"), Ct);

        Assert.False(r.Ok);
        Assert.StartsWith("Not changed:", r.Text);
    }
}
