import { Component, OnInit, EventEmitter, ChangeDetectionStrategy } from '@angular/core';
import { OIDCStatus, PostsService } from 'app/posts.services';
import { MatSnackBar } from '@angular/material/snack-bar';
import {DomSanitizer} from '@angular/platform-browser';
import { MatDialog } from '@angular/material/dialog';
import { ArgModifierDialogComponent } from 'app/dialogs/arg-modifier-dialog/arg-modifier-dialog.component';
import { CURRENT_VERSION } from 'app/consts';
import { CookiesUploaderDialogComponent } from 'app/dialogs/cookies-uploader-dialog/cookies-uploader-dialog.component';
import { openConfirmDialog } from 'app/dialogs/confirm-dialog/confirm-dialog.component';
import { moveItemInArray, CdkDragDrop, CdkDropList, CdkDrag, CdkDragHandle, CdkDragPlaceholder } from '@angular/cdk/drag-drop';
import { InputDialogComponent } from 'app/input-dialog/input-dialog.component';
import { EditCategoryDialogComponent } from 'app/dialogs/edit-category-dialog/edit-category-dialog.component';
import { ActivatedRoute, Router } from '@angular/router';
import { Category, DBInfoResponse } from 'api-types';
import { GenerateRssUrlComponent } from 'app/dialogs/generate-rss-url/generate-rss-url.component';
import { filter, take } from 'rxjs/operators';
import { WebhookTemplateDialogComponent, WebhookTemplateDialogResult } from 'app/dialogs/webhook-template-dialog/webhook-template-dialog.component';
import { FormsModule } from '@angular/forms';
import { MatSlideToggle } from '@angular/material/slide-toggle';
import { MatTooltip } from '@angular/material/tooltip';
import { MatIcon } from '@angular/material/icon';
import { MatProgressSpinner } from '@angular/material/progress-spinner';
import { PickerComponent, PickerOption } from 'app/components/picker/picker.component';
import { UpdaterComponent } from '../updater/updater.component';
import { ModifyUsersComponent } from '../components/modify-users/modify-users.component';
import { LogsViewerComponent } from '../components/logs-viewer/logs-viewer.component';
import { KeyValuePipe } from '@angular/common';

type CookiesTestResponse = {
  success: boolean;
  logs: string[];
};

type DownloaderVersionInfo = {
  downloader: string;
  version: string | null;
  binary_exists: boolean;
  loaded: boolean;
};

type VersionInfoWithDownloader = {
  downloader_info?: Record<string, DownloaderVersionInfo>;
};

// Keep in sync with YTDLP_UPDATE_CHANNELS in backend/youtube-dl.js.
const YTDLP_UPDATE_CHANNELS = ['stable', 'nightly', 'master'];

@Component({
    selector: 'app-settings',
    templateUrl: './settings.component.html',
    styleUrls: ['./settings.component.scss'],
    changeDetection: ChangeDetectionStrategy.Eager,
    imports: [FormsModule, MatSlideToggle, MatTooltip, MatIcon, MatProgressSpinner, PickerComponent, CdkDropList, CdkDrag, CdkDragHandle, CdkDragPlaceholder, UpdaterComponent, ModifyUsersComponent, LogsViewerComponent, KeyValuePipe]
})
export class SettingsComponent implements OnInit {
  initial_config = null;
  new_config = null
  loading_config = false;
  generated_bookmarklet_code = null;
  bookmarkletAudioOnly = false;

  db_info: DBInfoResponse = null;
  db_transferring = false;
  testing_connection_string = false;
  testingCookies = false;
  cookiesTestComplete = false;
  cookiesTestSuccess: boolean = null;
  cookiesTestUrl = '';
  cookiesTestLogs: string[] = [];

  _settingsSame = true;

  latestGithubRelease = null;
  CURRENT_VERSION = CURRENT_VERSION
  downloaderInfo: Record<string, DownloaderVersionInfo> = {};
  addingDefaultCategories = false;

