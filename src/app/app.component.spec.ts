import { NavigationEnd, NavigationStart } from '@angular/router';
import { AppComponent } from './app.component';
import { of, Subject, throwError } from 'rxjs';
import { Download } from 'api-types';
import { THEMES_CONFIG } from '../themes';
import { AboutDialogComponent } from './dialogs/about-dialog/about-dialog.component';
import { UserProfileDialogComponent } from './dialogs/user-profile-dialog/user-profile-dialog.component';
import { ArchiveViewerComponent } from './components/archive-viewer/archive-viewer.component';

describe('AppComponent', () => {
  let component: AppComponent;
  let posts_service_mock: any;
  let active_downloads_trigger_mock: any;
  let dialog_mock: any;
  let files_changed_subject: Subject<boolean>;
  let playlists_changed_subject: Subject<boolean>;

  const createDownload = (overrides: Partial<Download>): Download => ({
    uid: 'download-1',
    running: true,
    finished: false,
    paused: false,
    finished_step: false,
    url: 'https://example.com/video',
    type: 'video',
    title: 'Example Video',
    step_index: 2,
    percent_complete: 42.5,
    timestamp_start: 1000,
    ...overrides
  });

  beforeEach(() => {
    files_changed_subject = new Subject<boolean>();
    playlists_changed_subject = new Subject<boolean>();
    posts_service_mock = {
      config_reloaded: of(false),
      files_changed: files_changed_subject,
      playlists_changed: playlists_changed_subject,
      open_create_default_admin_dialog: of(false),
      service_initialized: of(true),
      initialized: true,
      config: { Advanced: { multi_user_mode: false } },
      isLoggedIn: true,
      hasPermission: () => true,
      getCurrentDownloads: () => of({ downloads: [] }),
      pauseDownload: () => of({ success: true }),
      cancelDownload: () => of({ success: true }),
      openSnackBar: () => { },
      reloadSubscriptions: () => { },
      reloadCategories: () => { },
      getVersionInfo: () => of({ version_info: {} }),
      setTheme: () => { },
      theme: { key: 'default', css_label: 'light-theme', background_color: '#fff' }
    };
    const snack_bar_mock: any = {};
    dialog_mock = { open: () => ({ afterClosed: () => of(null) }), openDialogs: [] };
    const router_mock: any = { events: of(), navigate: () => { }, navigateByUrl: () => { }, url: '/' };
    const overlay_container_mock: any = { getContainerElement: () => ({ classList: { remove: () => { }, add: () => { } } }) };
    const element_ref_mock: any = { nativeElement: { ownerDocument: { body: { style: {} } } } };

    component = new AppComponent(posts_service_mock, snack_bar_mock, dialog_mock, router_mock, overlay_container_mock, element_ref_mock, { artworkURL: () => null } as any);

    active_downloads_trigger_mock = {
      menuOpen: false,
      openMenu: vi.fn().mockName('openMenu'),
      closeMenu: vi.fn().mockName('closeMenu')
    };
    component.activeDownloadsTrigger = active_downloads_trigger_mock as any;
  });

  it('should create component instance', () => {
    expect(component).toBeTruthy();
  });

  // In multi-user mode the login page is shown with nobody logged in. Asking for what belongs to
  // a user then only earned a 401 apiece; logging in reloads the config, which asks again.
  describe('loading the config', () => {
    beforeEach(() => {
      vi.spyOn(component, 'setTheme').mockImplementation(() => { });
      posts_service_mock.config = {
        Advanced: { multi_user_mode: true },
        Extra: { title_top: 'ytdl-material', enable_downloads_manager: true, file_manager_enabled: true },
        Subscriptions: { allow_subscriptions: true },
        Themes: { default_theme: 'default', allow_theme_change: true }
      };
      posts_service_mock.reloadSubscriptions = vi.fn().mockName('reloadSubscriptions');
      posts_service_mock.reloadCategories = vi.fn().mockName('reloadCategories');
      posts_service_mock.getDuplicateSummary = () => of({ has_duplicates: false });
    });

    it('asks for no subscriptions or categories before anybody logs in', () => {
      posts_service_mock.hasSession = () => false;

      component.loadConfig();

      expect(posts_service_mock.reloadSubscriptions).not.toHaveBeenCalled();
      expect(posts_service_mock.reloadCategories).not.toHaveBeenCalled();
    });

    it('asks for them once somebody has', () => {
      posts_service_mock.hasSession = () => true;

      component.loadConfig();

      expect(posts_service_mock.reloadSubscriptions).toHaveBeenCalled();
      expect(posts_service_mock.reloadCategories).toHaveBeenCalled();
    });
  });

  it('filters out paused, finished, cancelled and errored downloads', () => {
    posts_service_mock.getCurrentDownloads = () => of({
      downloads: [
        createDownload({ uid: 'active-1', timestamp_start: 1000 }),
        createDownload({ uid: 'paused-1', paused: true, timestamp_start: 2000 }),
        createDownload({ uid: 'finished-1', finished: true, timestamp_start: 3000 }),
        createDownload({ uid: 'cancelled-1', cancelled: true, timestamp_start: 4000 }),
        createDownload({ uid: 'error-1', error: 'failed', timestamp_start: 5000 }),
        createDownload({ uid: 'active-2', timestamp_start: 6000 })
      ]
    });

    (component as any).refreshActiveDownloads();

    expect(component.active_download_count).toBe(2);
    expect(component.active_downloads.map(download => download.uid)).toEqual(['active-2', 'active-1']);
  });

  it('requests only unfinished downloads for active download polling', () => {
    posts_service_mock.getCurrentDownloads = vi.fn().mockName('getCurrentDownloads').mockReturnValue(of({ downloads: [] }));

    (component as any).refreshActiveDownloads();

    expect(posts_service_mock.getCurrentDownloads).toHaveBeenCalledWith(null, true);
  });

  describe('in multi-user mode', () => {
    beforeEach(() => {
      posts_service_mock.config = { Advanced: { multi_user_mode: true } };
      posts_service_mock.getCurrentDownloads = vi.fn().mockName('getCurrentDownloads').mockReturnValue(of({ downloads: [] }));
    });

    it('polls downloads for an account that may list them', () => {
      posts_service_mock.hasPermission = vi.fn().mockReturnValue(true);

      (component as any).refreshActiveDownloads();

      expect(posts_service_mock.hasPermission).toHaveBeenCalledWith('downloads_manager');
      expect(posts_service_mock.getCurrentDownloads).toHaveBeenCalled();
    });

    it('asks nothing for an account without downloads_manager, which would be refused every poll', () => {
      posts_service_mock.hasPermission = vi.fn().mockReturnValue(false);
      const schedule_spy = vi.spyOn(component as any, 'scheduleNextActiveDownloadsPoll').mockReturnValue(undefined);

      (component as any).refreshActiveDownloads();

      expect(posts_service_mock.getCurrentDownloads).not.toHaveBeenCalled();
      expect(component.active_download_count).toBe(0);
      // Still ticking, without a request, so an account that can list them is picked up after a
      // log out and log in.
      expect(schedule_spy).toHaveBeenCalled();
    });

    it('asks nothing while nobody is logged in', () => {
      posts_service_mock.isLoggedIn = false;
      vi.spyOn(component as any, 'scheduleNextActiveDownloadsPoll').mockReturnValue(undefined);

      (component as any).refreshActiveDownloads();

      expect(posts_service_mock.getCurrentDownloads).not.toHaveBeenCalled();
    });
  });

  it('does not auto-open on initial active download load', () => {
    const show_spy = vi.spyOn(component as any, 'showActiveDownloadsMenuTemporarily').mockReturnValue(undefined);
    (component as any).active_downloads_initialized = false;

    (component as any).setActiveDownloads([createDownload({ uid: 'active-1' })]);

    expect(show_spy).not.toHaveBeenCalled();
  });

  it('auto-opens when a new active download appears after initialization', () => {
    vi.useFakeTimers();
    const show_spy = vi.spyOn(component as any, 'showActiveDownloadsMenuTemporarily').mockReturnValue(undefined);
    (component as any).active_downloads_initialized = true;
    component.active_download_count = 0;
    (component as any).active_download_uids = new Set<string>();

    (component as any).setActiveDownloads([createDownload({ uid: 'active-1' })]);
    vi.advanceTimersByTime(1);

    expect(show_spy).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('auto-close timer closes the menu when auto-opened', () => {
    vi.useFakeTimers();
    active_downloads_trigger_mock.menuOpen = true;
    (component as any).active_downloads_auto_opened = true;

    (component as any).scheduleActiveDownloadsAutoClose();
    vi.advanceTimersByTime(5000);

    expect(active_downloads_trigger_mock.closeMenu).toHaveBeenCalled();
    expect((component as any).active_downloads_auto_opened).toBe(false);
    vi.useRealTimers();
  });

  it('shows green completion badge for a short time after final successful completion', () => {
    vi.useFakeTimers();
    (component as any).active_downloads_initialized = true;
    component.active_download_count = 1;
    (component as any).active_download_uids = new Set<string>(['active-1']);

    (component as any).setActiveDownloads([], true);

    expect(component.show_completion_badge).toBe(true);
    expect(component.shouldShowActiveDownloadsIndicator()).toBe(true);
    expect(component.getActiveDownloadsBadgeValue()).toBe('✓');
    expect(component.getActiveDownloadsBadgeColor()).toBe('accent');
    expect(component.getActiveDownloadsIndicatorIcon()).toBe('download_done');

    vi.advanceTimersByTime(2501);
    expect(component.show_completion_badge).toBe(false);
    expect(component.shouldShowActiveDownloadsIndicator()).toBe(false);
    vi.useRealTimers();
  });

  it('emits file refresh when a download disappears from the unfinished queue', () => {
    const files_changed_spy = vi.spyOn(files_changed_subject, 'next');
    (component as any).active_downloads_initialized = true;
    (component as any).previous_download_states = new Map([
      ['download-1', { finished: false, errored: false, is_playlist: false }]
    ]);
    posts_service_mock.getCurrentDownloads = () => of({ downloads: [] });

    (component as any).refreshActiveDownloads();

    expect(files_changed_spy).toHaveBeenCalledWith(true);
  });

  it('emits playlist refresh when a playlist download disappears from the unfinished queue', () => {
    const files_changed_spy = vi.spyOn(files_changed_subject, 'next');
    const playlists_changed_spy = vi.spyOn(playlists_changed_subject, 'next');
    (component as any).active_downloads_initialized = true;
    (component as any).previous_download_states = new Map([
      ['download-2', { finished: false, errored: false, is_playlist: true }]
    ]);
    posts_service_mock.getCurrentDownloads = () => of({ downloads: [] });

    (component as any).refreshActiveDownloads();

    expect(files_changed_spy).toHaveBeenCalledWith(true);
    expect(playlists_changed_spy).toHaveBeenCalledWith(true);
  });

  it('clears completion badge immediately when new active downloads appear', () => {
    component.show_completion_badge = true;
    component.active_download_count = 0;
    (component as any).setActiveDownloads([createDownload({ uid: 'active-1' })], false);

    expect(component.show_completion_badge).toBe(false);
    expect(component.getActiveDownloadsBadgeValue()).toBe(1);
    expect(component.getActiveDownloadsBadgeColor()).toBe('warn');
    expect(component.getActiveDownloadsIndicatorIcon()).toBe('download');
  });

  it('detects playlist item progress only when multiple playlist items exist', () => {
    expect(component.hasPlaylistItemProgress(createDownload({
      uid: 'playlist-1',
      playlist_item_progress: [{ index: 1 } as any]
    } as any))).toBe(false);

    expect(component.hasPlaylistItemProgress(createDownload({
      uid: 'playlist-2',
      playlist_item_progress: [{ index: 1 } as any, { index: 2 } as any]
    } as any))).toBe(true);
  });

  it('opens playlist progress dialog from topbar row icon', () => {
    const close_subject = new Subject<void>();
    const dialog_ref_mock: any = {
      afterClosed: () => close_subject.asObservable(),
      componentInstance: { updateDownload: vi.fn().mockName('updateDownload') }
    };
    const open_spy = vi.spyOn(dialog_mock, 'open').mockReturnValue(dialog_ref_mock);
    dialog_mock.openDialogs = [dialog_ref_mock];
    const click_event_mock = { stopPropagation: vi.fn().mockName('stopPropagation') } as any;
    const playlist_download = createDownload({
      uid: 'playlist-3'
    } as any) as any;
    playlist_download.playlist_item_progress = [{ index: 1 }, { index: 2 }];

    component.openPlaylistProgress(playlist_download, click_event_mock);

    expect(click_event_mock.stopPropagation).toHaveBeenCalled();
    expect(open_spy).toHaveBeenCalled();
    expect((component as any).playlist_progress_dialog_ref).toBe(dialog_ref_mock);
  });

  it('refreshes opened playlist progress dialog with latest matching download data', () => {
    const update_download_spy = vi.fn().mockName('updateDownload');
    const dialog_ref_mock: any = {
      componentInstance: { updateDownload: update_download_spy }
    };
    (component as any).playlist_progress_dialog_ref = dialog_ref_mock;
    (component as any).playlist_progress_dialog_key = 'playlist-4';
    dialog_mock.openDialogs = [dialog_ref_mock];
    component.active_downloads = [
      createDownload({ uid: 'playlist-4' } as any) as any
    ];
    (component.active_downloads[0] as any).playlist_item_progress = [{ index: 1 }, { index: 2 }];

    (component as any).refreshOpenPlaylistProgressDialog();

    expect(update_download_spy).toHaveBeenCalledWith(component.active_downloads[0] as any);
  });

  it('pause action calls pauseDownload for the selected download', () => {
    const pause_spy = vi.spyOn(posts_service_mock, 'pauseDownload').mockReturnValue(of({ success: true }));
    const event_mock = { stopPropagation: vi.fn().mockName('stopPropagation') } as any;

    component.pauseActiveDownload(createDownload({ uid: 'active-1' }), event_mock);

    expect(event_mock.stopPropagation).toHaveBeenCalled();
    expect(pause_spy).toHaveBeenCalledWith('active-1');
  });

  it('cancel action calls cancelDownload for the selected download', () => {
    const cancel_spy = vi.spyOn(posts_service_mock, 'cancelDownload').mockReturnValue(of({ success: true }));
    const event_mock = { stopPropagation: vi.fn().mockName('stopPropagation') } as any;

    component.cancelActiveDownload(createDownload({ uid: 'active-1' }), event_mock);

    expect(event_mock.stopPropagation).toHaveBeenCalled();
    expect(cancel_spy).toHaveBeenCalledWith('active-1');
  });

  describe('download polling lifecycle', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      posts_service_mock.getCurrentDownloads = vi.fn().mockReturnValue(of({downloads: []}));
    });

    afterEach(() => {
      component.ngOnDestroy();
      vi.clearAllTimers();
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it('waits for initialization, polls active downloads faster, and stops on destroy', () => {
      const initialized = new Subject<boolean>();
      posts_service_mock.initialized = false;
      posts_service_mock.service_initialized = initialized;
      posts_service_mock.getCurrentDownloads
        .mockReturnValueOnce(of({downloads: [createDownload({})]}));
      component.ngOnInit();
      initialized.next(false);
      expect(posts_service_mock.getCurrentDownloads).not.toHaveBeenCalled();
      initialized.next(true);
      initialized.next(true);
      initialized.complete();
      expect(posts_service_mock.getCurrentDownloads).toHaveBeenCalledTimes(1);
      expect(component.active_download_count).toBe(1);

      vi.advanceTimersByTime(999);
      expect(posts_service_mock.getCurrentDownloads).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1);
      expect(posts_service_mock.getCurrentDownloads).toHaveBeenCalledTimes(2);
      expect(component.active_download_count).toBe(0);
      vi.advanceTimersByTime(9999);
      expect(posts_service_mock.getCurrentDownloads).toHaveBeenCalledTimes(2);
      vi.advanceTimersByTime(1);
      expect(posts_service_mock.getCurrentDownloads).toHaveBeenCalledTimes(3);

      component.ngOnDestroy();
      vi.advanceTimersByTime(20000);
      expect(posts_service_mock.getCurrentDownloads).toHaveBeenCalledTimes(3);
    });

    it('backs off after a request error and resumes polling after recovery', () => {
      posts_service_mock.getCurrentDownloads
        .mockReturnValueOnce(throwError(() => new Error('Offline')))
        .mockReturnValue(of({downloads: [createDownload({})]}));
      component.ngOnInit();
      expect(posts_service_mock.getCurrentDownloads).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(9999);
      expect(posts_service_mock.getCurrentDownloads).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1);
      expect(posts_service_mock.getCurrentDownloads).toHaveBeenCalledTimes(2);
      expect(component.active_download_count).toBe(1);
      vi.advanceTimersByTime(1000);
      expect(posts_service_mock.getCurrentDownloads).toHaveBeenCalledTimes(3);
    });

    it('keeps a manually opened menu open after a newly queued download appears', () => {
      posts_service_mock.getCurrentDownloads
        .mockReturnValueOnce(of({downloads: []}))
        .mockReturnValue(of({downloads: [createDownload({})]}));
      component.ngOnInit();
      vi.advanceTimersByTime(10001);
      expect(active_downloads_trigger_mock.openMenu).toHaveBeenCalledTimes(1);
      active_downloads_trigger_mock.menuOpen = true;
      component.activeDownloadsMenuButtonClicked();
      component.activeDownloadsMenuOpened();
      vi.advanceTimersByTime(5001);
      expect(active_downloads_trigger_mock.closeMenu).not.toHaveBeenCalled();
      component.activeDownloadsMenuClosed();
    });
  });

  describe.each([
    ['pause', 'pauseDownload', 'pauseActiveDownload'],
    ['cancel', 'cancelDownload', 'cancelActiveDownload']
  ] as const)('%s failures', (action, request, handler) => {
    it.each(['refused', 'offline'])('reports a %s request without closing the menu', failure => {
      const event = {stopPropagation: vi.fn()} as any;
      posts_service_mock[request] = vi.fn().mockReturnValue(failure === 'refused'
        ? of({success: false}) : throwError(() => new Error('Offline')));
      posts_service_mock.openSnackBar = vi.fn();
      component[handler](createDownload({uid: 'selected'}), event);
      expect(event.stopPropagation).toHaveBeenCalledTimes(1);
      expect(posts_service_mock[request]).toHaveBeenCalledWith('selected');
      expect(posts_service_mock.openSnackBar).toHaveBeenCalledWith(`Failed to ${action} download! See server logs for more info.`);
      expect(active_downloads_trigger_mock.closeMenu).not.toHaveBeenCalled();
    });

    it('ignores an absent download', () => {
      posts_service_mock[request] = vi.fn();
      component[handler](null, {stopPropagation: vi.fn()} as any);
      expect(posts_service_mock[request]).not.toHaveBeenCalled();
    });
  });

  it.each([
    [42.567, '42.57', 42.567], [-3, '0.00', 0], [120, '100.00', 100],
    [null, null, null], [undefined, null, null], [NaN, null, null], [Infinity, null, null]
  ])('formats download progress %s safely', (percent_complete, label, progress) => {
    const download = createDownload({percent_complete});
    expect(component.shouldShowActiveDownloadPercent(download)).toBe(label !== null);
    expect(component.getActiveDownloadPercent(download)).toBe(label);
    expect(component.getActiveDownloadProgressValue(download)).toBe(progress);
  });

  it.each([{paused: true}, {finished: true}, {error: 'Failed'}])('hides progress for an inactive download (%s)', state => {
    expect(component.shouldShowActiveDownloadPercent(createDownload(state))).toBe(false);
  });
});

