import { CdkDragDrop } from '@angular/cdk/drag-drop';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { DomSanitizer } from '@angular/platform-browser';
import { ActivatedRoute, convertToParamMap, ParamMap, Router } from '@angular/router';
import { BehaviorSubject, of, Subject, throwError } from 'rxjs';

import { PostsService } from '../posts.services';
import { ArgModifierDialogComponent } from '../dialogs/arg-modifier-dialog/arg-modifier-dialog.component';
import { ConfirmDialogComponent } from '../dialogs/confirm-dialog/confirm-dialog.component';
import { CookiesUploaderDialogComponent } from '../dialogs/cookies-uploader-dialog/cookies-uploader-dialog.component';
import { EditCategoryDialogComponent } from '../dialogs/edit-category-dialog/edit-category-dialog.component';
import { GenerateRssUrlComponent } from '../dialogs/generate-rss-url/generate-rss-url.component';
import { WebhookTemplateDialogComponent } from '../dialogs/webhook-template-dialog/webhook-template-dialog.component';
import { InputDialogComponent } from '../input-dialog/input-dialog.component';
import { SettingsComponent } from './settings.component';

function createHarness() {
  const posts = {
    initialized: false,
    service_initialized: new BehaviorSubject(false),
    config: {
      Host: { url: 'https://media.example.test', port: 17442 },
      Advanced: { multi_user_mode: false, default_downloader: 'yt-dlp', ytdlp_update_channel: 'stable' },
      Downloader: { custom_args: '--embed-metadata' },
      Extra: { allowed_notification_types: ['download_error'] },
      API: {
        use_custom_webhook_template: false,
        custom_webhook_title_template: '{{event_name}}',
        custom_webhook_body_template: '{{event_body}}'
      },
      Users: { oidc: { enabled: true } }
    },
    categories: [{ uid: 'first', name: 'First' }, { uid: 'second', name: 'Second' }, { uid: 'third', name: 'Third' }],
    categories_changed: new Subject<boolean>(),
    reload_config: new Subject<boolean>(),
    transcodingStatus: null as PostsService['transcodingStatus'],
    getDBInfo: vi.fn().mockReturnValue(of({ using_local_db: true })),
    getVersionInfo: vi.fn().mockReturnValue(of({ downloader_info: {} })),
    getOIDCStatus: vi.fn().mockReturnValue(of({ enabled: true, initialized: true, auto_register: true })),
    getLatestGithubRelease: vi.fn().mockReturnValue(of({ tag_name: 'v1.2.5' })),
    setConfig: vi.fn().mockReturnValue(of({ success: true })),
    checkAdminCreationStatus: vi.fn(),
    updateCategories: vi.fn().mockReturnValue(of({ success: true })),
    createCategory: vi.fn(),
    createDefaultCategories: vi.fn(),
    deleteCategory: vi.fn().mockReturnValue(of({ success: true })),
    reloadCategories: vi.fn(),
    killAllDownloads: vi.fn(),
    deleteOrphanFiles: vi.fn(),
    restartServer: vi.fn(),
    transferDB: vi.fn(),
    testConnectionString: vi.fn(),
    testCookies: vi.fn(),
    openSnackBar: vi.fn()
  };
  const closed = new Subject<any>();
  const dialogRef = { close: vi.fn(), afterClosed: () => closed.asObservable() };
  const dialog = { open: vi.fn().mockReturnValue(dialogRef) };
  const sanitizer = { bypassSecurityTrustUrl: vi.fn((url: string) => ({ trustedUrl: url })) };
  const router = { navigate: vi.fn() };
  const params = new BehaviorSubject<ParamMap>(convertToParamMap({}));
  const component = new SettingsComponent(
    posts as unknown as PostsService, {} as MatSnackBar, sanitizer as unknown as DomSanitizer,
    dialog as unknown as MatDialog, router as unknown as Router,
    { paramMap: params.asObservable() } as ActivatedRoute
  );
  const dialogData = () => dialog.open.mock.lastCall[1].data;
  return { component, posts, dialog, dialogRef, closed, dialogData, sanitizer, router, params };
}