  // The key is what the route carries (/settings;tab=downloader), so it cannot change.
  readonly tabs: { key: string, label: string, icon: string }[] = [
    { key: 'main',          label: $localize`Main`,          icon: 'tune' },
    { key: 'downloader',    label: $localize`Downloader`,    icon: 'download' },
    { key: 'extra',         label: $localize`Extra`,         icon: 'extension' },
    { key: 'database',      label: $localize`Database`,      icon: 'storage' },
    { key: 'notifications', label: $localize`Notifications`, icon: 'notifications' },
    { key: 'advanced',      label: $localize`Advanced`,      icon: 'build' },
    { key: 'users',         label: $localize`Users`,         icon: 'group' },
    { key: 'logs',          label: $localize`Logs`,          icon: 'receipt_long' }
  ];
  tab = 'main';

  usersTabDisabledTooltip = $localize`You must enable multi-user mode to access this tab.`;

  // What the backend answered about OIDC, which is the only way to tell whether the settings
  // it was given actually work.
  oidcStatus: OIDCStatus = null;

  readonly themeOptions: PickerOption[] = [
    { value: 'default', label: $localize`Default` },
    { value: 'dark', label: $localize`Dark` }
  ];

  readonly transcodingOptions: PickerOption[] = [
    { value: false, label: $localize`None` },
    { value: 'amf', label: 'AMD AMF' },
    { value: 'nvenc', label: 'Nvidia NVENC' },
    { value: 'qsv', label: 'Intel Quicksync (QSV)' },
    { value: 'vaapi', label: 'Video Acceleration API (VAAPI)' }
  ];

  readonly remoteDbTypeOptions: PickerOption[] = [
    { value: '', label: $localize`Automatic` },
    { value: 'postgres', label: 'PostgreSQL' },
    { value: 'mongo', label: 'MongoDB' }
  ];

  readonly dbMigrateOptions: PickerOption[] = [
    { value: '', label: $localize`Disabled` },
    { value: 'postgres', label: $localize`MongoDB to PostgreSQL on startup` },
    { value: 'mongo', label: $localize`PostgreSQL to MongoDB on startup` }
  ];

  readonly downloadingAgentOptions: PickerOption[] = ['aria2c', 'avconv', 'axel', 'curl', 'ffmpeg', 'httpie', 'wget']
    .map(agent => ({ value: agent, label: agent }));

  readonly loggerLevelOptions: PickerOption[] = [
    { value: 'debug', label: 'Debug' },
    { value: 'verbose', label: 'Verbose' },
    { value: 'info', label: 'Info' },
    { value: 'warn', label: 'Warn' },
    { value: 'error', label: 'Error' }
  ];

  readonly jwtExpirationOptions: PickerOption[] = [
    { value: 3600, label: $localize`1 Hour` },
    { value: 86400, label: $localize`1 Day` },
    { value: 604800, label: $localize`1 Week` },
    { value: 2592000, label: $localize`1 Month` },
    { value: 31536000, label: $localize`1 Year` }
  ];

  readonly authMethodOptions: PickerOption[] = [
    { value: 'internal', label: $localize`Internal` },
    { value: 'ldap', label: $localize`LDAP` }
  ];

  // The three kinds a notification can be, as chips rather than a multiple select.
  readonly notificationTypes: { key: string, label: string }[] = [
    { key: 'download_complete', label: $localize`Download complete` },
    { key: 'download_error', label: $localize`Download error` },
    { key: 'task_finished', label: $localize`Task finished` }
  ];

  readonly themeLabel = $localize`Theme`;
  readonly transcodingLabel = $localize`Hardware acceleration`;
  readonly remoteDbTypeLabel = $localize`Remote database`;
  readonly dbMigrateLabel = $localize`Migration`;
  readonly downloaderLabel = $localize`Downloader`;
  readonly downloadingAgentLabel = $localize`Download agent`;
  readonly loggerLevelLabel = $localize`Log level`;
  readonly jwtExpirationLabel = $localize`Login expires`;
  readonly authMethodLabel = $localize`Auth method`;