describe('AppComponent notification bell', () => {
  let component: AppComponent;

  beforeEach(() => {
    const posts_service_mock: any = {
      config_reloaded: of(false),
      files_changed: new Subject<boolean>(),
      open_create_default_admin_dialog: of(false),
      service_initialized: of(true),
      initialized: true,
      config: { Advanced: { multi_user_mode: false } },
      getCurrentDownloads: () => of({ downloads: [] })
    };
    const router_mock: any = { events: of(), navigate: () => { }, url: '/' };
    const element_ref_mock: any = { nativeElement: { ownerDocument: { body: { style: {} } } } };
    component = new AppComponent(posts_service_mock, {} as any, { openDialogs: [] } as any, router_mock, {} as any, element_ref_mock, { artworkURL: () => null } as any);
  });

  it('counts up to ninety-nine and then stops growing', () => {
    component.notification_count = 0;
    expect(component.notificationBadge).toBe('0');

    component.notification_count = 99;
    expect(component.notificationBadge).toBe('99');

    component.notification_count = 250;
    expect(component.notificationBadge).toBe('99+');
  });

  it('says how many are waiting, for anyone who cannot see the badge', () => {
    component.notification_count = 0;
    expect(component.notificationsLabel).toBe('Notifications');

    component.notification_count = 3;
    expect(component.notificationsLabel).toContain('3');
  });
});

