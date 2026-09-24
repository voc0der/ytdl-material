import { ComponentFixture, TestBed, waitForAsync } from '@angular/core/testing';
import { EventEmitter } from '@angular/core';
import { of, throwError } from 'rxjs';

import { SettingsComponent } from './settings.component';
import { configureTestBed } from '../../testing/test-bed';

describe('SettingsComponent', () => {
  let component: SettingsComponent;
  let fixture: ComponentFixture<SettingsComponent>;

  beforeEach(waitForAsync(() => {
    configureTestBed({
      imports: [SettingsComponent]
    })
      .compileComponents();
  }));

  beforeEach(() => {
    fixture = TestBed.createComponent(SettingsComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});

describe('SettingsComponent.deleteOrphanFiles', () => {
  let component: SettingsComponent;
  let posts_service_mock: any;
  let dialog_mock: any;
  let done_emitter: EventEmitter<boolean>;

  beforeEach(() => {
    done_emitter = new EventEmitter<boolean>();

    posts_service_mock = {
      initialized: false,
      service_initialized: of(false),
      config: null,
      openSnackBar: vi.fn().mockName('openSnackBar'),
      deleteOrphanFiles: vi.fn().mockName('deleteOrphanFiles').mockReturnValue(of({ deleted_count: 3, failed_count: 0 }))
    };

    dialog_mock = {
      open: vi.fn().mockName('open').mockReturnValue({
        close: vi.fn().mockName('close')
      })
    };

    const snack_bar_mock: any = { open: () => { } };
    const sanitizer_mock: any = {};
    const router_mock: any = { navigate: () => { } };
    const route_mock: any = { snapshot: { paramMap: { get: () => null } } };

    component = new SettingsComponent(posts_service_mock, snack_bar_mock, sanitizer_mock, dialog_mock, router_mock, route_mock);
  });

  it('opens a confirm dialog', () => {
    component.deleteOrphanFiles();
    expect(dialog_mock.open).toHaveBeenCalled();
  });

  it('calls deleteOrphanFiles on the service when confirmed', () => {
    component.deleteOrphanFiles();
    const dialog_data = vi.mocked(dialog_mock.open).mock.lastCall[1].data;
    dialog_data.doneEmitter.emit(true);
    expect(posts_service_mock.deleteOrphanFiles).toHaveBeenCalled();
  });

  it('does not call the service when the dialog is cancelled', () => {
    component.deleteOrphanFiles();
    const dialog_data = vi.mocked(dialog_mock.open).mock.lastCall[1].data;
    dialog_data.doneEmitter.emit(false);
    expect(posts_service_mock.deleteOrphanFiles).not.toHaveBeenCalled();
  });

  it('shows a snackbar with the deleted count on success', () => {
    posts_service_mock.deleteOrphanFiles.mockReturnValue(of({ deleted_count: 5, failed_count: 0 }));
    component.deleteOrphanFiles();
    const dialog_data = vi.mocked(dialog_mock.open).mock.lastCall[1].data;
    dialog_data.doneEmitter.emit(true);
    expect(posts_service_mock.openSnackBar).toHaveBeenCalled();
    const message: string = vi.mocked(posts_service_mock.openSnackBar).mock.lastCall[0];
    expect(message).toContain('5');
  });

  it('includes the failed count in the snackbar when some deletions failed', () => {
    posts_service_mock.deleteOrphanFiles.mockReturnValue(of({ deleted_count: 2, failed_count: 1 }));
    component.deleteOrphanFiles();
    const dialog_data = vi.mocked(dialog_mock.open).mock.lastCall[1].data;
    dialog_data.doneEmitter.emit(true);
    const message: string = vi.mocked(posts_service_mock.openSnackBar).mock.lastCall[0];
    expect(message).toContain('1');
  });

  it('shows an error snackbar when the API call fails', () => {
    posts_service_mock.deleteOrphanFiles.mockReturnValue(throwError(() => new Error('server error')));
    component.deleteOrphanFiles();
    const dialog_data = vi.mocked(dialog_mock.open).mock.lastCall[1].data;
    dialog_data.doneEmitter.emit(true);
    expect(posts_service_mock.openSnackBar).toHaveBeenCalled();
    const message: string = vi.mocked(posts_service_mock.openSnackBar).mock.lastCall[0];
    expect(message.toLowerCase()).toContain('failed');
  });
});

describe('SettingsComponent downloader + yt-dlp channel selection', () => {
  let component: SettingsComponent;

  const buildComponent = (): SettingsComponent => {
    const posts_service_mock: any = {
      initialized: false,
      service_initialized: of(false),
      config: null,
      openSnackBar: vi.fn().mockName('openSnackBar')
    };
    const snack_bar_mock: any = { open: () => { } };
    const sanitizer_mock: any = {};
    const dialog_mock: any = { open: () => ({ close: () => { } }) };
    const router_mock: any = { navigate: () => { } };
    const route_mock: any = { snapshot: { paramMap: { get: () => null } } };

    return new SettingsComponent(posts_service_mock, snack_bar_mock, sanitizer_mock, dialog_mock, router_mock, route_mock);
  };

  beforeEach(() => {
    component = buildComponent();
    component.new_config = { Advanced: { default_downloader: 'yt-dlp', ytdlp_update_channel: 'stable' } };
    component.initial_config = { Advanced: { default_downloader: 'yt-dlp', ytdlp_update_channel: 'stable' } };
    component.downloaderInfo = {
      'yt-dlp': { downloader: 'yt-dlp', version: '2026.07.04', binary_exists: true, loaded: true }
    };
  });

  it('represents stable yt-dlp as a bare value', () => {
    expect(component.selectedDownloader).toBe('yt-dlp');
  });

  it('encodes the non-stable channels into the selected value', () => {
    for (const channel of ['nightly', 'master']) {
      component.new_config['Advanced']['ytdlp_update_channel'] = channel;
      expect(component.selectedDownloader).toBe(`yt-dlp@${channel}`);
    }
  });

  it('treats a missing or blank channel as stable', () => {
    for (const channel of [undefined, null, '', '   ']) {
      component.new_config['Advanced']['ytdlp_update_channel'] = channel;
      expect(component.selectedDownloader).toBe('yt-dlp');
    }
  });

  it('normalizes case and whitespace so an env value like NIGHTLY displays correctly', () => {
    for (const channel of ['NIGHTLY', '  nightly  ', 'Nightly']) {
      component.new_config['Advanced']['ytdlp_update_channel'] = channel;
      expect(component.selectedDownloader).toBe('yt-dlp@nightly');
    }
  });

  it('matches no option for an unrecognized channel rather than claiming stable', () => {
    // The backend skips updating entirely in this state, so showing 'stable' would be a
    // lie. An unmatched value leaves the select empty until the user picks a real channel.
    component.new_config['Advanced']['ytdlp_update_channel'] = 'nightlyy';
    expect(component.selectedDownloader).toBe('yt-dlp@nightlyy');
    expect(component.selectedDownloader).not.toBe('yt-dlp');
  });

  it('annotates no channel with a version when the installed channel is unrecognized', () => {
    component.initial_config['Advanced']['ytdlp_update_channel'] = 'nightlyy';
    for (const channel of ['stable', 'nightly', 'master']) {
      expect(component.getDownloaderLabel('yt-dlp', channel)).toBe(`yt-dlp ${channel}`);
    }
  });

  it('writes both the fork and the channel when a channel option is picked', () => {
    component.selectedDownloader = 'yt-dlp@nightly';
    expect(component.new_config['Advanced']['default_downloader']).toBe('yt-dlp');
    expect(component.new_config['Advanced']['ytdlp_update_channel']).toBe('nightly');
  });

  it('resets to stable when the bare yt-dlp option is picked', () => {
    component.new_config['Advanced']['ytdlp_update_channel'] = 'nightly';
    component.selectedDownloader = 'yt-dlp';
    expect(component.new_config['Advanced']['ytdlp_update_channel']).toBe('stable');
  });

  it('leaves the stored channel alone for the other forks', () => {
    component.new_config['Advanced']['ytdlp_update_channel'] = 'nightly';
    component.selectedDownloader = 'youtube-dl';
    expect(component.new_config['Advanced']['default_downloader']).toBe('youtube-dl');
    expect(component.new_config['Advanced']['ytdlp_update_channel']).toBe('nightly');
    expect(component.selectedDownloader).toBe('youtube-dl');
  });

  it('annotates only the installed channel with the version', () => {
    expect(component.getDownloaderLabel('yt-dlp', 'stable')).toBe('yt-dlp stable (2026.07.04)');
    expect(component.getDownloaderLabel('yt-dlp', 'nightly')).toBe('yt-dlp nightly');
    expect(component.getDownloaderLabel('yt-dlp', 'master')).toBe('yt-dlp master');
  });

  it('follows the saved config, not an unsaved selection, when annotating', () => {
    component.initial_config['Advanced']['ytdlp_update_channel'] = 'nightly';
    component.new_config['Advanced']['ytdlp_update_channel'] = 'stable';
    expect(component.getDownloaderLabel('yt-dlp', 'nightly')).toBe('yt-dlp nightly (2026.07.04)');
    expect(component.getDownloaderLabel('yt-dlp', 'stable')).toBe('yt-dlp stable');
  });

  it('keeps the unchannelled label format for youtube-dl', () => {
    component.downloaderInfo['youtube-dl'] = {
      downloader: 'youtube-dl', version: '2021.12.17', binary_exists: true, loaded: true
    };
    expect(component.getDownloaderLabel('youtube-dl')).toBe('youtube-dl (2021.12.17)');
    component.downloaderInfo['youtube-dl'] = {
      downloader: 'youtube-dl', version: null, binary_exists: false, loaded: false
    };
    expect(component.getDownloaderLabel('youtube-dl')).toBe('youtube-dl');
  });
});

describe('SettingsComponent tabs', () => {
  let component: SettingsComponent;
  let router_mock: any;
  let posts_service_mock: any;
  let tab_params: any;

  beforeEach(() => {
    tab_params = { get: (_key: string) => null };
    router_mock = { navigate: vi.fn().mockName('navigate') };
    posts_service_mock = {
      initialized: false,
      service_initialized: of(false),
      config: { Advanced: { multi_user_mode: false } },
      getVersionInfo: vi.fn().mockName('getVersionInfo').mockReturnValue(of({})),
      getDBInfo: vi.fn().mockName('getDBInfo').mockReturnValue(of({})),
      getLatestGithubRelease: vi.fn().mockName('getLatestGithubRelease').mockReturnValue(of({}))
    };

    const route_mock: any = { paramMap: of(tab_params) };
    component = new SettingsComponent(posts_service_mock, { open: () => {} } as any,
      { bypassSecurityTrustUrl: (url: string) => url } as any, {} as any, router_mock, route_mock);
  });

  it('opens on the tab the route names', () => {
    tab_params.get = (key: string) => key === 'tab' ? 'database' : null;

    component.ngOnInit();

    expect(component.tab).toBe('database');
  });

  it('falls back to the first tab when the route names one that does not exist', () => {
    tab_params.get = () => 'not-a-tab';

    component.ngOnInit();

    expect(component.tab).toBe('main');
  });

  it('puts the tab it is switched to in the URL', () => {
    component.selectTab('advanced');

    expect(component.tab).toBe('advanced');
    expect(router_mock.navigate).toHaveBeenCalledWith(['/settings', { tab: 'advanced' }]);
  });

  it('does not navigate to the tab that is already open', () => {
    component.selectTab('main');

    expect(router_mock.navigate).not.toHaveBeenCalled();
  });

  it('keeps users out until multi-user mode is on', () => {
    expect(component.tabDisabled('users')).toBe(true);

    component.selectTab('users');

    expect(component.tab).toBe('main');
    expect(router_mock.navigate).not.toHaveBeenCalled();

    posts_service_mock.config.Advanced.multi_user_mode = true;

    expect(component.tabDisabled('users')).toBe(false);
  });
});

describe('SettingsComponent notification types', () => {
  let component: SettingsComponent;

  beforeEach(() => {
    const posts_service_mock: any = { initialized: false, service_initialized: of(false), config: null };
    component = new SettingsComponent(posts_service_mock, {} as any, {} as any, {} as any,
      { navigate: () => {} } as any, { paramMap: of({ get: () => null }) } as any);
    component.new_config = { Extra: { enable_notifications: true, enable_all_notifications: false, allowed_notification_types: [] } };
  });

  it('turns a kind on and off again', () => {
    expect(component.notificationTypeEnabled('download_error')).toBe(false);

    component.toggleNotificationType('download_error');

    expect(component.new_config['Extra']['allowed_notification_types']).toEqual(['download_error']);
    expect(component.notificationTypeEnabled('download_error')).toBe(true);

    component.toggleNotificationType('download_error');

    expect(component.new_config['Extra']['allowed_notification_types']).toEqual([]);
  });

  it('leaves the kinds that were already picked alone', () => {
    component.new_config['Extra']['allowed_notification_types'] = ['task_finished'];

    component.toggleNotificationType('download_complete');

    expect(component.new_config['Extra']['allowed_notification_types']).toEqual(['task_finished', 'download_complete']);
  });

  it('has nothing to pick when notifications are off, or when every kind is sent', () => {
    expect(component.notificationTypesLocked).toBe(false);

    component.new_config['Extra']['enable_all_notifications'] = true;
    expect(component.notificationTypesLocked).toBe(true);

    component.new_config['Extra']['enable_all_notifications'] = false;
    component.new_config['Extra']['enable_notifications'] = false;
    expect(component.notificationTypesLocked).toBe(true);
  });

  it('copes with a config that has no list yet', () => {
    component.new_config['Extra']['allowed_notification_types'] = undefined;

    expect(component.notificationTypeEnabled('download_error')).toBe(false);

    component.toggleNotificationType('download_error');

    expect(component.new_config['Extra']['allowed_notification_types']).toEqual(['download_error']);
  });
});

describe('SettingsComponent OIDC panel', () => {
  const buildComponent = (oidc: any, status: any = { enabled: true, initialized: true, auto_register: true }): SettingsComponent => {
    const posts_service_mock: any = {
      initialized: false,
      service_initialized: of(false),
      config: oidc === null ? {} : { Users: { oidc: oidc } },
      getOIDCStatus: vi.fn().mockName('getOIDCStatus').mockReturnValue(of(status)),
      openSnackBar: vi.fn().mockName('openSnackBar')
    };
    const snack_bar_mock: any = { open: () => { } };
    const sanitizer_mock: any = {};
    const dialog_mock: any = { open: () => ({ afterClosed: () => of(null) }) };
    const router_mock: any = { navigate: () => { } };
    const route_mock: any = { snapshot: { paramMap: { get: () => null } } };
    return new SettingsComponent(posts_service_mock, snack_bar_mock, sanitizer_mock, dialog_mock, router_mock, route_mock);
  };

  const configured = {
    enabled: true,
    issuer_url: 'https://id.example.com/realms/media',
    client_id: 'ytdl-material',
    client_secret: 'super-secret',
    redirect_uri: 'https://media.example.com/api/auth/oidc/callback',
    scope: '',
    auto_register: false,
    admin_claim: '',
    admin_value: '',
    group_claim: 'roles',
    allowed_groups: '',
    username_claim: '',
    display_name_claim: 'name'
  };

  it('has nothing to show when OIDC is off, or absent entirely', () => {
    expect(buildComponent(null).oidcSettings).toBeNull();
    expect(buildComponent({ enabled: false, issuer_url: 'https://id.example.com' }).oidcSettings).toBeNull();
    expect(buildComponent(null).oidcSecrets).toEqual([]);
    expect(buildComponent(null).oidcDetails).toEqual([]);
  });

  it('says a secret is there without saying what it is', () => {
    const component = buildComponent(configured);
    const secrets = component.oidcSecrets;

    expect(secrets.map(secret => secret.configured)).toEqual([true, true, true]);
    const printed = JSON.stringify(secrets) + JSON.stringify(component.oidcDetails);
    expect(printed).not.toContain('super-secret');
    expect(printed).not.toContain('id.example.com/realms');
    expect(printed).not.toContain('ytdl-material');
  });

  it('reports a blank secret as not configured', () => {
    const secrets = buildComponent({ ...configured, client_secret: '   ' }).oidcSecrets;
    expect(secrets.find(secret => secret.configured === false)).toBeTruthy();
  });

  it('shows the value the backend falls back to, not the blank that is stored', () => {
    const details = buildComponent(configured).oidcDetails;
    const value = (label: string) => details.find(detail => detail.label === label).value;

    expect(value('Scope')).toBe('openid profile email');
    expect(value('Username claim')).toBe('preferred_username');
    expect(value('Display name claim')).toBe('name');
    expect(value('Admin claim')).toBe('groups = admin');
    expect(value('Group claim')).toBe('roles');
    expect(value('Allowed groups')).toBe('Any group');
    expect(value('Register users on first sign-in')).toBe('No');
  });

  it('asks the backend how it went only when OIDC is on', () => {
    const off = buildComponent(null);
    off.getOIDCStatus();
    expect((off as any).postsService.getOIDCStatus).not.toHaveBeenCalled();
    expect(off.oidcStatus).toBeNull();

    const on = buildComponent(configured);
    on.getOIDCStatus();
    expect(on.oidcStatus.initialized).toBe(true);
  });

  it('leaves the status unknown when the call fails', () => {
    const component = buildComponent(configured, null);
    (component as any).postsService.getOIDCStatus.mockReturnValue(throwError(() => new Error('nope')));
    component.getOIDCStatus();
    expect(component.oidcStatus).toBeNull();
  });
});

describe('SettingsComponent environment rows', () => {
  const buildComponent = (config: any, server_runtime: any): SettingsComponent => {
    const posts_service_mock: any = { initialized: false, service_initialized: of(false), config: config, serverRuntime: server_runtime };
    return new SettingsComponent(posts_service_mock, {} as any, {} as any, {} as any,
      { navigate: () => {} } as any, { paramMap: of({ get: () => null }) } as any);
  };

  it('shows only the server settings that are set', () => {
    expect(buildComponent({ Host: { url: 'http://localhost', port: '17442' } }, null).serverEnvironment).toEqual([]);
    expect(buildComponent({ Host: { reverse_proxy_whitelist: '  ', ssl_cert_path: '' } }, { trust_proxy: null }).serverEnvironment).toEqual([]);

    const component = buildComponent(
      { Host: { reverse_proxy_whitelist: '172.28.0.10/32', ssl_cert_path: '/certs/cert.pem', ssl_key_path: '/certs/key.pem' } },
      { trust_proxy: '1', uid: 1000, gid: 1000, umask: 0o22 });

    expect(component.serverEnvironment.map(row => [row.variable, row.value])).toEqual([
      ['ytdl_trust_proxy', '1'],
      ['ytdl_reverse_proxy_whitelist', '172.28.0.10/32'],
      ['ytdl_ssl_cert_path', '/certs/cert.pem'],
      ['ytdl_ssl_key_path', '/certs/key.pem']
    ]);
  });

  it('shows what the server runs as, root and all', () => {
    const values = (runtime: any) => buildComponent({}, runtime).runtimePermissions.map(row => [row.variable, row.value]);

    expect(values({ uid: 1000, gid: 100, umask: 0o22 })).toEqual([['ytdl_uid', '1000'], ['ytdl_gid', '100'], ['ytdl_umask', '0022']]);
    expect(values({ uid: 0, gid: 0, umask: 0o2 })).toEqual([['ytdl_uid', '0 (root)'], ['ytdl_gid', '0 (root)'], ['ytdl_umask', '0002']]);
    expect(values(null)).toEqual([['ytdl_uid', 'Unknown'], ['ytdl_gid', 'Unknown'], ['ytdl_umask', 'Unknown']]);
  });
});