  // Names for the controls whose label is the row they sit in rather than their own element.
  readonly argsLabel = $localize`Global custom args`;
  readonly notificationTypesLabel = $localize`Allowed notification types`;
  readonly webhookLabel = $localize`Webhook URL`;
  readonly discordLabel = $localize`Discord Webhook URL`;
  readonly slackLabel = $localize`Slack Webhook URL`;
  readonly postgresLabel = $localize`PostgreSQL Connection String`;
  readonly mongoLabel = $localize`MongoDB Connection String`;
  readonly redisLabel = $localize`Redis Connection String`;
  readonly cookiesTestUrlLabel = $localize`Test URL`;

  get settingsAreTheSame(): boolean {
    this._settingsSame = this.settingsSame()
    return this._settingsSame;
  }

  set settingsAreTheSame(val: boolean) {
    this._settingsSame = val;
  }

  get transcodingWarning(): string {
    const status = this.postsService.transcodingStatus;
    if (!status || !status.mode || !status.checked || status.available !== false) return null;
    const warning = $localize`The hardware acceleration flight test failed for ${status.label}:mode:. Video processing will fall back to software encoding.`;
    return status.error ? `${warning} (${status.error})` : warning;
  }

  get transcodingTestPending(): boolean {
    const status = this.postsService.transcodingStatus;
    return !!(status && status.mode && !status.checked);
  }

  /*************************************************
   * Single sign-on, shown but never edited here: it
   * is set with the ytdl_oidc_* environment
   * variables, and the settings page saves the whole
   * config document, so an editable copy of it would
   * be one more thing that can overwrite what the
   * environment put there.
   *
   * Read from the saved config rather than the
   * pending one for the same reason: this describes
   * the server as it is running, not an edit.
   ************************************************/
  get oidcSettings(): Record<string, unknown> {
    const oidc = this.postsService.config?.['Users']?.['oidc'];
    return oidc && oidc['enabled'] ? oidc : null;
  }

  // The three the backend treats as secrets. An admin is handed them in full -- they are
  // still credentials, so the page says whether each one is there and nothing more.
  get oidcSecrets(): { label: string, configured: boolean }[] {
    const oidc = this.oidcSettings;
    if (!oidc) return [];
    return [
      { label: $localize`Issuer URL`, configured: !!this.oidcText(oidc['issuer_url']) },
      { label: $localize`Client ID`, configured: !!this.oidcText(oidc['client_id']) },
      { label: $localize`Client secret`, configured: !!this.oidcText(oidc['client_secret']) }
    ];
  }

  // Everything else, carrying the same fallback the backend applies to a blank value, so the
  // page says what is in force rather than what happens to be written down.
  get oidcDetails(): { label: string, value: string }[] {
    const oidc = this.oidcSettings;
    if (!oidc) return [];
    const unset = $localize`Not set`;
    return [
      { label: $localize`Redirect URI`, value: this.oidcText(oidc['redirect_uri']) || unset },
      { label: $localize`Scope`, value: this.oidcText(oidc['scope']) || 'openid profile email' },
      { label: $localize`Register users on first sign-in`, value: oidc['auto_register'] === false ? $localize`No` : $localize`Yes` },
      { label: $localize`Username claim`, value: this.oidcText(oidc['username_claim']) || 'preferred_username' },
      { label: $localize`Display name claim`, value: this.oidcText(oidc['display_name_claim']) || 'preferred_username' },
      { label: $localize`Admin claim`, value: `${this.oidcText(oidc['admin_claim']) || 'groups'} = ${this.oidcText(oidc['admin_value']) || 'admin'}` },
      { label: $localize`Group claim`, value: this.oidcText(oidc['group_claim']) || 'groups' },
      { label: $localize`Allowed groups`, value: this.oidcText(oidc['allowed_groups']) || $localize`Any group` }
    ];
  }

