using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace TelegramMCPTray.Core;

/// <summary>A read of the daemon's token. <see cref="RetryAfter"/>: how long to wait before trying again.</summary>
public sealed record TokenRead(string? Token, string? Problem, TimeSpan RetryAfter)
{
    public const string NoTokenYet = "No token yet. Has the daemon run once? Start it with tgmcp daemon.";
}

public interface ITokenSource
{
    TokenRead Read();
}

/// <summary>TELEGRAM_MCP_SECRET_STORE=file: the token is a plain file.</summary>
public sealed class FileTokenSource(string path) : ITokenSource
{
    public TokenRead Read()
    {
        try
        {
            var token = File.ReadAllText(path).Trim();
            if (token.Length > 0) return new(token, null, TimeSpan.Zero);
        }
        catch (FileNotFoundException) { }
        catch (DirectoryNotFoundException) { }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return new(null, $"Could not read the token file {path}: {e.Message}", TimeSpan.FromSeconds(10));
        }
        return new(null, TokenRead.NoTokenYet, TimeSpan.FromSeconds(2));
    }
}

public sealed record PollResult(UiState? State, string? Problem)
{
    public bool Reachable => State is not null;
}

/// <summary>
/// An answer to a draft. <see cref="Remember"/> (first message to a chat): "autoSend" = always allow,
/// "requireApproval" = ask every time.
/// </summary>
public sealed record Decision(bool Approve, string? Remember = null, string? Nickname = null);

/// <summary>An Away-page edit for POST /ui/away: only the fields that are set go in the body.</summary>
public sealed record AwayChange(bool? Enabled = null, string? From = null, string? Until = null, string? Message = null, int? QuietMinutes = null,
    /// <summary>The whole list, replacing what is saved.</summary>
    IReadOnlyList<ScheduleData>? Schedules = null,
    /// <summary>away.skip, the whole list, replacing what is saved.</summary>
    IReadOnlyList<JsonNode?>? Skip = null);

/// <summary>A Contacts-page edit; null fields stay as they are.</summary>
public sealed record ContactChange(string Nickname, string? SendMode = null, bool? AutoReply = null, string? Rename = null, bool? PageFrom = null);

/// <summary>The daemon's answer to an action, in words. <see cref="Nickname"/>: a contact's name after the edit.</summary>
public sealed record ActionResult(bool Ok, string Text, string? Nickname = null);

/// <summary>
/// The daemon's local HTTP API (src/daemon/server.ts), as the menu bar app uses it: GET /ui/state
/// every 2 s (which also tells the daemon to send approvals here instead of the Claude Code dialog),
/// POST /ui/approvals/:id and POST /ui/contacts. Only 127.0.0.1, with the apps' token ("ui-token") as a
/// bearer: the daemon refuses the sessions' token on these routes.
/// Not thread-safe: the app calls it from the UI thread.
/// </summary>
public sealed class DaemonApi(HttpClient http, int port, ITokenSource tokens, TimeProvider? time = null)
{
    public const string NotRunning = "The daemon is not running. Start it with tgmcp daemon.";
    public const string Refused = "The daemon refused the request (token mismatch?).";
    /// <summary>403: a token the daemon knows, but not the one for these routes (an app and daemon of different versions).</summary>
    public const string WrongToken = "The daemon refused this app's token. Update the daemon and this app together (tgmcp menubar).";
    /// <summary>Sent on every request: this app shows new-chat requests as Create / Deny, not as a send.</summary>
    public const string FeaturesHeader = "X-Tgmcp-Features";
    public const string Features = "create";
    static readonly TimeSpan Timeout = TimeSpan.FromSeconds(4);

    readonly TimeProvider _time = time ?? TimeProvider.System;
    string? _token;
    string? _tokenProblem;
    DateTimeOffset _retryAt = DateTimeOffset.MinValue;

    /// <summary>Read once and kept; dropped when the daemon says no, so a new token is picked up.</summary>
    string? Token()
    {
        if (_token is not null) return _token;
        if (_time.GetUtcNow() < _retryAt) return null;
        var r = tokens.Read();
        if (!string.IsNullOrEmpty(r.Token))
        {
            _tokenProblem = null;
            return _token = r.Token;
        }
        _tokenProblem = r.Problem ?? TokenRead.NoTokenYet;
        _retryAt = _time.GetUtcNow() + r.RetryAfter;
        return null;
    }

