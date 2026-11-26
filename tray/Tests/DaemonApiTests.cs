using System.Net;
using TelegramMCPTray.Core;
using Xunit;

namespace TelegramMCPTray.Tests;

public class DaemonApiTests
{
    static readonly string StateJson = File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Fixtures", "ui-state-demo.json"));
    static readonly TokenRead Good = new("secret-token", null, TimeSpan.Zero);
    static readonly TokenRead Missing = new(null, "No token yet.", TimeSpan.FromSeconds(2));

    readonly StubHandler _net = new();
    readonly ManualTime _time = new(new DateTimeOffset(2026, 11, 2, 8, 0, 0, TimeSpan.Zero));

    static CancellationToken Ct => TestContext.Current.CancellationToken;

    DaemonApi Api(ITokenSource tokens) => new(new HttpClient(_net), 47901, tokens, _time);

    [Fact]
    public async Task Poll_asks_the_local_daemon_with_the_token()
    {
        _net.Answer(HttpStatusCode.OK, StateJson);

        var r = await Api(new FakeTokens(Good)).PollAsync(Ct);

        Assert.True(r.Reachable);
        Assert.Equal(2, r.State!.Approvals.Count);
        var req = Assert.Single(_net.Requests);
        Assert.Equal(HttpMethod.Get, req.Method);
        Assert.Equal("http://127.0.0.1:47901/ui/state", req.Uri.ToString());
        Assert.Equal("Bearer secret-token", req.Auth);
    }

    [Fact]
    public async Task The_token_is_read_once()
    {
        _net.Answer(HttpStatusCode.OK, StateJson).Answer(HttpStatusCode.OK, StateJson);
        var tokens = new FakeTokens(Good);
        var api = Api(tokens);

        await api.PollAsync(Ct);
        await api.PollAsync(Ct);

        Assert.Equal(1, tokens.Reads);
    }

    [Fact]
    public async Task Without_a_token_it_reports_why_and_sends_nothing()
    {
        var r = await Api(new FakeTokens(Missing)).PollAsync(Ct);

        Assert.False(r.Reachable);
        Assert.Equal("No token yet.", r.Problem);
        Assert.Empty(_net.Requests);
    }

    [Fact]
    public async Task A_missing_token_is_read_again_only_after_its_retry_delay()
    {
        _net.Answer(HttpStatusCode.OK, StateJson);
        var tokens = new FakeTokens(Missing, Good);
        var api = Api(tokens);

        await api.PollAsync(Ct);
        _time.Now += TimeSpan.FromSeconds(1);
        var early = await api.PollAsync(Ct);
        _time.Now += TimeSpan.FromSeconds(1);
        var later = await api.PollAsync(Ct);

        Assert.Equal("No token yet.", early.Problem);
        Assert.True(later.Reachable);
        Assert.Equal(2, tokens.Reads);
    }

    [Fact]
    public async Task A_refused_token_is_read_again_next_time()
    {
        _net.Answer(HttpStatusCode.Unauthorized, "unauthorized\n").Answer(HttpStatusCode.OK, StateJson);
        var tokens = new FakeTokens(new TokenRead("old", null, TimeSpan.Zero), Good);
        var api = Api(tokens);

        var refused = await api.PollAsync(Ct);
        var ok = await api.PollAsync(Ct);

        Assert.Equal("The daemon refused the request (token mismatch?).", refused.Problem);
        Assert.True(ok.Reachable);
        Assert.Equal("Bearer secret-token", _net.Requests[1].Auth);
    }

    [Fact]
    public async Task A_token_for_other_routes_says_to_update_together_and_is_read_again()
    {
        _net.Answer(HttpStatusCode.Forbidden, "forbidden: this token is not for this route\n")
            .Answer(HttpStatusCode.Forbidden, "forbidden: this token is not for this route\n")
            .Answer(HttpStatusCode.OK, StateJson);
        var tokens = new FakeTokens(new TokenRead("sessions-token", null, TimeSpan.Zero), new TokenRead("sessions-token", null, TimeSpan.Zero), Good);
        var api = Api(tokens);

        var polled = await api.PollAsync(Ct);
        var posted = await api.DecideAsync("a_1", new Decision(true), Ct);
        var ok = await api.PollAsync(Ct);

        Assert.Equal(DaemonApi.WrongToken, polled.Problem);
        Assert.Equal(new ActionResult(false, DaemonApi.WrongToken), posted);
        Assert.True(ok.Reachable);
        Assert.Equal(3, tokens.Reads);
    }

    [Fact]
    public async Task Avatar_asks_for_that_chat_with_the_token()
    {
        _net.Answer(HttpStatusCode.OK, "PHOTO");

        var bytes = await Api(new FakeTokens(Good)).AvatarAsync(-1001234567890, Ct);

        Assert.Equal("PHOTO"u8.ToArray(), bytes);
        var req = Assert.Single(_net.Requests);
        Assert.Equal("http://127.0.0.1:47901/ui/avatars/-1001234567890", req.Uri.ToString());
        Assert.Equal("Bearer secret-token", req.Auth);
    }

