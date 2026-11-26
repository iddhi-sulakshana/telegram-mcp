using System;
using System.Drawing;
using System.Linq;
using System.Net.Http;
using System.Windows.Forms;
using System.Windows.Media;
using Microsoft.Win32;
using TelegramMCPTray.Core;
using Application = System.Windows.Application;

namespace TelegramMCPTray;

/// <summary>The tray icon, its menu, the panel and the notifications.</summary>
sealed class TrayController : IDisposable
{
    readonly NotifyIcon _icon = new();
    readonly PanelViewModel _vm;
    readonly PanelWindow _panel;
    readonly Toasts _toasts;
    readonly PageAlarm _alarm;
    Icon? _current;
    IconState? _shownState;
    bool _shownDark;

    public TrayController(Settings settings)
    {
        _alarm = new PageAlarm(settings.Home);
        ITokenSource tokens = settings.FileSecrets ? new FileTokenSource(settings.UiTokenFile) : new CredentialTokenSource(settings.UiTokenTarget);
        _vm = new PanelViewModel(new DaemonApi(new HttpClient(), settings.Port, tokens), settings);
        _panel = new PanelWindow { DataContext = _vm };
        _toasts = new Toasts(IconRenderer.NotificationLogo());

        _vm.Polled += OnPolled;
        _vm.QuitRequested += () => Exit?.Invoke();
        _toasts.Activated += OnNotification;
        _alarm.Act += (id, ack, minutes) =>
        {
            // Quiet at once; the next poll brings back anything still ringing.
            _alarm.Update(Pages.Ringing(_vm.State?.Pages).Where(p => p.Id != id).ToList());
            _ = _vm.PageAsync(id, ack, minutes);
        };

        _icon.Text = "Telegram MCP";
        _icon.MouseClick += (_, e) =>
        {
            if (e.Button == MouseButtons.Left) TogglePanel();
        };
        _icon.ContextMenuStrip = Menu();
        UpdateIcon();
        _icon.Visible = true;
        SystemEvents.UserPreferenceChanged += OnPreferences;
    }

    /// <summary>Quit was chosen (menu, panel, or `--quit`).</summary>
    public event Action? Exit;

    public void Start()
    {
        _toasts.Listen();
        _alarm.Listen();
        _vm.Start();
    }

    ContextMenuStrip Menu()
    {
        var menu = new ContextMenuStrip();
        var open = new ToolStripMenuItem("Open", null, (_, _) => ShowPanel(contacts: false)) { Font = new Font(SystemFonts.MenuFont ?? Control.DefaultFont, System.Drawing.FontStyle.Bold) };
        menu.Items.Add(open);
        menu.Items.Add(new ToolStripMenuItem("Contacts", null, (_, _) => ShowPanel(contacts: true)));
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(new ToolStripMenuItem("Rules", null, (_, _) => _vm.OpenRules.Execute(null)));
        menu.Items.Add(new ToolStripMenuItem("Log", null, (_, _) => _vm.OpenLog.Execute(null)));
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(new ToolStripMenuItem("Quit", null, (_, _) => Exit?.Invoke()));
        return menu;
    }

    void TogglePanel()
    {
        if (_panel.IsVisible) _panel.HidePanel();
        // The click that hid the panel (by taking focus away) shouldn't open it again.
        else if (DateTime.UtcNow - _panel.LastHidden > TimeSpan.FromMilliseconds(300)) ShowPanel(contacts: false);
    }

    public void ShowPanel() => ShowPanel(contacts: false);

    void ShowPanel(bool contacts)
    {
        _vm.ContactsPage = contacts;
        _panel.ShowNearTray();
        _ = _vm.PollAsync();
    }

    void OnNotification(string id, NoticeAction? action)
    {
        // Notification callbacks arrive on a background thread.
        Application.Current.Dispatcher.InvokeAsync(async () =>
        {
            if (action is { } a)
            {
                Toasts.Remove(id);
                await _vm.DecideAsync(id, ApprovalNotices.DecisionFor(a));
            }
            else
            {
                // A draft's notification: open on Waiting, wherever Home was left.
                _vm.ShowWaiting();
                ShowPanel(contacts: false);
            }
        });
    }

    void OnPolled()
    {
        UpdateIcon();
        _icon.Text = Presenter.Tooltip(_vm.State, _vm.Reachable, _vm.Problem);
        if (_vm.Reachable && _vm.State is { } s)
        {
            _toasts.Update(s.Approvals);
            _alarm.Update(Pages.Ringing(s.Pages));
        }
    }

    void UpdateIcon()
    {
        var state = Presenter.Icon(_vm.State, _vm.Reachable);
        var dark = Theme.TaskbarDark;
        if (state == _shownState && dark == _shownDark && _current is not null) return;
        var next = IconRenderer.Render(state, dark, SystemInformation.SmallIconSize.Width);
        _icon.Icon = next;
        if (_current is not null)
        {
            Native.DestroyIcon(_current.Handle);
            _current.Dispose();
        }
        _current = next;
        _shownState = state;
        _shownDark = dark;
    }

    void OnPreferences(object? sender, UserPreferenceChangedEventArgs e)
    {
        if (e.Category is not (UserPreferenceCategory.General or UserPreferenceCategory.Color or UserPreferenceCategory.VisualStyle)) return;
        Application.Current.Dispatcher.InvokeAsync(() =>
        {
            Theme.Apply(Application.Current.Resources);
            _panel.ApplyBackdrop(); // acrylic follows light/dark too
            _alarm.ApplyBackdrop();
            _shownState = null; // redraw for the taskbar's colour
            UpdateIcon();
        });
    }

    public void Dispose()
    {
        SystemEvents.UserPreferenceChanged -= OnPreferences;
        Toasts.Clear();
        _alarm.Stop();
        _icon.Visible = false;
        _icon.Dispose();
        if (_current is not null) Native.DestroyIcon(_current.Handle);
        _panel.Close();
    }
}