  private oidcText(value: unknown): string {
    return String(value ?? '').trim();
  }

  getOIDCStatus(): void {
    if (!this.oidcSettings) return;
    this.postsService.getOIDCStatus().subscribe(res => {
      this.oidcStatus = res;
    }, () => {
      this.oidcStatus = null;
    });
  }

  constructor(public postsService: PostsService, private snackBar: MatSnackBar, private sanitizer: DomSanitizer,
    private dialog: MatDialog, private router: Router, private route: ActivatedRoute) { }

  ngOnInit(): void {
    if (this.postsService.initialized) {
      this.getConfig();
      this.getDBInfo();
      this.getDownloaderInfo();
      this.getOIDCStatus();
    } else {
      this.postsService.service_initialized
        .pipe(filter(Boolean), take(1))
        .subscribe(() => {
          this.getConfig();
          this.getDBInfo();
          this.getDownloaderInfo();
          this.getOIDCStatus();
        });
    }

    this.generated_bookmarklet_code = this.sanitizer.bypassSecurityTrustUrl(this.generateBookmarkletCode());

    this.getLatestGithubRelease();

    // Followed rather than read once, so a link to a tab works while the page is already open,
    // and so do the back and forward buttons.
    this.route.paramMap.subscribe(params => {
      const tab = params.get('tab');
      this.tab = this.tabs.some(candidate => candidate.key === tab) ? tab : 'main';
    });
  }

  getConfig(): void {
    this.initial_config = this.postsService.config;
    this.new_config = JSON.parse(JSON.stringify(this.initial_config));
  }

  getDownloaderInfo(): void {
    this.postsService.getVersionInfo().subscribe(res => {
      const versionInfo = res as VersionInfoWithDownloader;
      this.downloaderInfo = versionInfo.downloader_info || {};
    });
  }

  // yt-dlp's update channel is folded into the downloader select rather than living in its
  // own control, so the option encodes both as 'yt-dlp@<channel>' ('yt-dlp' means stable).
  get selectedDownloader(): string {
    const fork = this.new_config?.['Advanced']?.['default_downloader'] ?? 'yt-dlp';
    if (fork !== 'yt-dlp') return fork;

    const stored_channel = this.new_config?.['Advanced']?.['ytdlp_update_channel'];
    const channel = this.normalizeYtdlpChannel(stored_channel);
    // An unrecognized channel matches no option, so the select renders empty rather than
    // claiming stable -- the backend skips updating entirely in that state, it does not
    // fall back. Picking any option repairs the stored value.
    if (channel === null) return `yt-dlp@${String(stored_channel).trim()}`;
    return channel === 'stable' ? 'yt-dlp' : `yt-dlp@${channel}`;
  }

  set selectedDownloader(value: string) {
    const [fork, channel] = (value ?? '').split('@');
    this.new_config['Advanced']['default_downloader'] = fork;
    // Leave the stored channel alone for the other forks; it only applies to yt-dlp.
    if (fork === 'yt-dlp') this.new_config['Advanced']['ytdlp_update_channel'] = channel || 'stable';
  }

  // Mirrors getYtDlpUpdateChannel in backend/youtube-dl.js: blank means stable, values are
  // trimmed and lowercased (env vars such as 'NIGHTLY' are valid), anything else is null.
  private normalizeYtdlpChannel(channel: string): string | null {
    const normalized = (channel ?? '').trim().toLowerCase();
    if (!normalized) return 'stable';
    return YTDLP_UPDATE_CHANNELS.includes(normalized) ? normalized : null;
  }