describe('AppComponent themes', () => {
  let component: AppComponent;
  let posts_service_mock: any;
  let overlay: HTMLElement;
  let body_style: any;

  beforeEach(() => {
    localStorage.clear();
    overlay = document.createElement('div');
    body_style = {};
    posts_service_mock = {
      config_reloaded: of(false),
      files_changed: new Subject<boolean>(),
      open_create_default_admin_dialog: of(false),
      service_initialized: new Subject<boolean>(),
      initialized: false,
      config: { Advanced: { multi_user_mode: false } },
      hasPermission: () => true,
      hasSession: () => false,
      getVersionInfo: () => of({ version_info: {} }),
      // What the real service does, so the toggle can read the theme it was given.
      setTheme: vi.fn((theme: string) => { posts_service_mock.theme = THEMES_CONFIG[theme]; })
    };
    component = new AppComponent(posts_service_mock, {} as any, { openDialogs: [] } as any,
      { events: of(), navigate: vi.fn(), url: '/' } as any, { getContainerElement: () => overlay } as any,
      { nativeElement: { ownerDocument: { body: { style: body_style } } } } as any, { artworkURL: () => null } as any);
  });

  afterEach(() => {
    localStorage.clear();
    document.body.classList.remove('default-theme', 'dark-theme');
    vi.restoreAllMocks();
  });

  function loadConfig(default_theme: string) {
    posts_service_mock.config = {
      Advanced: { multi_user_mode: false },
      Extra: { title_top: 'ytdl-material', enable_downloads_manager: false, file_manager_enabled: false },
      Subscriptions: { allow_subscriptions: false },
      Themes: { default_theme, allow_theme_change: true }
    };
    component.loadConfig();
  }

  // A stored theme this version does not have used to be refused, so no theme was applied at
  // all, and the toggle in the account menu then threw on the theme that was never set.
  it('applies the default theme in place of a stored one it does not know, and can still switch', () => {
    vi.spyOn(console, 'error').mockImplementation(() => { });
    localStorage.setItem('theme', 'retired');

    loadConfig('dark');

    expect(posts_service_mock.setTheme).toHaveBeenCalledWith('dark');
    expect(localStorage.getItem('theme')).toBe('dark');
    expect(overlay.classList.contains('dark-theme')).toBe(true);

    component.themeMenuItemClicked({ stopPropagation: () => { } });

    expect(localStorage.getItem('theme')).toBe('default');
    expect(overlay.classList.contains('dark-theme')).toBe(false);
    expect(overlay.classList.contains('default-theme')).toBe(true);
  });

  it('falls back to the light theme when the configured default does not exist', () => {
    vi.spyOn(console, 'error').mockImplementation(() => { });

    loadConfig('neon');

    expect(posts_service_mock.setTheme).toHaveBeenCalledWith('default');
    expect(component.componentCssClass).toBe('default-theme');
  });

  it('switches theme before the config has loaded, whatever was stored', () => {
    vi.spyOn(console, 'error').mockImplementation(() => { });
    vi.spyOn(console, 'log').mockImplementation(() => { });
    localStorage.setItem('theme', 'retired');

    component.setTheme('dark');

    expect(localStorage.getItem('theme')).toBe('dark');
    expect(overlay.classList.contains('dark-theme')).toBe(true);
    expect(body_style.backgroundColor).toBe('#0b0b0b');
  });

  it('does not take a name every object has for a theme', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => { });

    component.setTheme('constructor');

    expect(error).toHaveBeenCalledWith('Invalid theme: constructor');
    expect(posts_service_mock.setTheme).not.toHaveBeenCalled();
    expect(localStorage.getItem('theme')).toBeNull();
  });

  it('stores a theme, paints the page with it and swaps the previous theme class out', () => {
    component.setTheme('dark');

    expect(localStorage.getItem('theme')).toBe('dark');
    expect(body_style.backgroundColor).toBe('#0b0b0b');
    expect(posts_service_mock.setTheme).toHaveBeenCalledWith('dark');
    expect(component.componentCssClass).toBe('dark-theme');
    expect(overlay.classList.contains('dark-theme')).toBe(true);

    document.body.classList.add('dark-theme');
    component.setTheme('default');

    expect(localStorage.getItem('theme')).toBe('default');
    expect(overlay.classList.contains('dark-theme')).toBe(false);
    expect(document.body.classList.contains('dark-theme')).toBe(false);
    expect(overlay.classList.contains('default-theme')).toBe(true);
  });

  it('refuses a theme it does not know and leaves the current one alone', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => { });
    localStorage.setItem('theme', 'dark');

    component.setTheme('neon');

    expect(error).toHaveBeenCalledWith('Invalid theme: neon');
    expect(localStorage.getItem('theme')).toBe('dark');
    expect(posts_service_mock.setTheme).not.toHaveBeenCalled();
  });

  it('keeps each user\'s theme apart in multi-user mode and drops the shared one', () => {
    posts_service_mock.config.Advanced.multi_user_mode = true;
    posts_service_mock.user = { uid: 'alice' };
    localStorage.setItem('theme', 'dark');

    expect(component.getThemeStorageKey()).toBe('theme_alice');
    expect(component.getStoredTheme()).toBe('dark');

    component.setTheme('default');

    expect(localStorage.getItem('theme_alice')).toBe('default');
    expect(localStorage.getItem('theme')).toBeNull();
    posts_service_mock.user = null;
    expect(component.getThemeStorageKey()).toBe('theme');
  });

  it('applies the stored theme when it starts', () => {
    localStorage.setItem('theme', 'dark');

    component.ngOnInit();

    expect(posts_service_mock.setTheme).toHaveBeenCalledWith('dark');
    expect(component.componentCssClass).toBe('dark-theme');
  });

  it('flips between light and dark from the menu without closing it', () => {
    const event = { stopPropagation: vi.fn() };
    component.setTheme('default');

    component.themeMenuItemClicked(event);
    expect(posts_service_mock.setTheme).toHaveBeenLastCalledWith('dark');
    expect(event.stopPropagation).toHaveBeenCalled();

    component.flipTheme();
    expect(posts_service_mock.setTheme).toHaveBeenLastCalledWith('default');
  });
});