    public async Task<PollResult> PollAsync(CancellationToken ct = default)
    {
        if (Token() is not { } token) return new(null, _tokenProblem);
        try
        {
            using var cts = WithTimeout(ct);
            using var res = await http.SendAsync(Request(HttpMethod.Get, "/ui/state", token), cts.Token);
            if (res.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden)
            {
                _token = null;
                return new(null, res.StatusCode == HttpStatusCode.Forbidden ? WrongToken : Refused);
            }
            if (!res.IsSuccessStatusCode) return new(null, $"The daemon answered {(int)res.StatusCode} {res.ReasonPhrase}.");
            return new(Json.ParseState(await res.Content.ReadAsStringAsync(cts.Token)), null);
        }
        catch (Exception e) when (Unreachable(e, ct))
        {
            return new(null, NotRunning);
        }
        catch (JsonException e)
        {
            return new(null, $"The daemon sent something this app can't read: {e.Message}");
        }
    }

    public Task<ActionResult> DecideAsync(string id, Decision decision, CancellationToken ct = default)
    {
        var body = new JsonObject { ["decision"] = decision.Approve ? "approve" : "deny" };
        if (decision.Remember is not null) body["remember"] = decision.Remember;
        if (!string.IsNullOrWhiteSpace(decision.Nickname)) body["nickname"] = decision.Nickname;
        return PostAsync($"/ui/approvals/{Uri.EscapeDataString(id)}", body, _ => decision.Approve ? "Approved." : "Denied.", ct);
    }

    public Task<ActionResult> EditContactAsync(ContactChange change, CancellationToken ct = default)
    {
        var body = new JsonObject { ["nickname"] = change.Nickname };
        if (change.SendMode is not null) body["sendMode"] = change.SendMode;
        if (change.AutoReply is { } on) body["autoReply"] = on;
        if (change.PageFrom is { } pages) body["pageFrom"] = pages;
        if (change.Rename is not null) body["rename"] = change.Rename;
        return PostAsync("/ui/contacts", body, ok => ok ? "Saved." : "Not changed.", ct, notFound: Contacts.OlderDaemon);
    }

    public Task<ActionResult> SaveAwayAsync(AwayChange change, CancellationToken ct = default)
    {
        var body = new JsonObject();
        if (change.Enabled is { } on) body["enabled"] = on;
        if (change.From is not null) body["from"] = change.From;
        if (change.Until is not null) body["until"] = change.Until;
        if (change.Message is not null) body["message"] = change.Message;
        if (change.QuietMinutes is { } quiet) body["quietMinutes"] = quiet;
        if (change.Skip is { } skip) body["skip"] = new JsonArray(skip.Select(n => n?.DeepClone()).ToArray());
        if (change.Schedules is { } list)
        {
            var arr = new JsonArray();
            foreach (var x in list)
            {
                var days = new JsonArray();
                foreach (var d in x.Days) days.Add(d);
                arr.Add(new JsonObject
                {
                    ["id"] = x.Id, ["name"] = x.Name, ["enabled"] = x.Enabled, ["from"] = x.From, ["until"] = x.Until,
                    ["days"] = days, ["startDate"] = x.StartDate, ["endDate"] = x.EndDate,
                    ["delaySeconds"] = x.DelaySeconds, ["repeatMinutes"] = x.RepeatMinutes, ["message"] = x.Message,
                });
            }
            body["schedules"] = arr;
        }
        return PostAsync("/ui/away", body, ok => ok ? "Saved." : "Not changed.", ct, notFound: Away.OlderDaemon);
    }

    /// <summary>The footer: its whole text (leading line breaks included) and/or on or off. Off keeps the text.</summary>
    public Task<ActionResult> SaveFooterAsync(string? footer, bool? enabled, CancellationToken ct = default)
    {
        var body = new JsonObject();
        if (footer is not null) body["footer"] = footer;
        if (enabled is { } on) body["enabled"] = on;
        return PostAsync("/ui/footer", body, ok => ok ? "Saved." : "Not changed.", ct, notFound: Footer.OlderDaemon);
    }