  getDownloaderLabel(downloader: string, channel?: string): string {
    const details = this.downloaderInfo[downloader];
    const version = details?.loaded && details.version ? details.version : null;
    if (!channel) return version ? `${downloader} (${version})` : downloader;

    // The reported version describes whichever binary is currently installed, so only
    // annotate the channel that is actually in use. Compare against the saved config,
    // not the pending one, or the version appears to follow an unsaved selection.
    const installed_channel = this.normalizeYtdlpChannel(this.initial_config?.['Advanced']?.['ytdlp_update_channel']);
    return version && installed_channel === channel
      ? `${downloader} ${channel} (${version})`
      : `${downloader} ${channel}`;
  }

  // Built each time it is read, because the version each label carries arrives separately.
  get downloaderOptions(): PickerOption[] {
    return [
      { value: 'youtube-dl', label: this.getDownloaderLabel('youtube-dl') },
      { value: 'yt-dlp', label: this.getDownloaderLabel('yt-dlp', 'stable') },
      { value: 'yt-dlp@nightly', label: this.getDownloaderLabel('yt-dlp', 'nightly') },
      { value: 'yt-dlp@master', label: this.getDownloaderLabel('yt-dlp', 'master') }
    ];
  }

  notificationTypeEnabled(type: string): boolean {
    const allowed = this.new_config?.['Extra']?.['allowed_notification_types'];
    return Array.isArray(allowed) && allowed.includes(type);
  }

  toggleNotificationType(type: string): void {
    const allowed = this.new_config['Extra']['allowed_notification_types'];
    const current: string[] = Array.isArray(allowed) ? allowed : [];
    this.new_config['Extra']['allowed_notification_types'] = this.notificationTypeEnabled(type)
      ? current.filter(entry => entry !== type)
      : [...current, type];
  }

  /** Whether the kinds of notification to send can still be chosen. */
  get notificationTypesLocked(): boolean {
    return !this.new_config?.['Extra']?.['enable_notifications'] || !!this.new_config?.['Extra']?.['enable_all_notifications'];
  }

  settingsSame(): boolean {
    return JSON.stringify(this.new_config) === JSON.stringify(this.initial_config);
  }

  saveSettings(): void {
    const settingsToSave = {'YtdlMaterial': this.new_config};
    this.postsService.setConfig(settingsToSave).subscribe(res => {
      if (res['success']) {
        if (!this.initial_config['Advanced']['multi_user_mode'] && this.new_config['Advanced']['multi_user_mode']) {
          // multi user mode was enabled, let's check if default admin account exists
          this.postsService.checkAdminCreationStatus(true);
        }
        // sets new config as old config
        this.initial_config = JSON.parse(JSON.stringify(this.new_config));
        this.postsService.reload_config.next(true);
      }
    }, () => {
      console.error('Failed to save config!');
    })
  }

  cancelSettings(): void {
    this.new_config = JSON.parse(JSON.stringify(this.initial_config));
  }

  selectTab(tab: string): void {
    if (tab === this.tab || this.tabDisabled(tab)) return;
    this.tab = tab;
    this.router.navigate(['/settings', {tab: tab}]);
  }

  /** Users only exist in multi-user mode, so its tab is not worth opening without it. */
  tabDisabled(tab: string): boolean {
    return tab === 'users' && !this.postsService.config?.Advanced?.multi_user_mode;
  }

  dropCategory(event: CdkDragDrop<string[]>): void {
    moveItemInArray(this.postsService.categories, event.previousIndex, event.currentIndex);
    this.postsService.updateCategories(this.postsService.categories).subscribe(res => {

    }, () => {
      this.postsService.openSnackBar($localize`Failed to update categories!`);
    });
  }

  openAddCategoryDialog(): void {
    const done = new EventEmitter<boolean>();
    const dialogRef = this.dialog.open(InputDialogComponent, {
      panelClass: 'kit-dialog-panel',
      width: '400px',
      maxWidth: 'calc(100vw - 32px)',
      autoFocus: 'dialog',
      data: {
        inputTitle: 'Name the category',
        inputPlaceholder: 'Name',
        submitText: 'Add',
        doneEmitter: done
      }
    });

    done.subscribe(name => {

      // Eventually do additional checks on name
      if (name) {
        this.postsService.createCategory(name).subscribe(res => {
          if (res['success']) {
            this.postsService.reloadCategories();
            dialogRef.close();
            const new_category = res['new_category'];
            this.openEditCategoryDialog(new_category);
          }
        });
      }
    });
  }