describe('AppComponent navigation', () => {
  let component: AppComponent;
  let posts_service_mock: any;
  let router_mock: any;
  let router_events: Subject<any>;
  let dialog_mock: any;

  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    router_events = new Subject();
    router_mock = { events: router_events, navigate: vi.fn(), navigateByUrl: vi.fn(), url: '/' };
    dialog_mock = { open: vi.fn().mockReturnValue({ afterClosed: () => of(false) }), openDialogs: [] };
    posts_service_mock = {
      config_reloaded: of(false),
      files_changed: new Subject<boolean>(),
      open_create_default_admin_dialog: of(false),
      service_initialized: new Subject<boolean>(),
      initialized: false,
      config: { Advanced: { multi_user_mode: false } }
    };
    component = new AppComponent(posts_service_mock, {} as any, dialog_mock, router_mock, {} as any,
      { nativeElement: { ownerDocument: { body: { style: {} } } } } as any, { artworkURL: () => null } as any);
  });

  afterEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it('goes back to the page that opened the player, or home when nothing did', () => {
    component.goBack();
    expect(router_mock.navigate).toHaveBeenCalledWith(['/']);

    sessionStorage.setItem('player_navigator_path', '/playlists?tab=mine');
    router_events.next(new NavigationStart(1, '/player'));
    component.goBack();
    expect(router_mock.navigateByUrl).toHaveBeenCalledWith('/playlists?tab=mine');
  });

  it('takes focus off the menu button once a navigation finishes', () => {
    const button = { blur: vi.fn() };
    component.hamburgerMenuButton = { nativeElement: button } as any;

    router_events.next(new NavigationEnd(1, '/subscriptions', '/subscriptions'));

    expect(button.blur).toHaveBeenCalledOnce();
  });

  it('sends anyone who closes the first-run admin dialog to the login page', () => {
    posts_service_mock.open_create_default_admin_dialog = of(true);

    component.ngOnInit();
    expect(dialog_mock.open).toHaveBeenCalledOnce();
    expect(router_mock.navigate).toHaveBeenCalledWith(['/login']);

    router_mock.navigate.mockClear();
    router_mock.url = '/login';
    component.ngOnInit();
    expect(router_mock.navigate).not.toHaveBeenCalled();
  });

  it('opens the about, profile and archive dialogs', () => {
    component.openAboutDialog();
    component.openProfileDialog();
    component.openArchiveDialog();

    expect(dialog_mock.open.mock.calls.map(([dialog]) => dialog))
      .toEqual([AboutDialogComponent, UserProfileDialogComponent, ArchiveViewerComponent]);
  });

  it('counts unread notifications and marks them read once the menu closes', () => {
    const notifications = { getNotifications: vi.fn(), setNotificationsToRead: vi.fn() };
    component.notifications = notifications as any;

    component.notificationCountUpdate(4);
    component.notificationMenuOpened();
    component.notificationMenuClosed();

    expect(component.notification_count).toBe(4);
    expect(notifications.getNotifications).toHaveBeenCalledOnce();
    expect(notifications.setNotificationsToRead).toHaveBeenCalledOnce();
  });

  it('names the step a download is on, and falls back for one it does not know', () => {
    expect(component.getActiveDownloadStepLabel({ step_index: 1 } as any)).toBe('Getting info');
    expect(component.getActiveDownloadStepLabel({ step_index: 99 } as any)).toBe('Downloading file');
  });
});