    [Fact]
    public async Task No_photo_an_older_daemon_or_no_daemon_keep_the_initials()
    {
        _net.Answer(HttpStatusCode.NotFound, "no photo");
        var api = Api(new FakeTokens(Good));
        Assert.Null(await api.AvatarAsync(10, Ct));
        _net.Refuse();
        Assert.Null(await api.AvatarAsync(10, Ct));
        Assert.Null(await Api(new FakeTokens(Missing)).AvatarAsync(10, Ct));
    }

    [Fact]
    public async Task No_daemon_says_how_to_start_it()
    {
        _net.Refuse();

        var r = await Api(new FakeTokens(Good)).PollAsync(Ct);

        Assert.False(r.Reachable);
        Assert.Equal("The daemon is not running. Start it with tgmcp daemon.", r.Problem);
    }

    [Fact]
    public async Task Decide_posts_the_choice_and_returns_the_daemons_answer()
    {
        _net.Answer(HttpStatusCode.OK, """{"ok":true,"text":"Approved in the menu bar. Sent to Leo."}""");

        var r = await Api(new FakeTokens(Good)).DecideAsync("a_12345678", new Decision(true, "autoSend", "leo"), Ct);

        Assert.Equal(new ActionResult(true, "Approved in the menu bar. Sent to Leo."), r);
        var req = Assert.Single(_net.Requests);
        Assert.Equal(HttpMethod.Post, req.Method);
        Assert.Equal("http://127.0.0.1:47901/ui/approvals/a_12345678", req.Uri.ToString());
        Assert.Equal("""{"decision":"approve","remember":"autoSend","nickname":"leo"}""", req.Body);
    }

    [Fact]
    public async Task Deny_sends_only_the_decision()
    {
        _net.Answer(HttpStatusCode.OK, """{"ok":true,"text":"Declined."}""");

        await Api(new FakeTokens(Good)).DecideAsync("a_12345678", new Decision(false, Nickname: "  "), Ct);

        Assert.Equal("""{"decision":"deny"}""", _net.Requests[0].Body);
    }

    [Fact]
    public async Task A_decision_the_daemon_rejects_is_not_ok()
    {
        _net.Answer(HttpStatusCode.Conflict, """{"ok":false,"text":"No pending approval a_12345678."}""");

        var r = await Api(new FakeTokens(Good)).DecideAsync("a_12345678", new Decision(true), Ct);

        Assert.Equal(new ActionResult(false, "No pending approval a_12345678."), r);
    }

    [Fact]
    public async Task Decide_without_a_daemon_says_so()
    {
        _net.Refuse();

        var r = await Api(new FakeTokens(Good)).DecideAsync("a_12345678", new Decision(true), Ct);

        Assert.False(r.Ok);
        Assert.StartsWith("Could not reach the daemon:", r.Text);
    }

    [Fact]
    public async Task Edit_contact_posts_only_what_changes()
    {
        _net.Answer(HttpStatusCode.OK, """{"ok":true,"text":"\"leo-p\": renamed from \"leo\".","nickname":"leo-p"}""");

        var r = await Api(new FakeTokens(Good)).EditContactAsync(new ContactChange("leo", Rename: "leo-p"), Ct);

        Assert.Equal(new ActionResult(true, "\"leo-p\": renamed from \"leo\".", "leo-p"), r);
        Assert.Equal("http://127.0.0.1:47901/ui/contacts", _net.Requests[0].Uri.ToString());
        Assert.Equal("""{"nickname":"leo","rename":"leo-p"}""", _net.Requests[0].Body);
    }

    [Fact]
    public async Task Edit_contact_on_a_daemon_without_contacts_asks_for_a_restart()
    {
        _net.Answer(HttpStatusCode.NotFound, "not found\n");

        var r = await Api(new FakeTokens(Good)).EditContactAsync(new ContactChange("leo", AutoReply: true), Ct);

        Assert.Equal(new ActionResult(false, Contacts.OlderDaemon), r);
    }

    [Fact]
    public async Task An_answer_without_text_falls_back_to_saved_or_not_changed()
    {
        _net.Answer(HttpStatusCode.OK, "{}").Answer(HttpStatusCode.Conflict, "{}");
        var api = Api(new FakeTokens(Good));

        Assert.Equal(new ActionResult(true, "Saved."), await api.EditContactAsync(new ContactChange("leo", AutoReply: true), Ct));
        Assert.Equal(new ActionResult(false, "Not changed."), await api.EditContactAsync(new ContactChange("leo", AutoReply: true), Ct));
    }

    [Fact]
    public async Task Edit_contact_sends_the_mode_and_auto_reply()
    {
        _net.Answer(HttpStatusCode.OK, """{"ok":true,"text":"done","nickname":"leo"}""");

        await Api(new FakeTokens(Good)).EditContactAsync(new ContactChange("leo", SendMode: "blocked", AutoReply: false), Ct);

        Assert.Equal("""{"nickname":"leo","sendMode":"blocked","autoReply":false}""", _net.Requests[0].Body);
    }