  addDefaultCategories(): void {
    this.addingDefaultCategories = true;
    this.postsService.createDefaultCategories().subscribe(res => {
      this.addingDefaultCategories = false;
      if (res['success']) {
        this.postsService.categories = res['categories'];
        this.postsService.categories_changed.next(true);
        this.postsService.openSnackBar($localize`Default categories added!`);
      } else {
        this.postsService.openSnackBar(res['error'] || $localize`Failed to add default categories!`);
        this.postsService.reloadCategories();
      }
    }, err => {
      this.addingDefaultCategories = false;
      this.postsService.openSnackBar($localize`Failed to add default categories!`);
      console.error(err);
    });
  }

  deleteCategory(category: Category): void {
    const dialogRef = openConfirmDialog(this.dialog, {
      dialogTitle: $localize`Delete category`,
      dialogText: $localize`Would you like to delete ${category['name']}:category name:?`,
      submitText: $localize`Delete`,
      warnSubmitColor: true
    });
    dialogRef.afterClosed().subscribe(confirmed => {
      if (confirmed) {
        this.postsService.deleteCategory(category['uid']).subscribe(res => {
          if (res['success']) {
            this.postsService.openSnackBar($localize`Successfully deleted ${category['name']}:category name:!`);
            this.postsService.reloadCategories();
          }
        }, () => {
          this.postsService.openSnackBar($localize`Failed to delete ${category['name']}:category name:!`);
        });
      }
    });
  }

  openEditCategoryDialog(category: Category): void {
    this.dialog.open(EditCategoryDialogComponent, {
      panelClass: 'kit-dialog-panel',
      width: '580px',
      maxWidth: 'calc(100vw - 32px)',
      maxHeight: 'calc(100dvh - 32px)',
      autoFocus: 'dialog',
      data: {
        category: category
      }
    });
  }

  generateBookmarklet(): void {
    this.bookmarksite('YTDL-Material', this.generated_bookmarklet_code);
  }

  generateBookmarkletCode(): string {
    const currentURL = window.location.href.split('#')[0];
    const homePageWithArgsURL = currentURL + '#/home;url=';
    const audioOnly = this.bookmarkletAudioOnly;
    // tslint:disable-next-line: max-line-length
    const bookmarkletCode = `javascript:(function()%7Bwindow.open('${homePageWithArgsURL}' + encodeURIComponent(window.location) + ';audioOnly=${audioOnly}')%7D)()`;
    return bookmarkletCode;
  }

  bookmarkletAudioOnlyChanged(audio_only: boolean): void {
    this.bookmarkletAudioOnly = audio_only;
    this.generated_bookmarklet_code = this.sanitizer.bypassSecurityTrustUrl(this.generateBookmarkletCode());
  }

  // not currently functioning on most platforms. hence not in use
  bookmarksite(title: string, url: string): void {
    // Internet Explorer
    if (document.all) {
        window['external']['AddFavorite'](url, title);
    } else if (window['chrome']) {
        // Google Chrome
       this.postsService.openSnackBar($localize`Chrome users must drag the 'Alternate URL' link to your bookmarks.`);
    } else if (window['sidebar']) {
        // Firefox
        window['sidebar'].addPanel(title, url, '');
    } else if (window['opera'] && window.print) {
        // Opera
       const elem = document.createElement('a');
       elem.setAttribute('href', url);
       elem.setAttribute('title', title);
       elem.setAttribute('rel', 'sidebar');
       elem.click();
    }
 }

