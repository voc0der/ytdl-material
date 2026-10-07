import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MatDialog } from '@angular/material/dialog';
import { By } from '@angular/platform-browser';
import { Router } from '@angular/router';
import { BehaviorSubject, of, Subject } from 'rxjs';

import { configureTestBed } from '../../testing/test-bed';
import { PickerComponent } from '../components/picker/picker.component';
import { PostsService } from '../posts.services';
import { SettingsComponent } from './settings.component';

describe('Settings page controls', () => {
  let fixture: ComponentFixture<SettingsComponent>;
  let component: SettingsComponent;
  let posts: any;
  let root: HTMLElement;

  const render = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };
  const button = (text: string, scope: ParentNode = root): HTMLButtonElement => {
    const found = Array.from(scope.querySelectorAll('button')).find(candidate => candidate.textContent.includes(text));
    expect(found, `Button containing "${text}"`).toBeDefined();
    return found;
  };
  const switchTab = async (tab: string) => {
    root.querySelector<HTMLButtonElement>(`#settings-tab-${tab}`).click();
    await render();
  };
  const editInput = async (input: HTMLInputElement, value: string) => {
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await render();
  };
  const registrationSwitch = (): HTMLButtonElement => root.querySelector('#settings-allow-registration')
    .closest('.settings-row').querySelector('button[role="switch"]');

  beforeEach(async () => {
    await configureTestBed({ imports: [SettingsComponent] }).compileComponents();
    posts = TestBed.inject(PostsService);
    Object.assign(posts, {
      initialized: true,
      service_initialized: new BehaviorSubject(false),
      reload_config: new Subject<boolean>(),
      transcodingStatus: null,
      serverRuntime: null,
      config: {
        Host: { url: 'https://media.example.test', port: 17442 },
        Users: { base_path: 'users', auth_method: 'internal', ldap_config: {} },
        Advanced: { multi_user_mode: false, default_downloader: 'yt-dlp', ytdlp_update_channel: 'stable' },
        Subscriptions: { allow_subscriptions: false },
        Themes: { default_theme: 'default' },
        Downloader: { custom_args: '', replace_invalid_filename_chars: false },
        Extra: { enable_notifications: true, enable_all_notifications: false, allowed_notification_types: [] },
        API: {},
        Database: { postgresdb_connection_string: 'postgres://localhost/media' }
      },
      getDBInfo: vi.fn().mockReturnValue(of({ using_local_db: true, configured_remote_db_label: 'PostgreSQL', stats_by_table: {} })),
      getVersionInfo: vi.fn().mockReturnValue(of({})),
      getLatestGithubRelease: vi.fn().mockReturnValue(of({})),
      getOIDCStatus: vi.fn().mockReturnValue(of({ initialized: true })),
      isOIDCEnabled: PostsService.prototype.isOIDCEnabled,
      isHeaderAuthEnabled: PostsService.prototype.isHeaderAuthEnabled,
      getUsers: vi.fn().mockReturnValue(of({ users: [] })),
      getRoles: vi.fn().mockReturnValue(of({ roles: [] })),
      setConfig: vi.fn().mockReturnValue(of({ success: true })),
      testCookies: vi.fn(),
      testConnectionString: vi.fn(),
      openSnackBar: vi.fn()
    });
    fixture = TestBed.createComponent(SettingsComponent);
    component = fixture.componentInstance;
    root = fixture.nativeElement;
  });

  it('shows loading until configuration arrives', async () => {
    posts.initialized = false;
    await render();
    expect(root.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(root.querySelector('.settings-savebar')).toBeNull();
    posts.service_initialized.next(true);
    await render();
    expect(root.querySelector('.list-loading')).toBeNull();
    expect(root.querySelector('input').value).toBe('https://media.example.test');
  });

  it('shows the save bar for a real input edit and restores the field on Cancel', async () => {
    await render();
    expect(root.querySelector('.settings-savebar')).toBeNull();
    const input = root.querySelector('input');
    await editInput(input, 'https://changed.example.test');
    expect(root.querySelector('.settings-savebar').textContent).toContain('You have unsaved changes.');
    expect(posts.config.Host.url).toBe('https://media.example.test');
    button('Cancel', root.querySelector('.settings-savebar')).click();
    await render();
    expect(input.value).toBe('https://media.example.test');
    expect(root.querySelector('.settings-savebar')).toBeNull();
    expect(posts.setConfig).not.toHaveBeenCalled();
  });

  it.each([true, false])('keeps the save bar until an edit is accepted (success: %s)', async success => {
    const response = new Subject<{ success: boolean }>();
    posts.setConfig.mockReturnValue(response);
    await render();
    await editInput(root.querySelector('input'), 'https://changed.example.test');
    button('Save', root.querySelector('.settings-savebar')).click();
    await render();
    expect(posts.setConfig).toHaveBeenCalledWith({ YtdlMaterial: expect.objectContaining({
      Host: { url: 'https://changed.example.test', port: 17442 }
    }) });
    expect(root.querySelector('.settings-savebar')).not.toBeNull();
    response.next({ success });
    await render();
    expect(root.querySelector('.settings-savebar') === null).toBe(success);
    expect(root.querySelector('input').value).toBe('https://changed.example.test');
  });

  it('connects tab clicks to the URL and accessible panel labels', async () => {
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate');
    await render();
    await switchTab('downloader');
    expect(navigate).toHaveBeenCalledWith(['/settings', { tab: 'downloader' }]);
    expect(root.querySelector('#settings-tab-downloader').getAttribute('aria-selected')).toBe('true');
    expect(root.querySelector('#settings-tab-main').getAttribute('aria-selected')).toBe('false');
    expect(root.querySelector('[role="tabpanel"]').getAttribute('aria-labelledby')).toBe('settings-tab-downloader');
    expect(root.querySelector('[role="tabpanel"]').id).toBe('settings-panel-downloader');
  });

  it('keeps the Users tab unavailable until multi-user mode has been saved', async () => {
    await render();
    const tab = root.querySelector<HTMLButtonElement>('#settings-tab-users');
    expect(tab.getAttribute('aria-disabled')).toBe('true');
    component.new_config.Advanced.multi_user_mode = true;
    await switchTab('users');
    expect(component.tab).toBe('main');
    posts.config.Advanced.multi_user_mode = true;
    await render();
    expect(tab.hasAttribute('aria-disabled')).toBe(false);
    await switchTab('users');
    expect(root.querySelector('#settings-panel-users')).not.toBeNull();
  });

  it('updates notification chips and exposes their pressed state', async () => {
    await render();
    await switchTab('notifications');
    const chip = button('Download error');
    expect(chip.getAttribute('aria-pressed')).toBe('false');
    chip.click();
    await render();
    expect(component.new_config.Extra.allowed_notification_types).toEqual(['download_error']);
    expect(chip.getAttribute('aria-pressed')).toBe('true');
    chip.click();
    await render();
    expect(chip.getAttribute('aria-pressed')).toBe('false');
    expect(component.new_config.Extra.allowed_notification_types).toEqual([]);
  });

  it.each([
    [false, false], [true, true]
  ])('disables notification chips when enabled=%s and all=%s', async (enabled, all) => {
    posts.config.Extra.enable_notifications = enabled;
    posts.config.Extra.enable_all_notifications = all;
    await render();
    await switchTab('notifications');
    const chips = Array.from(root.querySelectorAll<HTMLButtonElement>('button[aria-pressed]'));
    expect(chips).toHaveLength(3);
    expect(chips.every(chip => chip.disabled)).toBe(true);
    chips[0].click();
    expect(component.new_config.Extra.allowed_notification_types).toEqual([]);
  });

  it('writes the fork and update channel chosen by the downloader picker', async () => {
    await render();
    await switchTab('advanced');
    const picker = fixture.debugElement.queryAll(By.directive(PickerComponent))
      .map(element => element.componentInstance as PickerComponent)
      .find(candidate => candidate.title === 'Downloader');
    picker.choose('yt-dlp@nightly');
    await render();
    expect(component.new_config.Advanced.default_downloader).toBe('yt-dlp');
    expect(component.new_config.Advanced.ytdlp_update_channel).toBe('nightly');
    expect(picker.selectedLabel).toBe('yt-dlp nightly');
    expect(root.querySelector('.settings-savebar')).not.toBeNull();
  });

  describe('Log level', () => {
    const logLevelPicker = () => fixture.debugElement.queryAll(By.directive(PickerComponent))
      .find(element => (element.componentInstance as PickerComponent).title === 'Log level');
    const trigger = (): HTMLButtonElement => logLevelPicker().nativeElement.querySelector('button');
    const hint = (): HTMLElement => logLevelPicker().nativeElement.closest('.settings-row').querySelector('.settings-row-hint');

    // silly is a level the environment can set but the picker does not offer.
    it.each([['debug', 'Debug'], ['silly', 'silly']])('shows the %s level the environment sets, read only, and keeps the saved one', async (level, shown) => {
      posts.config.Advanced.logger_level = 'info';
      posts.serverRuntime = { trust_proxy: null, log_level: { level, variable: 'ytdl_log_level' }, uid: 1000, gid: 1000, umask: 0o22 };
      await render();
      await switchTab('advanced');
      expect(trigger().textContent).toContain(shown);
      expect(trigger().disabled).toBe(true);
      expect(hint().textContent.trim()).toBe('Set with ytdl_log_level.');
      expect(component.new_config.Advanced.logger_level).toBe('info');
    });

    it('shows the saved level, and lets it change, when the environment sets none', async () => {
      posts.config.Advanced.logger_level = 'warn';
      await render();
      await switchTab('advanced');
      expect(trigger().textContent).toContain('Warn');
      expect(trigger().disabled).toBe(false);
      expect(hint()).toBeNull();
      (logLevelPicker().componentInstance as PickerComponent).choose('debug');
      await render();
      expect(component.new_config.Advanced.logger_level).toBe('debug');
      expect(trigger().textContent).toContain('Debug');
    });
  });

  it.each([true, false])('shows cookie test progress, logs, and result (success: %s)', async success => {
    const response = new Subject<any>();
    posts.testCookies.mockReturnValue(response);
    await render();
    await switchTab('advanced');
    const run = button('Run Cookie Test');
    const input = root.querySelector<HTMLInputElement>('input[aria-label="Test URL"]');
    expect(run.disabled).toBe(true);
    await editInput(input, '   ');
    expect(run.disabled).toBe(true);
    await editInput(input, ' https://media.example.test/watch ');
    expect(run.disabled).toBe(false);
    run.click();
    await render();
    expect(run.disabled).toBe(true);
    expect(run.querySelector('mat-spinner')).not.toBeNull();
    expect(root.querySelector('.log-box').textContent).toBe('Running cookies test...');
    response.next({ success, logs: ['Reading cookies', 'Finished'] });
    await render();
    expect(run.disabled).toBe(false);
    expect(run.querySelector('mat-spinner')).toBeNull();
    expect(root.querySelector('.log-box').textContent).toBe('Reading cookies\nFinished');
    const status = root.querySelector('.settings-note[role="status"]');
    expect(status.textContent).toContain(success ? 'Cookies test passed.' : 'Cookies test failed.');
    expect(status.classList.contains(success ? 'is-good' : 'is-warning')).toBe(true);
  });

  it('links the Set Cookies row to the docs on getting a cookies.txt', async () => {
    await render();
    await switchTab('advanced');
    const link = Array.from(root.querySelectorAll<HTMLAnchorElement>('a'))
      .find(candidate => candidate.textContent.trim() === 'How can I get my cookies.txt?');
    expect(link, 'cookies help link').toBeDefined();
    expect(link.href).toBe('https://voc0der.github.io/ytdl-material/usage/downloads/#cookies-and-browser-impersonation');
    expect(link.target).toBe('_blank');
    expect(link.rel).toBe('noopener');
    expect(link.closest('.settings-row').contains(button('Set Cookies'))).toBe(true);
  });

  it('shows a database empty state when no information is returned', async () => {
    posts.getDBInfo.mockReturnValue(of(null));
    await render();
    await switchTab('database');
    expect(root.querySelector('.empty-state').textContent).toContain('No database information');
    expect(root.querySelector('input[aria-label="PostgreSQL Connection String"]')).toBeNull();
  });

  it.each([true, false])('labels the database transfer destination (local: %s)', async usingLocal => {
    posts.getDBInfo.mockReturnValue(of({
      using_local_db: usingLocal, current_db_label: usingLocal ? 'Local' : 'PostgreSQL',
      configured_remote_db_label: 'PostgreSQL', stats_by_table: { files: { records_count: 42 } }
    }));
    await render();
    await switchTab('database');
    expect(button('Transfer DB').textContent).toContain(`Transfer DB to ${usingLocal ? 'PostgreSQL' : 'Local'}`);
    expect(root.querySelector('.db-stats').textContent).toContain('files42');
    component.db_transferring = true;
    await render();
    expect(button('Transfer DB').disabled).toBe(true);
  });

  it('disables connection checks while a request is pending and enables them after an error', async () => {
    const response = new Subject<unknown>();
    posts.testConnectionString.mockReturnValue(response);
    await render();
    await switchTab('database');
    const input = root.querySelector<HTMLInputElement>('input[aria-label="PostgreSQL Connection String"]');
    const test = button('Test', input.parentElement);
    test.click();
    await render();
    expect(posts.testConnectionString).toHaveBeenCalledWith('postgres://localhost/media');
    const tests = Array.from(root.querySelectorAll<HTMLButtonElement>('.kit-field button'));
    expect(tests).toHaveLength(3);
    expect(tests.every(candidate => candidate.disabled)).toBe(true);
    response.error(new Error('offline'));
    await render();
    expect(tests.every(candidate => !candidate.disabled)).toBe(true);
  });

  it.each([null, true, false])('shows provider status without rendering secrets (initialized: %s)', async initialized => {
    posts.config.Advanced.multi_user_mode = true;
    posts.config.Users.allow_registration = true;
    posts.config.Users.auth_method = 'ldap';
    posts.config.Users.oidc = {
      enabled: true, issuer_url: 'https://private-id.example.test', client_id: 'private-client', client_secret: 'private-secret'
    };
    posts.getOIDCStatus.mockReturnValue(of(initialized === null ? null : { initialized }));
    await render();
    // Unsaved settings must never override the status of the running server.
    component.new_config.Users.oidc.enabled = false;
    await switchTab('users');
    const panel = Array.from(root.querySelectorAll('section')).find(section => section.querySelector('h2')?.textContent === 'Single sign-on');
    expect(panel).toBeDefined();
    expect(panel.textContent).toContain(initialized === null ? 'Unknown' : initialized ? 'Connected' : 'Not connected');
    expect(panel.querySelectorAll('.settings-secret')).toHaveLength(3);
    expect(panel.querySelector('input')).toBeNull();
    for (const secret of ['private-id.example.test', 'private-client', 'private-secret']) {
      expect(root.innerHTML).not.toContain(secret);
    }
    expect(panel.textContent.includes('Sign-in through the provider will fail')).toBe(initialized === false);

    // OIDC blocks local authentication even when discovery fails or its status is unknown.
    const dialog = vi.spyOn(TestBed.inject(MatDialog), 'open');
    const registration = registrationSwitch();
    expect(registration.disabled).toBe(true);
    expect(registration.getAttribute('aria-checked')).toBe('false');
    expect(root.querySelector(`#${registration.getAttribute('aria-describedby')}`).textContent)
      .toContain('New SSO accounts are controlled by “Register users on first sign-in”');
    registration.click();
    expect(component.new_config.Users.allow_registration).toBe(true);
    expect(button('OIDC / SSO').disabled).toBe(true);
    expect(component.new_config.Users.auth_method).toBe('ldap');
    const ldapInputs = Array.from(root.querySelectorAll<HTMLInputElement>('.settings-field-row input'));
    expect(ldapInputs).toHaveLength(5);
    expect(ldapInputs.every(input => input.disabled)).toBe(true);
    const addUsers = button('Add Users');
    expect(addUsers.disabled).toBe(true);
    expect(root.querySelector(`#${addUsers.getAttribute('aria-describedby')}`).textContent)
      .toContain('Local user creation is disabled while OIDC is enabled');
    addUsers.click();
    expect(dialog).not.toHaveBeenCalled();
  });

  it.each([true, false])('preserves local preferences through saving under OIDC and restores them when OIDC is off (registration: %s)', async allowRegistration => {
    posts.config.Advanced.multi_user_mode = true;
    Object.assign(posts.config.Users, {
      allow_registration: allowRegistration,
      auth_method: 'ldap',
      ldap_config: {
        url: 'ldaps://directory.example.test', bindDN: 'cn=reader', bindCredentials: 'saved-credential',
        searchBase: 'ou=people', searchFilter: '(uid={{username}})'
      },
      oidc: { enabled: true, auto_register: false }
    });
    const savedUsers = JSON.parse(JSON.stringify(posts.config.Users));
    await render();
    await switchTab('users');
    expect(registrationSwitch().getAttribute('aria-checked')).toBe('false');
    expect(root.querySelector('.settings-savebar')).toBeNull();
    const autoRegister = Array.from(root.querySelectorAll('.settings-row'))
      .find(row => row.querySelector('.settings-row-title')?.textContent === 'Register users on first sign-in');
    expect(autoRegister.querySelector('.settings-row-value').textContent).toBe('No');
    expect(autoRegister.querySelector('.settings-row-hint').textContent)
      .toContain('Existing matching accounts can still sign in when this is off');
    expect(autoRegister.querySelector('input, button')).toBeNull();

    await switchTab('main');
    await editInput(root.querySelector('input'), 'https://changed.example.test');
    button('Save', root.querySelector('.settings-savebar')).click();
    await render();
    expect(posts.setConfig).toHaveBeenCalledWith({ YtdlMaterial: expect.objectContaining({ Users: savedUsers }) });

    // Model a refreshed server configuration after OIDC is disabled externally.
    posts.config.Users.oidc.enabled = false;
    component.getConfig();
    await switchTab('users');
    const registration = registrationSwitch();
    expect(registration.disabled).toBe(false);
    expect(registration.getAttribute('aria-checked')).toBe(String(allowRegistration));
    expect(button('LDAP').disabled).toBe(false);
    const ldapInputs = Array.from(root.querySelectorAll<HTMLInputElement>('.settings-field-row input'));
    expect(ldapInputs.every(input => !input.disabled)).toBe(true);
    expect(ldapInputs.map(input => input.value)).toEqual(Object.values(savedUsers.ldap_config));
    registration.click();
    await render();
    expect(component.new_config.Users.allow_registration).toBe(!allowRegistration);

    const dialog = vi.spyOn(TestBed.inject(MatDialog), 'open').mockReturnValue({ afterClosed: () => of(null) } as any);
    expect(button('Add Users').disabled).toBe(false);
    button('Add Users').click();
    expect(dialog).toHaveBeenCalledOnce();
  });

  it('renders the hardware fallback warning from the server status', async () => {
    posts.transcodingStatus = { mode: 'nvenc', checked: true, available: false, label: 'Nvidia NVENC', error: 'Device unavailable' };
    await render();
    await switchTab('downloader');
    const warning = root.querySelector('.settings-note.is-warning');
    expect(warning.textContent).toContain('Video processing will fall back to software encoding.');
    expect(warning.textContent).toContain('Device unavailable');
    posts.transcodingStatus.available = true;
    await render();
    expect(root.querySelector('.settings-note.is-warning')).toBeNull();
  });
});