describe('AppComponent while browsing someone else\'s library', () => {
  let component: AppComponent;
  let posts_service_mock: any;
  let router_mock: any;

  beforeEach(() => {
    posts_service_mock = {
      config_reloaded: of(false),
      files_changed: new Subject<boolean>(),
      open_create_default_admin_dialog: of(false),
      service_initialized: of(true),
      initialized: true,
      config: { Advanced: { multi_user_mode: true } },
      getCurrentDownloads: () => of({ downloads: [] }),
      viewed_library: { uid: 'bob', name: 'Bob' },
      viewLibrary: vi.fn()
    };
    router_mock = { events: of(), navigate: vi.fn(), url: '/?uid=file-1' };
    const element_ref_mock: any = { nativeElement: { ownerDocument: { body: { style: {} } } } };
    component = new AppComponent(posts_service_mock, {} as any, { openDialogs: [] } as any, router_mock, {} as any, element_ref_mock, { artworkURL: () => null } as any);
  });

  it('says whose library it is, and that the button leaves it', () => {
    expect(component.viewingLibraryLabel).toBe('Browsing Bob\'s library. Back to yours');
  });

  it.each(['/?uid=file-1', '/?v=FileLink123', '/?v=AudioLink12', '/?list=ListLink123'])('uses the player navigation controls on %s', url => {
    router_mock.url = url;
    expect(component.isPlayerPage).toBe(true);
    router_mock.url = '/';
    expect(component.isPlayerPage).toBe(false);
  });

  it('goes back to your own library in one press, from wherever you are', () => {
    component.returnToOwnLibrary();

    expect(posts_service_mock.viewLibrary).toHaveBeenCalledWith(null);
    expect(router_mock.navigate).toHaveBeenCalledWith(['/']);
  });

  it('keeps the link to your own downloads out of the toolbar until you are back', () => {
    component.enableDownloadsManager = true;
    posts_service_mock.hasPermission = vi.fn().mockReturnValue(true);
    expect(component.canOpenDownloadsPage()).toBe(false);

    posts_service_mock.viewed_library = null;
    expect(component.canOpenDownloadsPage()).toBe(true);
  });
});