    [Fact]
    public async Task Edit_contact_sends_page_from()
    {
        _net.Answer(HttpStatusCode.OK, """{"ok":true,"text":"done","nickname":"leo"}""");

        await Api(new FakeTokens(Good)).EditContactAsync(new ContactChange("leo", PageFrom: true), Ct);

        Assert.Equal("""{"nickname":"leo","pageFrom":true}""", _net.Requests[0].Body);
    }

    [Fact]
    public async Task Save_away_posts_only_what_changes()
    {
        _net.Answer(HttpStatusCode.OK, """{"ok":true,"text":"Away hours: 18:00 to 07:30."}""");

        var r = await Api(new FakeTokens(Good)).SaveAwayAsync(new AwayChange(Until: "07:30"), Ct);

        Assert.Equal(new ActionResult(true, "Away hours: 18:00 to 07:30."), r);
        Assert.Equal("http://127.0.0.1:47901/ui/away", _net.Requests[0].Uri.ToString());
        Assert.Equal("""{"until":"07:30"}""", _net.Requests[0].Body);
    }

    [Fact]
    public async Task Save_away_sends_every_field_that_is_set()
    {
        _net.Answer(HttpStatusCode.OK, """{"ok":true,"text":"done"}""");

        await Api(new FakeTokens(Good)).SaveAwayAsync(new AwayChange(true, "18:00", "09:00", "hi", 0), Ct);

        Assert.Equal("""{"enabled":true,"from":"18:00","until":"09:00","message":"hi","quietMinutes":0}""", _net.Requests[0].Body);
    }

    [Fact]
    public async Task Save_away_sends_the_whole_schedule_list()
    {
        _net.Answer(HttpStatusCode.OK, """{"ok":true,"text":"done"}""");

        await Api(new FakeTokens(Good)).SaveAwayAsync(new AwayChange(Schedules:
        [
            new ScheduleData("day", "Daytime", true, "08:00", "21:00", [1, 2], null, "2026-12-24", 30, 60, "brb"),
        ]), Ct);

        Assert.Equal("""{"schedules":[{"id":"day","name":"Daytime","enabled":true,"from":"08:00","until":"21:00","days":[1,2],"startDate":null,"endDate":"2026-12-24","delaySeconds":30,"repeatMinutes":60,"message":"brb"}]}""",
            _net.Requests[0].Body);
    }

    [Fact]
    public async Task Save_away_sends_the_skip_list_as_given()
    {
        _net.Answer(HttpStatusCode.OK, """{"ok":true,"text":"done"}""");

        await Api(new FakeTokens(Good)).SaveAwayAsync(new AwayChange(Skip: [System.Text.Json.Nodes.JsonValue.Create("pahan"), System.Text.Json.Nodes.JsonValue.Create(491741918L)]), Ct);

        Assert.Equal("""{"skip":["pahan",491741918]}""", _net.Requests[0].Body);
    }

    [Fact]
    public async Task Save_footer_posts_the_text_and_the_switch()
    {
        _net.Answer(HttpStatusCode.OK, """{"ok":true,"text":"Saved. The footer is off."}""")
            .Answer(HttpStatusCode.NotFound, "not found\n");
        var api = Api(new FakeTokens(Good));

        var r = await api.SaveFooterAsync("\n\nme", false, Ct);
        var old = await api.SaveFooterAsync(null, true, Ct);

        Assert.Equal(new ActionResult(true, "Saved. The footer is off."), r);
        Assert.Equal("http://127.0.0.1:47901/ui/footer", _net.Requests[0].Uri.ToString());
        Assert.Equal("""{"footer":"\n\nme","enabled":false}""", _net.Requests[0].Body);
        Assert.Equal("""{"enabled":true}""", _net.Requests[1].Body);
        Assert.Equal(new ActionResult(false, Footer.OlderDaemon), old);
    }

    [Fact]
    public async Task Save_away_on_an_older_daemon_asks_for_a_restart()
    {
        _net.Answer(HttpStatusCode.NotFound, "not found\n");

        var r = await Api(new FakeTokens(Good)).SaveAwayAsync(new AwayChange(Enabled: true), Ct);

        Assert.Equal(new ActionResult(false, Away.OlderDaemon), r);
    }

    [Fact]
    public async Task Page_contact_posts_the_nickname_and_reason()
    {
        _net.Answer(HttpStatusCode.OK, """{"ok":true,"text":"Paged leo."}""")
            .Answer(HttpStatusCode.Conflict, """{"ok":false,"text":"Not paged: \"qa\" is a group."}""")
            .Answer(HttpStatusCode.NotFound, "not found\n");
        var api = Api(new FakeTokens(Good));

        Assert.Equal(new ActionResult(true, "Paged leo."), await api.PageContactAsync("leo", "prod down", Ct));
        Assert.Equal("http://127.0.0.1:47901/ui/contacts/page", _net.Requests[0].Uri.ToString());
        Assert.Equal("""{"nickname":"leo","reason":"prod down"}""", _net.Requests[0].Body);
        Assert.Equal(new ActionResult(false, "Not paged: \"qa\" is a group."), await api.PageContactAsync("qa", "", Ct));
        Assert.Equal(new ActionResult(false, Contacts.OlderDaemonForPaging), await api.PageContactAsync("leo", "", Ct));
    }
}