 openArgsModifierDialog(): void {
   const dialogRef = this.dialog.open(ArgModifierDialogComponent, {
     panelClass: 'kit-dialog-panel',
     width: '640px',
     maxWidth: 'calc(100vw - 32px)',
     maxHeight: 'calc(100dvh - 32px)',
     autoFocus: 'dialog',
     data: {
      initial_args: this.new_config['Downloader']['custom_args']
     }
   });
   dialogRef.afterClosed().subscribe(new_args => {
    if (new_args !== null && new_args !== undefined) {
      this.new_config['Downloader']['custom_args'] = new_args;
    }
   });
 }

 getLatestGithubRelease(): void {
    this.postsService.getLatestGithubRelease().subscribe(res => {
      this.latestGithubRelease = res;
    });
  }

  openCookiesUploaderDialog(): void {
    this.dialog.open(CookiesUploaderDialogComponent, {
      panelClass: 'kit-dialog-panel',
      width: '560px',
      maxWidth: 'calc(100vw - 32px)',
      maxHeight: 'calc(100dvh - 32px)',
      autoFocus: 'dialog'
    });
  }

  openWebhookTemplateDialog(): void {
    const dialogRef = this.dialog.open(WebhookTemplateDialogComponent, {
      panelClass: 'kit-dialog-panel',
      width: '600px',
      maxWidth: 'calc(100vw - 32px)',
      maxHeight: 'calc(100dvh - 32px)',
      autoFocus: 'dialog',
      data: {
        customEnabled: !!this.new_config['API']['use_custom_webhook_template'],
        titleTemplate: this.new_config['API']['custom_webhook_title_template'],
        bodyTemplate: this.new_config['API']['custom_webhook_body_template']
      }
    });

    dialogRef.afterClosed().subscribe((res: WebhookTemplateDialogResult | null) => {
      if (!res) return;
      this.new_config['API']['use_custom_webhook_template'] = !!res.customEnabled;
      this.new_config['API']['custom_webhook_title_template'] = typeof res.titleTemplate === 'string' ? res.titleTemplate : '';
      this.new_config['API']['custom_webhook_body_template'] = typeof res.bodyTemplate === 'string' ? res.bodyTemplate : '';
    });
  }

  killAllDownloads(): void {
    const done = new EventEmitter<boolean>();
    const dialogRef = openConfirmDialog(this.dialog, {
      dialogTitle: 'Kill downloads',
      dialogText: 'Are you sure you want to kill all downloads? Any subscription and non-subscription downloads will end immediately, though this operation may take a minute or so to complete.',
      submitText: 'Kill all downloads',
      doneEmitter: done,
      warnSubmitColor: true
    });
    done.subscribe(confirmed => {
      if (confirmed) {
        this.postsService.killAllDownloads().subscribe(res => {
          if (res['success']) {
            dialogRef.close();
            this.postsService.openSnackBar($localize`Successfully killed all downloads!`);
          } else {
            dialogRef.close();
            this.postsService.openSnackBar($localize`Failed to kill all downloads! Check logs for details.`);
          }
        }, () => {
          dialogRef.close();
          this.postsService.openSnackBar($localize`Failed to kill all downloads! Check logs for details.`);
        });
      }
    });
  }

  deleteOrphanFiles(): void {
    const done = new EventEmitter<boolean>();
    const dialogRef = openConfirmDialog(this.dialog, {
      dialogTitle: 'Delete orphan videos',
      dialogText: 'Are you sure you want to delete all orphan videos? These are videos that exist in your download directories but are not tracked in the database. This cannot be undone.',
      submitText: 'Delete orphans',
      doneEmitter: done,
      warnSubmitColor: true
    });
    done.subscribe(confirmed => {
      if (confirmed) {
        this.postsService.deleteOrphanFiles().subscribe(res => {
          dialogRef.close();
          this.postsService.openSnackBar($localize`Deleted ${res.deleted_count} orphan(s)${res.failed_count ? ', ' + res.failed_count + ' failed' : ''}.`);
        }, () => {
          dialogRef.close();
          this.postsService.openSnackBar($localize`Failed to delete orphan videos! Check logs for details.`);
        });
      }
    });
  }