    /// <summary>The Page button: the daemon sends "/page &lt;reason&gt;" to that person from your account.</summary>
    public Task<ActionResult> PageContactAsync(string nickname, string reason, CancellationToken ct = default) =>
        PostAsync("/ui/contacts/page", new JsonObject { ["nickname"] = nickname, ["reason"] = reason },
            ok => ok ? "Paged." : "Not paged.", ct, notFound: Contacts.OlderDaemonForPaging);

    /// <summary>Ack a page, or snooze it for 15 or 60 minutes.</summary>
    public Task<ActionResult> PageAsync(string id, bool ack, int minutes = 15, CancellationToken ct = default)
    {
        var body = new JsonObject { ["action"] = ack ? "ack" : "snooze", ["from"] = "tray" };
        if (!ack) body["minutes"] = minutes == 60 ? 60 : 15;
        return PostAsync($"/ui/pages/{Uri.EscapeDataString(id)}", body, ok => ok ? (ack ? "Acked." : "Snoozed.") : "That page is gone.", ct);
    }

    /// <summary>
    /// A chat's small profile photo (GET /ui/avatars/:chatId, JPEG or PNG), or null when it has none,
    /// the daemon is older than avatars, or it can't be reached: the avatar then keeps its initials.
    /// </summary>
    public async Task<byte[]?> AvatarAsync(long chatId, CancellationToken ct = default)
    {
        if (Token() is not { } token) return null;
        try
        {
            using var cts = WithTimeout(ct);
            using var res = await http.SendAsync(Request(HttpMethod.Get, $"/ui/avatars/{chatId}", token), cts.Token);
            if (res.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden) _token = null;
            if (!res.IsSuccessStatusCode) return null;
            var bytes = await res.Content.ReadAsByteArrayAsync(cts.Token);
            return bytes.Length > 0 ? bytes : null;
        }
        catch (Exception e) when (Unreachable(e, ct))
        {
            return null;
        }
    }

    sealed record Answer(bool? Ok, string? Text, string? Nickname);

    /// <param name="fallback">The text when the daemon gave none, by whether it worked.</param>
    /// <param name="notFound">The text for a 404: a daemon without this route.</param>
    async Task<ActionResult> PostAsync(string path, JsonObject body, Func<bool, string> fallback, CancellationToken ct, string? notFound = null)
    {
        if (Token() is not { } token) return new(false, _tokenProblem ?? TokenRead.NoTokenYet);
        try
        {
            using var cts = WithTimeout(ct);
            using var res = await http.SendAsync(Request(HttpMethod.Post, path, token, body), cts.Token);
            if (res.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden)
            {
                _token = null;
                return new(false, res.StatusCode == HttpStatusCode.Forbidden ? WrongToken : Refused);
            }
            if (res.StatusCode == HttpStatusCode.NotFound && notFound is not null) return new(false, notFound);
            Answer? answer = null;
            try { answer = JsonSerializer.Deserialize<Answer>(await res.Content.ReadAsStringAsync(cts.Token), Json.Options); }
            catch (JsonException) { }
            var ok = answer?.Ok ?? res.IsSuccessStatusCode;
            return new(ok, answer?.Text ?? fallback(ok), answer?.Nickname);
        }
        catch (Exception e) when (Unreachable(e, ct))
        {
            return new(false, $"Could not reach the daemon: {e.Message}");
        }
    }

    HttpRequestMessage Request(HttpMethod method, string path, string token, JsonObject? body = null)
    {
        var req = new HttpRequestMessage(method, $"http://127.0.0.1:{port}{path}");
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        // The newer approval kinds this app shows as such (src/shared/protocol.ts, UI_FEATURES_HEADER):
        // without it the daemon keeps new-chat requests from it, since it would show one as a send.
        req.Headers.Add(FeaturesHeader, Features);
        if (body is not null) req.Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json");
        return req;
    }

    static CancellationTokenSource WithTimeout(CancellationToken ct)
    {
        var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cts.CancelAfter(Timeout);
        return cts;
    }

    /// <summary>No daemon, or it didn't answer in time (but not: the caller gave up).</summary>
    static bool Unreachable(Exception e, CancellationToken ct) =>
        e is HttpRequestException || (e is OperationCanceledException && !ct.IsCancellationRequested);
}
