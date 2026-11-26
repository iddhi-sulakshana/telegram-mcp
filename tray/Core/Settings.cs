using System.Globalization;

namespace TelegramMCPTray.Core;

/// <summary>
/// Where the daemon is and how to read the apps' token (secret "ui-token"): the same TELEGRAM_MCP_HOME, TELEGRAM_MCP_PORT and
/// TELEGRAM_MCP_SECRET_STORE the CLI and the daemon use (src/shared/paths.ts, secrets.ts). Arguments
/// (--home, --port, --secret-store) win, because the Run key that starts the app at login can't set
/// environment variables.
/// </summary>
public sealed record Settings(string Home, int Port, bool FileSecrets, string DefaultHome)
{
    public const int DefaultPort = 47823;

    /// <param name="userProfile">What Node's os.homedir() gives on Windows: %USERPROFILE%.</param>
    public static Settings Load(IReadOnlyList<string> args, Func<string, string?> env, string userProfile)
    {
        string? Arg(string name)
        {
            for (var i = 0; i + 1 < args.Count; i++) if (args[i] == name) return args[i + 1];
            return null;
        }
        static string? NonEmpty(string? s) => string.IsNullOrEmpty(s) ? null : s;

        var defaultHome = Resolve(Path.Combine(userProfile, ".config", "telegram-mcp"));
        var home = NonEmpty(Arg("--home")) ?? NonEmpty(env("TELEGRAM_MCP_HOME")) ?? defaultHome;
        var port = int.TryParse(Arg("--port") ?? env("TELEGRAM_MCP_PORT"), NumberStyles.Integer, CultureInfo.InvariantCulture, out var p)
                   && p is > 0 and < 65536 ? p : DefaultPort;
        var store = (Arg("--secret-store") ?? env("TELEGRAM_MCP_SECRET_STORE") ?? "").Trim();
        return new Settings(Resolve(home), port, store.Equals("file", StringComparison.OrdinalIgnoreCase), defaultHome);
    }

    /// <summary>Like Node's path.resolve: absolute, separators normalized, no trailing separator.</summary>
    static string Resolve(string path)
    {
        var full = Path.GetFullPath(path);
        var root = Path.GetPathRoot(full) ?? "";
        return full.Length > root.Length ? full.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar) : full;
    }

    /// <summary>The secret this app reads: the menu bar and tray apps' own token, not the sessions' "token".</summary>
    public const string UiTokenName = "ui-token";

    /// <summary>
    /// The Credential Manager entry. Bun.secrets writes a generic credential named "service/name";
    /// the name is "ui-token" for the default home and "ui-token@&lt;home&gt;" for any other (keychainAccount).
    /// </summary>
    public string UiTokenTarget => "telegram-mcp/" + (string.Equals(Home, DefaultHome, StringComparison.Ordinal) ? UiTokenName : $"{UiTokenName}@{Home}");

    /// <summary>With TELEGRAM_MCP_SECRET_STORE=file the token is this plain file.</summary>
    public string UiTokenFile => Path.Combine(Home, UiTokenName);

    /// <summary>The arguments that start the app with these settings (for the Run key).</summary>
    public IReadOnlyList<string> LaunchArgs()
    {
        List<string> args = ["--home", Home];
        if (Port != DefaultPort) args.AddRange(["--port", Port.ToString(CultureInfo.InvariantCulture)]);
        if (FileSecrets) args.AddRange(["--secret-store", "file"]);
        return args;
    }
}