  restartServer(): void {
    this.postsService.restartServer().subscribe(() => {
      this.postsService.openSnackBar($localize`Restarting!`);
    }, () => {
      this.postsService.openSnackBar($localize`Failed to restart the server.`);
    });
  }

  getDBInfo(): void {
    this.postsService.getDBInfo().subscribe(res => {
      this.db_info = res;
    });
  }

  transferDB(): void {
    const dialogRef = openConfirmDialog(this.dialog, {
      dialogTitle: 'Transfer DB',
      dialogText: `Are you sure you want to transfer the DB?`,
      submitText: 'Transfer',
    });
    dialogRef.afterClosed().subscribe(confirmed => {
      if (confirmed) {
        this._transferDB();
      }
    });
  }

  _transferDB(): void {
    this.db_transferring = true;
    this.postsService.transferDB(this.db_info['using_local_db']).subscribe(res => {
      this.db_transferring = false;
      const success = res['success'];
      if (success) {
        this.postsService.openSnackBar($localize`Successfully transfered DB! Reloading info...`);
        this.getDBInfo();
      } else {
        this.postsService.openSnackBar($localize`Failed to transfer DB -- transfer was aborted. Error: ` + res['error']);
      }
    }, err => {
      this.db_transferring = false;
      this.postsService.openSnackBar($localize`Failed to transfer DB -- API call failed. See browser logs for details.`);
      console.error(err);
    });
  }

  testConnectionString(connection_string: string): void {
    this.testing_connection_string = true;
    this.postsService.testConnectionString(connection_string).subscribe(res => {
      this.testing_connection_string = false;
      if (res['success']) {
        this.postsService.openSnackBar($localize`Connection successful!`);
      } else {
        this.postsService.openSnackBar($localize`Connection failed! Error: ` + res['error']);
      }
    }, () => {
      this.testing_connection_string = false;
      this.postsService.openSnackBar($localize`Connection failed! Error: Server error. See logs for more info.`);
    });
  }

  runCookiesTest(): void {
    const testUrl = this.cookiesTestUrl ? this.cookiesTestUrl.trim() : '';
    if (!testUrl) {
      this.postsService.openSnackBar($localize`Please provide a URL to test.`);
      return;
    }

    this.testingCookies = true;
    this.cookiesTestComplete = false;
    this.cookiesTestSuccess = null;
    this.cookiesTestLogs = [$localize`Running cookies test...`];

    this.postsService.testCookies(testUrl).subscribe((res: CookiesTestResponse) => {
      this.testingCookies = false;
      this.cookiesTestComplete = true;
      this.cookiesTestSuccess = !!res['success'];
      this.cookiesTestLogs = Array.isArray(res['logs']) ? res['logs'] : [];

      if (this.cookiesTestSuccess) {
        this.postsService.openSnackBar($localize`Cookies test passed.`);
      } else {
        this.postsService.openSnackBar($localize`Cookies test failed. Review logs below.`);
      }
    }, err => {
      this.testingCookies = false;
      this.cookiesTestComplete = true;
      this.cookiesTestSuccess = false;
      const error = err && err.error ? err.error : null;
      const errorLogs = error && Array.isArray(error['logs']) ? error['logs'] : null;
      this.cookiesTestLogs = errorLogs && errorLogs.length > 0 ? errorLogs : [$localize`Cookies test failed due to a server error.`];
      this.postsService.openSnackBar($localize`Cookies test failed. Review logs below.`);
    });
  }

  openGenerateRSSURLDialog(): void {
    this.dialog.open(GenerateRssUrlComponent, {
      panelClass: 'kit-dialog-panel',
      width: '640px',
      maxWidth: 'calc(100vw - 32px)',
      maxHeight: 'calc(100dvh - 32px)',
      autoFocus: 'dialog'
    });
  }
}
