using TelegramMCPTray.Core;
using Xunit;

namespace TelegramMCPTray.Tests;

public class SettingsTests
{
    static readonly string Profile = Path.Combine(Path.GetTempPath(), "profile-of-someone");
    static readonly string DefaultHome = Path.Combine(Profile, ".config", "telegram-mcp");
    static readonly string OtherHome = Path.Combine(Path.GetTempPath(), "tgmcp-demo");

    static Func<string, string?> Env(params (string Key, string Value)[] vars) =>
        key => vars.FirstOrDefault(v => v.Key == key).Value;

    [Fact]
    public void Defaults_match_the_daemon()
    {
        var s = Settings.Load([], Env(), Profile);

        Assert.Equal(DefaultHome, s.Home);
        Assert.Equal(47823, s.Port);
        Assert.False(s.FileSecrets);
    }

    [Fact]
    public void Default_home_reads_the_bare_ui_token_credential()
    {
        // Bun.secrets on Windows writes the generic credential "<service>/<name>".
        Assert.Equal("telegram-mcp/ui-token", Settings.Load([], Env(), Profile).UiTokenTarget);
    }

    [Fact]
    public void Another_home_reads_its_own_token_credential()
    {
        var s = Settings.Load([], Env(("TELEGRAM_MCP_HOME", OtherHome)), Profile);

        Assert.Equal($"telegram-mcp/ui-token@{OtherHome}", s.UiTokenTarget);
    }

    [Fact]
    public void Trailing_separator_is_dropped_like_node_path_resolve()
    {
        var withSlash = Settings.Load([], Env(("TELEGRAM_MCP_HOME", DefaultHome + Path.DirectorySeparatorChar)), Profile);
        var other = Settings.Load([], Env(("TELEGRAM_MCP_HOME", OtherHome + Path.DirectorySeparatorChar)), Profile);

        Assert.Equal("telegram-mcp/ui-token", withSlash.UiTokenTarget);
        Assert.Equal($"telegram-mcp/ui-token@{OtherHome}", other.UiTokenTarget);
    }

    [Fact]
    public void Token_file_is_in_the_home_folder()
    {
        var s = Settings.Load([], Env(("TELEGRAM_MCP_HOME", OtherHome)), Profile);

        Assert.Equal(Path.Combine(OtherHome, "ui-token"), s.UiTokenFile);
    }

    [Fact]
    public void Environment_sets_port_and_file_secrets()
    {
        var s = Settings.Load([], Env(("TELEGRAM_MCP_PORT", "47901"), ("TELEGRAM_MCP_SECRET_STORE", "File")), Profile);

        Assert.Equal(47901, s.Port);
        Assert.True(s.FileSecrets);
    }

    [Fact]
    public void Arguments_win_over_the_environment()
    {
        // The Run key that starts the app at login can't set environment variables.
        var env = Env(("TELEGRAM_MCP_HOME", "/elsewhere"), ("TELEGRAM_MCP_PORT", "1234"), ("TELEGRAM_MCP_SECRET_STORE", "keychain"));
        var s = Settings.Load(["--home", OtherHome, "--port", "47901", "--secret-store", "file"], env, Profile);

        Assert.Equal(OtherHome, s.Home);
        Assert.Equal(47901, s.Port);
        Assert.True(s.FileSecrets);
    }

    [Theory]
    [InlineData("0")]
    [InlineData("65536")]
    [InlineData("abc")]
    [InlineData("")]
    public void Bad_port_falls_back_to_the_default(string port)
    {
        Assert.Equal(47823, Settings.Load([], Env(("TELEGRAM_MCP_PORT", port)), Profile).Port);
    }

    [Fact]
    public void Launch_arguments_reproduce_the_settings()
    {
        var s = Settings.Load(["--home", Path.Combine(OtherHome, "with space"), "--port", "47901", "--secret-store", "file"], Env(), Profile);

        Assert.Equal(s, Settings.Load(s.LaunchArgs(), Env(), Profile));
    }

    [Fact]
    public void Launch_arguments_for_the_defaults_name_only_the_home()
    {
        Assert.Equal(["--home", DefaultHome], Settings.Load([], Env(), Profile).LaunchArgs());
    }
}