describe('AppComponent shell', () => {
  let component: AppComponent;
  let posts_service_mock: any;
  let dialog_mock: any;
  let reloaded: Subject<boolean>;

  function create(): void {
    component = new AppComponent(posts_service_mock, {} as any, dialog_mock,
      { events: of(), navigate: vi.fn(), url: '/' } as any, { getContainerElement: () => document.createElement('div') } as any,
      { nativeElement: { ownerDocument: { body: { style: {} } } } } as any, { artworkURL: () => null } as any);
  }

  beforeEach(() => {
    reloaded = new Subject<boolean>();
    posts_service_mock = {
      config_reloaded: reloaded,
      files_changed: new Subject<boolean>(),
      open_create_default_admin_dialog: of(false),
      service_initialized: new Subject<boolean>(),
      initialized: false,
      isLoggedIn: false,
      config: { Advanced: { multi_user_mode: true }, Extra: { file_manager_enabled: true } },
      hasPermission: () => true,
      getDuplicateSummary: vi.fn(() => of({ has_duplicates: true }))
    };
    dialog_mock = { openDialogs: [], open: vi.fn() };
  });

  afterEach(() => {
    component?.ngOnDestroy();
    vi.restoreAllMocks();
  });

  it('loads its settings again whenever they change', () => {
    const load_spy = vi.spyOn(AppComponent.prototype, 'loadConfig').mockReturnValue(undefined);
    create();
    reloaded.next(false);
    expect(load_spy).not.toHaveBeenCalled();
    reloaded.next(true);
    expect(load_spy).toHaveBeenCalledTimes(1);
  });

  it('opens and closes the side navigation', () => {
    create();
    component.sidenav = { toggle: vi.fn() } as any;
    component.toggleSidenav();
    expect(component.sidenav.toggle).toHaveBeenCalled();
  });

  it('keeps one playlist progress dialog open, follows its download, and closes it on the way out', () => {
    create();
    const opened: any[] = [];
    dialog_mock.open = vi.fn(() => {
      const ref = { close: vi.fn(), afterClosed: () => new Subject<void>(), componentInstance: { updateDownload: vi.fn() } };
      opened.push(ref);
      dialog_mock.openDialogs = [ref];
      return ref;
    });
    const download = { uid: 'download-1', playlist_item_progress: [{ index: 1 }, { index: 2 }] } as any;
    const click = { stopPropagation: vi.fn() } as any;

    component.openPlaylistProgress(download, click);
    component.openPlaylistProgress(download, click);
    expect(opened[0].close).toHaveBeenCalled();

    (component as any).setActiveDownloads([{ ...download, percent_complete: 50 }]);
    expect(opened[1].componentInstance.updateDownload).toHaveBeenCalledWith(expect.objectContaining({ percent_complete: 50 }));

    component.ngOnDestroy();
    expect(opened[1].close).toHaveBeenCalled();

    // Closed by something else, it is forgotten rather than updated.
    dialog_mock.openDialogs = [];
    (component as any).refreshOpenPlaylistProgressDialog();
    expect((component as any).playlist_progress_dialog_ref).toBeNull();
  });

  it('closes the downloads menu once nothing is downloading', () => {
    create();
    component.activeDownloadsTrigger = { menuOpen: true, closeMenu: vi.fn() } as any;
    (component as any).setActiveDownloads([]);
    expect(component.activeDownloadsTrigger.closeMenu).toHaveBeenCalled();
  });

  it('restarts the completion badge\'s timer when another download finishes', () => {
    vi.useFakeTimers();
    try {
      create();
      (component as any).showCompletionBadgeTemporarily();
      vi.advanceTimersByTime((component as any).ACTIVE_DOWNLOADS_COMPLETION_BADGE_MS - 1);
      (component as any).showCompletionBadgeTemporarily();
      vi.advanceTimersByTime((component as any).ACTIVE_DOWNLOADS_COMPLETION_BADGE_MS - 1);
      expect(component.show_completion_badge).toBe(true);
      vi.advanceTimersByTime(1);
      expect(component.show_completion_badge).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('links to the duplicates only for those who can see them, once signed in, and while the server answers', () => {
    create();
    const refresh = () => (component as any).refreshDuplicateSummary();

    component.canViewDuplicates = false;
    refresh();
    expect(component.hasDuplicateGroups).toBe(false);

    component.canViewDuplicates = true;
    refresh();
    expect(component.hasDuplicateGroups).toBe(false);
    expect(posts_service_mock.getDuplicateSummary).not.toHaveBeenCalled();

    posts_service_mock.isLoggedIn = true;
    refresh();
    expect(component.hasDuplicateGroups).toBe(true);

    posts_service_mock.getDuplicateSummary.mockReturnValue(throwError(() => new Error('offline')));
    refresh();
    expect(component.hasDuplicateGroups).toBe(false);
  });
});