describe('Settings workflows', () => {
  let harness: ReturnType<typeof createHarness>;
  let component: SettingsComponent;
  let posts: ReturnType<typeof createHarness>['posts'];

  beforeEach(() => {
    harness = createHarness();
    ({ component, posts } = harness);
  });

  afterEach(() => vi.restoreAllMocks());

  describe('initialization', () => {
    it('loads saved settings and server status immediately when the service is ready', () => {
      posts.initialized = true;
      const downloader = { downloader: 'yt-dlp', loaded: true, binary_exists: true, version: '2026.09.01' };
      posts.getVersionInfo.mockReturnValue(of({ downloader_info: { 'yt-dlp': downloader } }));

      component.ngOnInit();

      expect(component.new_config).toEqual(posts.config);
      expect(component.new_config).not.toBe(posts.config);
      expect(component.db_info).toEqual({ using_local_db: true });
      expect(component.downloaderInfo).toEqual({ 'yt-dlp': downloader });
      expect(component.oidcStatus).toEqual({ enabled: true, initialized: true, auto_register: true });
      expect(component.latestGithubRelease).toEqual({ tag_name: 'v1.2.5' });
      expect(harness.sanitizer.bypassSecurityTrustUrl).toHaveBeenCalledWith(component.generateBookmarkletCode());
      expect(component.generated_bookmarklet_code).toBe(harness.sanitizer.bypassSecurityTrustUrl.mock.results[0].value);
      posts.service_initialized.next(true);
      expect(posts.getDBInfo).toHaveBeenCalledTimes(1);
    });

    it('ignores false initialization events and loads only once after the service becomes ready', () => {
      component.ngOnInit();
      posts.service_initialized.next(false);

      expect(component.new_config).toBeNull();
      expect(posts.getDBInfo).not.toHaveBeenCalled();
      expect(posts.getVersionInfo).not.toHaveBeenCalled();
      expect(posts.getOIDCStatus).not.toHaveBeenCalled();
      expect(posts.getLatestGithubRelease).toHaveBeenCalledTimes(1);

      posts.service_initialized.next(true);
      component.new_config.Host.port = 18000;
      posts.service_initialized.next(false);
      posts.service_initialized.next(true);

      expect(component.new_config.Host.port).toBe(18000);
      expect(posts.getDBInfo).toHaveBeenCalledTimes(1);
      expect(posts.getVersionInfo).toHaveBeenCalledTimes(1);
      expect(posts.getOIDCStatus).toHaveBeenCalledTimes(1);
    });

    it('follows subsequent route changes and defaults absent or unknown tabs to main', () => {
      harness.params.next(convertToParamMap({ tab: 'database' }));
      component.ngOnInit();
      expect(component.tab).toBe('database');

      harness.params.next(convertToParamMap({ tab: 'advanced' }));
      expect(component.tab).toBe('advanced');
      harness.params.next(convertToParamMap({ tab: 'missing' }));
      expect(component.tab).toBe('main');
      harness.params.next(convertToParamMap({ tab: 'downloader' }));
      harness.params.next(convertToParamMap({}));
      expect(component.tab).toBe('main');
      expect(harness.router.navigate).not.toHaveBeenCalled();
    });

    it('clears stale downloader information when the response omits it', () => {
      component.downloaderInfo = { 'yt-dlp': { downloader: 'yt-dlp', loaded: true, binary_exists: true, version: 'old' } };
      posts.getVersionInfo.mockReturnValue(of({}));
      component.getDownloaderInfo();
      expect(component.downloaderInfo).toEqual({});
    });
  });

  describe('editing and saving', () => {
    beforeEach(() => component.getConfig());

    it('isolates nested edits and detects changes to notification lists', () => {
      component.settingsAreTheSame = false;
      expect(component.settingsAreTheSame).toBe(true);
      component.new_config.Extra.allowed_notification_types.push('task_finished');
      expect(posts.config.Extra.allowed_notification_types).toEqual(['download_error']);
      expect(component.initial_config.Extra.allowed_notification_types).toEqual(['download_error']);
      expect(component.settingsAreTheSame).toBe(false);
      expect(component._settingsSame).toBe(false);
    });

    it('discards edits without sharing nested references with the saved configuration', () => {
      component.new_config.Host.port = 18000;
      component.cancelSettings();
      expect(component.new_config).toEqual(posts.config);
      expect(component.settingsSame()).toBe(true);
      component.new_config.Host.port = 19000;
      expect(component.initial_config.Host.port).toBe(17442);
    });

    it('only marks settings saved and requests a reload after the server accepts them', () => {
      const response = new Subject<{ success: boolean }>();
      posts.setConfig.mockReturnValue(response);
      const reloaded = vi.fn();
      posts.reload_config.subscribe(reloaded);
      component.new_config.Host.port = 18000;

      component.saveSettings();

      expect(posts.setConfig).toHaveBeenCalledExactlyOnceWith({ YtdlMaterial: component.new_config });
      expect(component.settingsSame()).toBe(false);
      expect(reloaded).not.toHaveBeenCalled();
      response.next({ success: true });
      expect(component.settingsSame()).toBe(true);
      expect(component.initial_config.Host.port).toBe(18000);
      expect(reloaded).toHaveBeenCalledExactlyOnceWith(true);
      component.new_config.Host.port = 19000;
      expect(component.initial_config.Host.port).toBe(18000);
      expect(posts.config.Host.port).toBe(17442);
    });

    it.each([
      [false, true, true], [false, false, false], [true, true, false], [true, false, false]
    ])('checks for an admin when multi-user mode changes from %s to %s: %s', (before, after, checkAdmin) => {
      component.initial_config.Advanced.multi_user_mode = before;
      component.new_config.Advanced.multi_user_mode = after;
      component.saveSettings();
      if (checkAdmin) expect(posts.checkAdminCreationStatus).toHaveBeenCalledExactlyOnceWith(true);
      else expect(posts.checkAdminCreationStatus).not.toHaveBeenCalled();
    });

    it.each(['rejected', 'network error'])('preserves unsaved edits when saving fails with %s', failure => {
      posts.setConfig.mockReturnValue(failure === 'rejected' ? of({ success: false }) : throwError(() => new Error('offline')));
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
      const reloaded = vi.fn();
      posts.reload_config.subscribe(reloaded);
      component.new_config.Advanced.multi_user_mode = true;

      component.saveSettings();

      expect(component.initial_config.Advanced.multi_user_mode).toBe(false);
      expect(component.new_config.Advanced.multi_user_mode).toBe(true);
      expect(component.settingsSame()).toBe(false);
      expect(posts.checkAdminCreationStatus).not.toHaveBeenCalled();
      expect(reloaded).not.toHaveBeenCalled();
      if (failure === 'network error') expect(logged).toHaveBeenCalledWith('Failed to save config!');
    });
  });

  describe('categories', () => {
    it('persists the full category order after a drag', () => {
      component.dropCategory({ previousIndex: 0, currentIndex: 2 } as CdkDragDrop<string[]>);
      expect(posts.categories.map(category => category.uid)).toEqual(['second', 'third', 'first']);
      expect(posts.updateCategories).toHaveBeenCalledExactlyOnceWith(posts.categories);
      expect(posts.openSnackBar).not.toHaveBeenCalled();
    });

    it('reports an error when the new category order cannot be saved', () => {
      posts.updateCategories.mockReturnValue(throwError(() => new Error('offline')));
      component.dropCategory({ previousIndex: 2, currentIndex: 0 } as CdkDragDrop<string[]>);
      expect(posts.openSnackBar).toHaveBeenCalledWith('Failed to update categories!');
    });

    it('waits for a category name, then refreshes and opens the new category for editing', () => {
      const response = new Subject<any>();
      posts.createCategory.mockReturnValue(response);
      component.openAddCategoryDialog();
      expect(harness.dialog.open).toHaveBeenCalledWith(InputDialogComponent, expect.objectContaining({
        data: expect.objectContaining({ submitText: 'Add' })
      }));
      harness.dialogData().doneEmitter.emit('Podcasts');
      expect(posts.createCategory).toHaveBeenCalledExactlyOnceWith('Podcasts');
      expect(harness.dialogRef.close).not.toHaveBeenCalled();
      expect(posts.reloadCategories).not.toHaveBeenCalled();

      const category = { uid: 'new-category', name: 'Podcasts', rules: [] };
      response.next({ success: true, new_category: category });
      expect(posts.reloadCategories).toHaveBeenCalledTimes(1);
      expect(harness.dialogRef.close).toHaveBeenCalledTimes(1);
      expect(harness.dialog.open).toHaveBeenLastCalledWith(EditCategoryDialogComponent, expect.objectContaining({ data: { category } }));
    });

    it.each([null, undefined, '', false])('does not create a category when the name is %s', name => {
      component.openAddCategoryDialog();
      harness.dialogData().doneEmitter.emit(name);
      expect(posts.createCategory).not.toHaveBeenCalled();
      expect(harness.dialogRef.close).not.toHaveBeenCalled();
    });

    it('keeps the name dialog open when category creation is rejected', () => {
      posts.createCategory.mockReturnValue(of({ success: false }));
      component.openAddCategoryDialog();
      harness.dialogData().doneEmitter.emit('Duplicate');
      expect(harness.dialogRef.close).not.toHaveBeenCalled();
      expect(posts.reloadCategories).not.toHaveBeenCalled();
      expect(harness.dialog.open).toHaveBeenCalledTimes(1);
    });

    it('shows progress while adding defaults and publishes the returned categories', () => {
      const response = new Subject<any>();
      posts.createDefaultCategories.mockReturnValue(response);
      const changed = vi.fn();
      posts.categories_changed.subscribe(changed);
      component.addDefaultCategories();
      expect(component.addingDefaultCategories).toBe(true);
      expect(changed).not.toHaveBeenCalled();

      const categories = [{ uid: 'default', name: 'Default' }];
      response.next({ success: true, categories });
      expect(component.addingDefaultCategories).toBe(false);
      expect(posts.categories).toEqual(categories);
      expect(changed).toHaveBeenCalledExactlyOnceWith(true);
      expect(posts.openSnackBar).toHaveBeenCalledWith('Default categories added!');
      expect(posts.reloadCategories).not.toHaveBeenCalled();
    });

    it.each(['Categories already exist', undefined])('reloads categories after an unsuccessful defaults response (%s)', error => {
      posts.createDefaultCategories.mockReturnValue(of({ success: false, error }));
      const original = [...posts.categories];
      const changed = vi.fn();
      posts.categories_changed.subscribe(changed);
      component.addDefaultCategories();
      expect(component.addingDefaultCategories).toBe(false);
      expect(posts.categories).toEqual(original);
      expect(changed).not.toHaveBeenCalled();
      expect(posts.openSnackBar).toHaveBeenCalledWith(error || 'Failed to add default categories!');
      expect(posts.reloadCategories).toHaveBeenCalledTimes(1);
    });

    it('clears defaults progress and reports network failures', () => {
      const response = new Subject<unknown>();
      posts.createDefaultCategories.mockReturnValue(response);
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
      component.addDefaultCategories();
      expect(component.addingDefaultCategories).toBe(true);
      const error = new Error('offline');
      response.error(error);
      expect(component.addingDefaultCategories).toBe(false);
      expect(posts.openSnackBar).toHaveBeenCalledWith('Failed to add default categories!');
      expect(logged).toHaveBeenCalledWith(error);
    });

    it.each([false, undefined])('does not delete a category when confirmation closes with %s', confirmed => {
      component.deleteCategory(posts.categories[0]);
      expect(posts.deleteCategory).not.toHaveBeenCalled();
      harness.closed.next(confirmed);
      expect(posts.deleteCategory).not.toHaveBeenCalled();
    });

    it('deletes the confirmed category by ID and reloads the list', () => {
      const category = posts.categories[0];
      component.deleteCategory(category);
      expect(harness.dialog.open).toHaveBeenCalledWith(ConfirmDialogComponent, expect.objectContaining({
        data: expect.objectContaining({ dialogText: 'Would you like to delete First?', warnSubmitColor: true })
      }));
      harness.closed.next(true);
      expect(posts.deleteCategory).toHaveBeenCalledExactlyOnceWith(category.uid);
      expect(posts.reloadCategories).toHaveBeenCalledTimes(1);
      expect(posts.openSnackBar).toHaveBeenCalledWith('Successfully deleted First!');
    });

    it('does not report deletion success when the backend rejects it', () => {
      posts.deleteCategory.mockReturnValue(of({ success: false }));
      component.deleteCategory(posts.categories[0]);
      harness.closed.next(true);
      expect(posts.reloadCategories).not.toHaveBeenCalled();
      expect(posts.openSnackBar).not.toHaveBeenCalled();
    });

    it('identifies the category when deletion fails', () => {
      posts.deleteCategory.mockReturnValue(throwError(() => new Error('offline')));
      component.deleteCategory(posts.categories[0]);
      harness.closed.next(true);
      expect(posts.openSnackBar).toHaveBeenCalledWith('Failed to delete First!');
      expect(posts.reloadCategories).not.toHaveBeenCalled();
    });
  });

  describe('configuration dialogs', () => {
    beforeEach(() => component.getConfig());

    it.each(['--embed-thumbnail', ''])('accepts edited custom arguments, including an empty string (%s)', args => {
      component.openArgsModifierDialog();
      expect(harness.dialog.open).toHaveBeenCalledWith(ArgModifierDialogComponent, expect.objectContaining({
        data: { initial_args: '--embed-metadata' }
      }));
      harness.closed.next(args);
      expect(component.new_config.Downloader.custom_args).toBe(args);
      expect(component.initial_config.Downloader.custom_args).toBe('--embed-metadata');
    });

    it.each([null, undefined])('preserves custom arguments when the dialog is dismissed with %s', result => {
      component.openArgsModifierDialog();
      harness.closed.next(result);
      expect(component.new_config.Downloader.custom_args).toBe('--embed-metadata');
      expect(component.settingsSame()).toBe(true);
    });

    it('passes the pending webhook template to the dialog and applies the edited result', () => {
      component.new_config.API.custom_webhook_title_template = 'Pending title';
      component.openWebhookTemplateDialog();
      expect(harness.dialog.open).toHaveBeenCalledWith(WebhookTemplateDialogComponent, expect.objectContaining({
        data: { customEnabled: false, titleTemplate: 'Pending title', bodyTemplate: '{{event_body}}' }
      }));
      harness.closed.next({ customEnabled: true, titleTemplate: 'New title', bodyTemplate: 'New body' });
      expect(component.new_config.API).toEqual({
        use_custom_webhook_template: true, custom_webhook_title_template: 'New title', custom_webhook_body_template: 'New body'
      });
      expect(posts.config.API.custom_webhook_title_template).toBe('{{event_name}}');
    });

    it.each([null, undefined])('preserves the webhook template when dismissed with %s', result => {
      component.openWebhookTemplateDialog();
      harness.closed.next(result);
      expect(component.settingsSame()).toBe(true);
    });

    it('normalizes missing or non-string webhook template results', () => {
      component.openWebhookTemplateDialog();
      harness.closed.next({ customEnabled: undefined, titleTemplate: 17, bodyTemplate: null });
      expect(component.new_config.API).toEqual({
        use_custom_webhook_template: false, custom_webhook_title_template: '', custom_webhook_body_template: ''
      });
    });

    it.each([
      ['openCookiesUploaderDialog', CookiesUploaderDialogComponent],
      ['openGenerateRSSURLDialog', GenerateRssUrlComponent]
    ] as const)('%s opens the corresponding tool', (method, dialogComponent) => {
      component[method]();
      expect(harness.dialog.open).toHaveBeenCalledWith(dialogComponent, expect.objectContaining({ autoFocus: 'dialog' }));
    });
  });

  describe('maintenance', () => {
    it('does not kill downloads before confirmation or after cancellation', () => {
      component.killAllDownloads();
      expect(harness.dialog.open).toHaveBeenCalledWith(ConfirmDialogComponent, expect.objectContaining({
        data: expect.objectContaining({ warnSubmitColor: true, submitText: 'Kill all downloads' })
      }));
      expect(posts.killAllDownloads).not.toHaveBeenCalled();
      harness.dialogData().doneEmitter.emit(false);
      expect(posts.killAllDownloads).not.toHaveBeenCalled();
      expect(harness.dialogRef.close).not.toHaveBeenCalled();
    });

    it.each([true, false, 'error'])('closes the kill dialog and reports the outcome (%s)', outcome => {
      const response = new Subject<{ success: boolean }>();
      posts.killAllDownloads.mockReturnValue(response);
      component.killAllDownloads();
      harness.dialogData().doneEmitter.emit(true);
      expect(posts.killAllDownloads).toHaveBeenCalledTimes(1);
      expect(harness.dialogRef.close).not.toHaveBeenCalled();
      if (outcome === 'error') response.error(new Error('offline'));
      else response.next({ success: outcome as boolean });
      expect(harness.dialogRef.close).toHaveBeenCalledTimes(1);
      expect(posts.openSnackBar).toHaveBeenCalledWith(outcome === true
        ? 'Successfully killed all downloads!'
        : 'Failed to kill all downloads! Check logs for details.');
    });

    it.each([true, false])('reports the restart request outcome (success: %s)', success => {
      posts.restartServer.mockReturnValue(success ? of({}) : throwError(() => new Error('offline')));
      component.restartServer();
      expect(posts.restartServer).toHaveBeenCalledTimes(1);
      expect(posts.openSnackBar).toHaveBeenCalledWith(success ? 'Restarting!' : 'Failed to restart the server.');
    });

    it.each([false, true])('closes orphan cleanup only after the API finishes (error: %s)', fail => {
      const response = new Subject<any>();
      posts.deleteOrphanFiles.mockReturnValue(response);
      component.deleteOrphanFiles();
      harness.dialogData().doneEmitter.emit(true);
      expect(harness.dialogRef.close).not.toHaveBeenCalled();
      if (fail) response.error(new Error('offline'));
      else response.next({ deleted_count: 0, failed_count: 0 });
      expect(harness.dialogRef.close).toHaveBeenCalledTimes(1);
      expect(posts.openSnackBar).toHaveBeenCalledWith(fail
        ? 'Failed to delete orphan videos! Check logs for details.' : 'Deleted 0 orphan(s).');
    });
  });

  describe('database operations', () => {
    beforeEach(() => { component.db_info = { using_local_db: true }; });

    it.each([false, undefined])('does not transfer the database when confirmation closes with %s', confirmed => {
      component.transferDB();
      expect(posts.transferDB).not.toHaveBeenCalled();
      harness.closed.next(confirmed);
      expect(posts.transferDB).not.toHaveBeenCalled();
      expect(component.db_transferring).toBe(false);
    });

    it.each([true, false])('transfers in the correct direction and refreshes info on success (local: %s)', usingLocal => {
      const response = new Subject<any>();
      posts.transferDB.mockReturnValue(response);
      component.db_info = { using_local_db: usingLocal };
      posts.getDBInfo.mockReturnValue(of({ using_local_db: !usingLocal }));
      component.transferDB();
      harness.closed.next(true);
      expect(component.db_transferring).toBe(true);
      expect(posts.transferDB).toHaveBeenCalledExactlyOnceWith(usingLocal);
      expect(posts.getDBInfo).not.toHaveBeenCalled();
      response.next({ success: true });
      expect(component.db_transferring).toBe(false);
      expect(posts.getDBInfo).toHaveBeenCalledTimes(1);
      expect(component.db_info.using_local_db).toBe(!usingLocal);
      expect(posts.openSnackBar).toHaveBeenCalledWith('Successfully transfered DB! Reloading info...');
    });

    it('reports an aborted transfer without refreshing database information', () => {
      posts.transferDB.mockReturnValue(of({ success: false, error: 'Destination unavailable' }));
      component._transferDB();
      expect(component.db_transferring).toBe(false);
      expect(posts.getDBInfo).not.toHaveBeenCalled();
      expect(posts.openSnackBar).toHaveBeenCalledWith('Failed to transfer DB -- transfer was aborted. Error: Destination unavailable');
    });

    it('clears transfer progress and logs API errors', () => {
      const response = new Subject<unknown>();
      posts.transferDB.mockReturnValue(response);
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
      component._transferDB();
      expect(component.db_transferring).toBe(true);
      const error = new Error('offline');
      response.error(error);
      expect(component.db_transferring).toBe(false);
      expect(posts.getDBInfo).not.toHaveBeenCalled();
      expect(posts.openSnackBar).toHaveBeenCalledWith('Failed to transfer DB -- API call failed. See browser logs for details.');
      expect(logged).toHaveBeenCalledWith(error);
    });

    it.each([true, false, 'error'])('tests the supplied connection and clears progress (%s)', outcome => {
      const response = new Subject<any>();
      posts.testConnectionString.mockReturnValue(response);
      component.testConnectionString('postgres://localhost/media');
      expect(posts.testConnectionString).toHaveBeenCalledExactlyOnceWith('postgres://localhost/media');
      expect(component.testing_connection_string).toBe(true);
      if (outcome === 'error') response.error(new Error('offline'));
      else response.next({ success: outcome, error: 'Access denied' });
      expect(component.testing_connection_string).toBe(false);
      const message = outcome === true ? 'Connection successful!' : outcome === false
        ? 'Connection failed! Error: Access denied'
        : 'Connection failed! Error: Server error. See logs for more info.';
      expect(posts.openSnackBar).toHaveBeenCalledWith(message);
    });
  });

  describe('cookie checks', () => {
    it.each(['', '   ', null, undefined])('rejects a missing test URL (%s)', url => {
      component.cookiesTestUrl = url;
      component.runCookiesTest();
      expect(posts.testCookies).not.toHaveBeenCalled();
      expect(component.testingCookies).toBe(false);
      expect(component.cookiesTestComplete).toBe(false);
      expect(posts.openSnackBar).toHaveBeenCalledWith('Please provide a URL to test.');
    });

    it.each([true, false])('trims the URL, resets a previous result, and displays the response (success: %s)', success => {
      const response = new Subject<any>();
      posts.testCookies.mockReturnValue(response);
      component.cookiesTestUrl = '  https://media.example.test/watch?id=123  ';
      component.cookiesTestComplete = true;
      component.cookiesTestSuccess = true;
      component.cookiesTestLogs = ['Old result'];
      component.runCookiesTest();
      expect(posts.testCookies).toHaveBeenCalledExactlyOnceWith('https://media.example.test/watch?id=123');
      expect(component.testingCookies).toBe(true);
      expect(component.cookiesTestComplete).toBe(false);
      expect(component.cookiesTestSuccess).toBeNull();
      expect(component.cookiesTestLogs).toEqual(['Running cookies test...']);
      response.next({ success, logs: ['Reading cookies', success ? 'Authenticated' : 'Expired'] });
      expect(component.testingCookies).toBe(false);
      expect(component.cookiesTestComplete).toBe(true);
      expect(component.cookiesTestSuccess).toBe(success);
      expect(component.cookiesTestLogs).toEqual(['Reading cookies', success ? 'Authenticated' : 'Expired']);
      expect(posts.openSnackBar).toHaveBeenCalledWith(success ? 'Cookies test passed.' : 'Cookies test failed. Review logs below.');
    });

    it.each([null, undefined, 'unexpected log text', {}])('handles a response without a log array (%s)', logs => {
      posts.testCookies.mockReturnValue(of({ success: false, logs }));
      component.cookiesTestUrl = 'https://media.example.test/watch';
      component.runCookiesTest();
      expect(component.cookiesTestLogs).toEqual([]);
      expect(component.cookiesTestSuccess).toBe(false);
      expect(component.cookiesTestComplete).toBe(true);
    });

    it.each([
      { error: { logs: ['Cookies expired', 'Sign in again'] } },
      { error: { logs: [] } },
      { error: { logs: 'not an array' } },
      { error: {} },
      new Error('offline'),
      null
    ])('clears progress and uses server logs or a fallback on errors (%j)', error => {
      const response = new Subject<unknown>();
      posts.testCookies.mockReturnValue(response);
      component.cookiesTestUrl = 'https://media.example.test/watch';
      component.runCookiesTest();
      expect(component.testingCookies).toBe(true);
      response.error(error);
      expect(component.testingCookies).toBe(false);
      expect(component.cookiesTestComplete).toBe(true);
      expect(component.cookiesTestSuccess).toBe(false);
      const logs = (error as any)?.error?.logs;
      expect(component.cookiesTestLogs).toEqual(Array.isArray(logs) && logs.length
        ? logs : ['Cookies test failed due to a server error.']);
      expect(posts.openSnackBar).toHaveBeenCalledWith('Cookies test failed. Review logs below.');
    });
  });

  describe('hardware acceleration status', () => {
    it.each([
      [null, false],
      [{ mode: false, checked: false, available: false }, false],
      [{ mode: 'nvenc', checked: false, available: false }, true],
      [{ mode: 'nvenc', checked: true, available: true }, false],
      [{ mode: 'nvenc', checked: true, available: null }, false]
    ])('only shows pending status for an enabled, unchecked mode (%j)', (status, pending) => {
      posts.transcodingStatus = status as PostsService['transcodingStatus'];
      expect(component.transcodingTestPending).toBe(pending);
      expect(component.transcodingWarning).toBeNull();
    });

    it.each([null, 'No compatible GPU'])('explains a failed hardware check with optional error details (%s)', error => {
      posts.transcodingStatus = {
        mode: 'nvenc', checked: true, available: false, label: 'Nvidia NVENC', error,
        in_progress: false, last_checked: 1
      };
      expect(component.transcodingTestPending).toBe(false);
      expect(component.transcodingWarning).toBe(
        'The hardware acceleration flight test failed for Nvidia NVENC. Video processing will fall back to software encoding.'
        + (error ? ' (No compatible GPU)' : '')
      );
    });
  });

  describe('bookmarklet', () => {
    it('targets the home page on this installation and encodes the source page URL', () => {
      const originalUrl = window.location.href;
      try {
        window.history.replaceState(null, '', '/media/#/settings;tab=extra');
        const code = decodeURIComponent(component.generateBookmarkletCode());
        expect(code).toContain(`window.open('${window.location.origin}/media/#/home;url=' + encodeURIComponent(window.location)`);
        expect(code).toContain(';audioOnly=false');
        expect(code).not.toContain('#/settings');
      } finally {
        window.history.replaceState(null, '', originalUrl);
      }
    });

    it.each([true, false])('regenerates the trusted link when audio-only mode is %s', audioOnly => {
      component.bookmarkletAudioOnlyChanged(audioOnly);
      expect(component.bookmarkletAudioOnly).toBe(audioOnly);
      expect(harness.sanitizer.bypassSecurityTrustUrl).toHaveBeenCalledWith(expect.stringContaining(`;audioOnly=${audioOnly}`));
      expect(component.generated_bookmarklet_code).toBe(harness.sanitizer.bypassSecurityTrustUrl.mock.results[0].value);
    });

    describe('legacy browser integration', () => {
      const properties: [object, string][] = [
        [document, 'all'], [window, 'external'], [window, 'chrome'],
        [window, 'sidebar'], [window, 'opera'], [window, 'print']
      ];
      let descriptors: PropertyDescriptor[];
      const setProperty = (target: object, key: string, value: unknown) => {
        Object.defineProperty(target, key, { configurable: true, writable: true, value });
      };

      beforeEach(() => {
        descriptors = properties.map(([target, key]) => Object.getOwnPropertyDescriptor(target, key));
        properties.forEach(([target, key]) => setProperty(target, key, undefined));
      });

      afterEach(() => {
        properties.forEach(([target, key], index) => {
          if (descriptors[index]) Object.defineProperty(target, key, descriptors[index]);
          else Reflect.deleteProperty(target, key);
        });
      });

      it('explains how to bookmark manually in Chromium browsers', () => {
        setProperty(window, 'chrome', {});
        component.generateBookmarklet();
        expect(posts.openSnackBar).toHaveBeenCalledWith("Chrome users must drag the 'Alternate URL' link to your bookmarks.");
      });

      it('passes the generated title and URL to the legacy favorites API', () => {
        const addFavorite = vi.fn();
        setProperty(document, 'all', true);
        setProperty(window, 'external', { AddFavorite: addFavorite });
        component.generated_bookmarklet_code = component.generateBookmarkletCode();
        component.generateBookmarklet();
        expect(addFavorite).toHaveBeenCalledExactlyOnceWith(component.generated_bookmarklet_code, 'ytdl-material');
      });

      it('passes the title and URL to the legacy sidebar API', () => {
        const addPanel = vi.fn();
        setProperty(window, 'sidebar', { addPanel });
        component.bookmarksite('Media', 'https://media.example.test');
        expect(addPanel).toHaveBeenCalledExactlyOnceWith('Media', 'https://media.example.test', '');
      });

      it('activates a sidebar bookmark link for legacy Opera', () => {
        setProperty(window, 'opera', {});
        setProperty(window, 'print', vi.fn());
        const clicked = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
        component.bookmarksite('Media', 'https://media.example.test');
        expect(clicked).toHaveBeenCalledTimes(1);
        const anchor = clicked.mock.contexts[0] as HTMLAnchorElement;
        expect(anchor.getAttribute('href')).toBe('https://media.example.test');
        expect(anchor.getAttribute('title')).toBe('Media');
        expect(anchor.getAttribute('rel')).toBe('sidebar');
      });

      it.each([undefined, {}])('does nothing when bookmark APIs are unavailable (opera: %j)', opera => {
        setProperty(window, 'opera', opera);
        const clicked = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
        expect(() => component.bookmarksite('Media', 'https://media.example.test')).not.toThrow();
        expect(clicked).not.toHaveBeenCalled();
        expect(posts.openSnackBar).not.toHaveBeenCalled();
      });
    });
  });

  describe('incomplete and optional settings', () => {
    it.each([null, {}, { Advanced: {} }])('provides defaults before settings have loaded (%j)', config => {
      component.new_config = config;
      component.initial_config = config;
      posts.config = config as typeof posts.config;
      expect(component.selectedDownloader).toBe('yt-dlp');
      expect(component.getDownloaderLabel('yt-dlp', 'stable')).toBe('yt-dlp stable');
      expect(component.serverEnvironment).toEqual([]);
      expect(component.notificationTypeEnabled('download_error')).toBe(false);
      expect(component.notificationTypesLocked).toBe(true);
      expect(component.tabDisabled('users')).toBe(true);
      expect(component.tabDisabled('advanced')).toBe(false);
      expect(component.oidcSettings).toBeNull();
    });

    it('clears a missing downloader selection without discarding the saved update channel', () => {
      component.getConfig();
      component.selectedDownloader = null;
      expect(component.new_config.Advanced.default_downloader).toBe('');
      expect(component.new_config.Advanced.ytdlp_update_channel).toBe('stable');
    });

    it('shows trimmed custom identity-provider claims and redirect settings', () => {
      posts.config.Users.oidc = {
        enabled: true, redirect_uri: ' https://media.example.test/callback ', scope: ' openid email ',
        auto_register: true, username_claim: ' email ', display_name_claim: ' name ',
        admin_claim: ' roles ', admin_value: ' owners ', group_claim: ' teams ', allowed_groups: ' media,admin '
      } as typeof posts.config.Users.oidc;
      expect(Object.fromEntries(component.oidcDetails.map(detail => [detail.label, detail.value]))).toEqual({
        'Redirect URI': 'https://media.example.test/callback', 'Scope': 'openid email',
        'Register users on first sign-in': 'Yes', 'Username claim': 'email', 'Display name claim': 'name',
        'Admin claim': 'roles = owners', 'Group claim': 'teams', 'Allowed groups': 'media,admin'
      });
    });

    it('shows missing optional identity-provider fields without rendering undefined values', () => {
      const details = Object.fromEntries(component.oidcDetails.map(detail => [detail.label, detail.value]));
      expect(details['Redirect URI']).toBe('Not set');
      expect(details['Display name claim']).toBe('preferred_username');
      expect(details['Group claim']).toBe('groups');
      expect(component.oidcSecrets.every(secret => !secret.configured)).toBe(true);
    });
  });
});
