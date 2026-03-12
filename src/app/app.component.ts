import { Component, OnInit, ElementRef, ViewChild, HostBinding, AfterViewInit, OnDestroy } from '@angular/core';
import {MatDialogRef} from '@angular/material/dialog';
import {PostsService} from './posts.services';
import { MatDialog } from '@angular/material/dialog';
import { MatSidenav } from '@angular/material/sidenav';
import { MatMenuTrigger } from '@angular/material/menu';
import { MatSnackBar } from '@angular/material/snack-bar';
import { saveAs } from 'file-saver';
import { Router, NavigationStart, NavigationEnd } from '@angular/router';
import { OverlayContainer } from '@angular/cdk/overlay';
import { THEMES_CONFIG } from '../themes';
import { SettingsComponent } from './settings/settings.component';
import { AboutDialogComponent } from './dialogs/about-dialog/about-dialog.component';
import { UserProfileDialogComponent } from './dialogs/user-profile-dialog/user-profile-dialog.component';
import { SetDefaultAdminDialogComponent } from './dialogs/set-default-admin-dialog/set-default-admin-dialog.component';
import { NotificationsComponent } from './components/notifications/notifications.component';
import { ArchiveViewerComponent } from './components/archive-viewer/archive-viewer.component';
import { PlaylistDownloadProgressDialogComponent } from './dialogs/playlist-download-progress-dialog/playlist-download-progress-dialog.component';
import { Download } from 'api-types';
import { filter, take } from 'rxjs/operators';

@Component({
    selector: 'app-root',
    templateUrl: './app.component.html',
    styleUrls: ['./app.component.css'],
    providers: [{
            provide: MatDialogRef,
            useValue: {}
        }],
    standalone: false
})
export class AppComponent implements OnInit, AfterViewInit, OnDestroy {

  @HostBinding('class') componentCssClass;
  THEMES_CONFIG = THEMES_CONFIG;

  window = window;

  // config items
  topBarTitle = 'Youtube Downloader';
  defaultTheme = null;
  allowThemeChange = null;
  allowSubscriptions = false;
  enableDownloadsManager = false;

  @ViewChild('sidenav') sidenav: MatSidenav;
  @ViewChild('notifications') notifications: NotificationsComponent;
  @ViewChild('activeDownloadsTrigger') activeDownloadsTrigger: MatMenuTrigger;
  @ViewChild('hamburgerMenu', { read: ElementRef }) hamburgerMenuButton: ElementRef;
  navigator: string = null;

  notification_count = 0;
  active_downloads: Download[] = [];
  active_download_count = 0;
  show_completion_badge = false;
  readonly ACTIVE_DOWNLOAD_STEP_LABELS: {[key: number]: string} = {
    0: $localize`Creating download`,
    1: $localize`Getting info`,
    2: $localize`Downloading file`,
    3: $localize`Complete`
  };

  private readonly ACTIVE_DOWNLOADS_POLL_INTERVAL_MS = 1000;
  private readonly ACTIVE_DOWNLOADS_AUTO_CLOSE_MS = 5000;
  private readonly ACTIVE_DOWNLOADS_COMPLETION_BADGE_MS = 2500;
  private active_downloads_poll_interval_id: number = null;
  private active_downloads_auto_close_timeout_id: number = null;
  private active_downloads_completion_badge_timeout_id: number = null;
  private active_download_uids = new Set<string>();
  private previous_download_states = new Map<string, {finished: boolean, errored: boolean}>();
  private active_downloads_initialized = false;
  private active_downloads_auto_opened = false;
  private active_downloads_opened_manually = false;
  private playlist_progress_dialog_ref: MatDialogRef<PlaylistDownloadProgressDialogComponent> = null;
  private playlist_progress_dialog_key: string = null;

  constructor(public postsService: PostsService, public snackBar: MatSnackBar, private dialog: MatDialog,
    public router: Router, public overlayContainer: OverlayContainer, private elementRef: ElementRef,
  ) {

    this.navigator = localStorage.getItem('player_navigator');
    // runs on navigate, captures the route that navigated to the player (if needed)
    this.router.events.subscribe((e) => { if (e instanceof NavigationStart) {
      this.navigator = localStorage.getItem('player_navigator');
    } else if (e instanceof NavigationEnd) {
      // blurs hamburger menu if it exists, as the sidenav likes to focus on it after closing
      if (this.hamburgerMenuButton && this.hamburgerMenuButton.nativeElement) {
        this.hamburgerMenuButton.nativeElement.blur();
      }
    }
    });

    this.postsService.config_reloaded.subscribe(changed => {
      if (changed) {
        this.loadConfig();
      }
    });

  }
  ngOnInit(): void {
    const storedTheme = this.getStoredTheme();
    if (storedTheme) {
      this.setTheme(storedTheme);
    }
    
    this.postsService.open_create_default_admin_dialog.subscribe(open => {
      if (open) {
        const dialogRef = this.dialog.open(SetDefaultAdminDialogComponent);
        dialogRef.afterClosed().subscribe(res => {
          if (!res || !res['user']) {
            if (this.router.url !== '/login') { this.router.navigate(['/login']); }
          } else {
            console.error('Failed to create default admin account. See logs for details.');
          }
        });
      }
    });

    if (this.postsService.initialized) {
      this.startActiveDownloadsPolling();
    } else {
      this.postsService.service_initialized
        .pipe(filter(Boolean), take(1))
        .subscribe(() => this.startActiveDownloadsPolling());
    }
  }

  ngAfterViewInit(): void {
    this.postsService.sidenav = this.sidenav;
  }

  ngOnDestroy(): void {
    if (this.active_downloads_poll_interval_id) {
      clearInterval(this.active_downloads_poll_interval_id);
      this.active_downloads_poll_interval_id = null;
    }
    this.clearActiveDownloadsAutoCloseTimer();
    this.clearCompletionBadgeTimer();
    if (this.playlist_progress_dialog_ref) {
      this.playlist_progress_dialog_ref.close();
    }
  }

  toggleSidenav(): void {
    this.sidenav.toggle();
  }

  loadConfig(): void {
    // loading config
    this.topBarTitle = this.postsService.config['Extra']['title_top'];
    const themingExists = this.postsService.config['Themes'];
    this.defaultTheme = themingExists ? this.postsService.config['Themes']['default_theme'] : 'default';
    this.allowThemeChange = themingExists ? this.postsService.config['Themes']['allow_theme_change'] : true;
    this.allowSubscriptions = this.postsService.config['Subscriptions']['allow_subscriptions'];
    this.enableDownloadsManager = this.postsService.config['Extra']['enable_downloads_manager'];

    // sets theme to config default if it doesn't exist
    const storedTheme = this.getStoredTheme();
    if (!storedTheme) {
      this.setTheme(themingExists ? this.defaultTheme : 'default');
    } else {
      this.setTheme(storedTheme);
    }

    // gets the subscriptions
    if (this.allowSubscriptions) {
      this.postsService.reloadSubscriptions();
    }

    this.postsService.reloadCategories();

    this.postsService.getVersionInfo().subscribe(res => {
      this.postsService.version_info = res['version_info'];
    });
  }

  // theme stuff

  getThemeStorageKey(): string {
    if (this.postsService.config && this.postsService.config['Advanced'] && this.postsService.config['Advanced']['multi_user_mode'] && this.postsService.user && this.postsService.user.uid) {
      return `theme_${this.postsService.user.uid}`;
    }
    return 'theme';
  }

  getStoredTheme(): string {
    return localStorage.getItem(this.getThemeStorageKey()) || localStorage.getItem('theme');
  }

  setStoredTheme(theme: string): void {
    const key = this.getThemeStorageKey();
    localStorage.setItem(key, theme);
    if (key !== 'theme') {
      localStorage.removeItem('theme');
    }
  }

  setTheme(theme) {
    // theme is registered, so set it to the stored cookie variable
    let old_theme = null;
    if (this.THEMES_CONFIG[theme]) {
        const currentTheme = this.getStoredTheme();
        if (currentTheme) {
          old_theme = currentTheme;
          if (!this.THEMES_CONFIG[old_theme]) {
            console.log('bad theme found, setting to default');
            if (this.defaultTheme === null) {
              // means it hasn't loaded yet
              console.error('No default theme detected');
            } else {
              this.setStoredTheme(this.defaultTheme);
              old_theme = this.getStoredTheme(); // updates old_theme
            }
          }
        }
        this.setStoredTheme(theme);
        this.elementRef.nativeElement.ownerDocument.body.style.backgroundColor = this.THEMES_CONFIG[theme]['background_color'];
    } else {
        console.error('Invalid theme: ' + theme);
        return;
    }

    this.postsService.setTheme(theme);

    this.onSetTheme(this.THEMES_CONFIG[theme]['css_label'], old_theme ? this.THEMES_CONFIG[old_theme]['css_label'] : old_theme);
  }

  onSetTheme(theme, old_theme) {
    if (old_theme) {
      document.body.classList.remove(old_theme);
      this.overlayContainer.getContainerElement().classList.remove(old_theme);
    }
    this.overlayContainer.getContainerElement().classList.add(theme);
    this.componentCssClass = theme;
  }

  flipTheme(): void {
    if (this.postsService.theme.key === 'default') {
      this.setTheme('dark');
    } else if (this.postsService.theme.key === 'dark') {
      this.setTheme('default');
    }
  }

  themeMenuItemClicked(event): void {
    this.flipTheme();
    event.stopPropagation();
  }

  goBack(): void {
    if (!this.navigator) {
      this.router.navigate(['/home']);
    } else {
      this.router.navigateByUrl(this.navigator);
    }
  }

  openSettingsDialog(): void {
    this.dialog.open(SettingsComponent, {
      width: '80vw'
    });
  }

  openAboutDialog(): void {
    this.dialog.open(AboutDialogComponent, {
      width: '80vw'
    });
  }

  openProfileDialog(): void {
    this.dialog.open(UserProfileDialogComponent, {
      width: '60vw'
    });
  }

  openArchivesDialog(): void {
    this.dialog.open(ArchiveViewerComponent, {
      width: '85vw'
    });
  }

  notificationCountUpdate(new_count: number): void {
    this.notification_count = new_count;
  }

  notificationMenuOpened(): void {
    this.notifications.getNotifications();
  }

  notificationMenuClosed(): void {
    this.notifications.setNotificationsToRead();
  }

  activeDownloadsMenuButtonClicked(): void {
    this.active_downloads_opened_manually = true;
    this.active_downloads_auto_opened = false;
    this.clearActiveDownloadsAutoCloseTimer();
  }

  activeDownloadsMenuOpened(): void {
    if (this.active_downloads_opened_manually) {
      this.active_downloads_auto_opened = false;
      this.clearActiveDownloadsAutoCloseTimer();
    }
  }

  activeDownloadsMenuClosed(): void {
    this.active_downloads_opened_manually = false;
    this.active_downloads_auto_opened = false;
    this.clearActiveDownloadsAutoCloseTimer();
  }

  pauseActiveDownload(download: Download, event: MouseEvent): void {
    event.stopPropagation();
    if (!download || !download.uid) return;

    this.postsService.pauseDownload(download.uid).subscribe(res => {
      if (!res || !res['success']) {
        this.postsService.openSnackBar($localize`Failed to pause download! See server logs for more info.`);
      }
    }, () => {
      this.postsService.openSnackBar($localize`Failed to pause download! See server logs for more info.`);
    });
  }

  cancelActiveDownload(download: Download, event: MouseEvent): void {
    event.stopPropagation();
    if (!download || !download.uid) return;

    this.postsService.cancelDownload(download.uid).subscribe(res => {
      if (!res || !res['success']) {
        this.postsService.openSnackBar($localize`Failed to cancel download! See server logs for more info.`);
      }
    }, () => {
      this.postsService.openSnackBar($localize`Failed to cancel download! See server logs for more info.`);
    });
  }

  canOpenDownloadsPage(): boolean {
    return this.enableDownloadsManager && this.postsService.hasPermission('downloads_manager');
  }

  shouldShowActiveDownloadsIndicator(): boolean {
    return this.active_download_count > 0 || this.show_completion_badge;
  }

  getActiveDownloadsIndicatorIcon(): string {
    return this.show_completion_badge && this.active_download_count === 0 ? 'download_done' : 'download';
  }

  getActiveDownloadsBadgeValue(): string | number {
    return this.show_completion_badge && this.active_download_count === 0 ? '✓' : this.active_download_count;
  }

  getActiveDownloadsBadgeColor(): 'warn' | 'accent' {
    return this.show_completion_badge && this.active_download_count === 0 ? 'accent' : 'warn';
  }

  hasPlaylistItemProgress(download: Download): boolean {
    const playlist_item_progress = (download as DownloadWithPlaylistProgress)?.playlist_item_progress;
    return Array.isArray(playlist_item_progress) && playlist_item_progress.length > 1;
  }

  openPlaylistProgress(download: Download, event: MouseEvent): void {
    event.stopPropagation();
    if (!this.hasPlaylistItemProgress(download)) return;

    if (this.playlist_progress_dialog_ref && this.dialog.openDialogs.includes(this.playlist_progress_dialog_ref)) {
      this.playlist_progress_dialog_ref.close();
    }

    const dialog_ref = this.dialog.open(PlaylistDownloadProgressDialogComponent, {
      width: '720px',
      maxWidth: '95vw',
      data: {download: download as DownloadWithPlaylistProgress}
    });
    this.playlist_progress_dialog_ref = dialog_ref;
    this.playlist_progress_dialog_key = this.getPlaylistProgressDialogKey(download);

    dialog_ref.afterClosed().pipe(take(1)).subscribe(() => {
      if (this.playlist_progress_dialog_ref === dialog_ref) {
        this.playlist_progress_dialog_ref = null;
        this.playlist_progress_dialog_key = null;
      }
    });
  }

  shouldShowActiveDownloadPercent(download: Download): boolean {
    if (!download || download.error || download.finished || download.paused) return false;
    return this.parseNumericPercent(download.percent_complete) !== null;
  }

  getActiveDownloadPercent(download: Download): string | null {
    const numeric_percent = this.parseNumericPercent(download ? download.percent_complete : null);
    if (numeric_percent === null) return null;
    return Math.max(0, Math.min(100, numeric_percent)).toFixed(2);
  }

  getActiveDownloadProgressValue(download: Download): number | null {
    const numeric_percent = this.parseNumericPercent(download ? download.percent_complete : null);
    if (numeric_percent === null) return null;
    return Math.max(0, Math.min(100, numeric_percent));
  }

  getActiveDownloadStepLabel(download: Download): string {
    const step_index = Number(download && download.step_index);
    return this.ACTIVE_DOWNLOAD_STEP_LABELS[step_index] || $localize`Downloading file`;
  }

  private startActiveDownloadsPolling(): void {
    if (this.active_downloads_poll_interval_id) {
      clearInterval(this.active_downloads_poll_interval_id);
      this.active_downloads_poll_interval_id = null;
    }

    this.refreshActiveDownloads();
    this.active_downloads_poll_interval_id = window.setInterval(() => {
      this.refreshActiveDownloads();
    }, this.ACTIVE_DOWNLOADS_POLL_INTERVAL_MS);
  }

  private refreshActiveDownloads(): void {
    const multi_user_mode_enabled = !!this.postsService.config?.Advanced?.multi_user_mode;
    if (multi_user_mode_enabled && !this.postsService.isLoggedIn) {
      this.previous_download_states.clear();
      this.setActiveDownloads([], false);
      return;
    }

    this.postsService.getCurrentDownloads().subscribe(res => {
      const downloads = Array.isArray(res && res['downloads']) ? res['downloads'] : [];
      const successful_completion_detected = this.detectSuccessfulCompletion(downloads);
      const active_downloads = downloads
        .filter(download => this.isActiveDownload(download))
        .sort((download1, download2) => Number(download2.timestamp_start) - Number(download1.timestamp_start));

      this.setActiveDownloads(active_downloads, successful_completion_detected);
    }, () => {});
  }

  private setActiveDownloads(active_downloads: Download[], successful_completion_detected = false): void {
    const previous_count = this.active_download_count;
    const previous_uids = this.active_download_uids;
    const active_download_count_increased = this.active_downloads_initialized && active_downloads.length > previous_count;
    const has_new_active_download = this.active_downloads_initialized && active_downloads.some(download => !previous_uids.has(download.uid));

    this.active_downloads = active_downloads;
    this.active_download_count = active_downloads.length;
    this.active_download_uids = new Set(active_downloads.map(download => download.uid));
    this.refreshOpenPlaylistProgressDialog();

    if (this.active_download_count > 0) {
      this.show_completion_badge = false;
      this.clearCompletionBadgeTimer();
    }

    if (this.active_download_count === 0 && this.activeDownloadsTrigger?.menuOpen) {
      this.activeDownloadsTrigger.closeMenu();
    }

    if (this.active_download_count === 0 && previous_count > 0 && successful_completion_detected) {
      this.showCompletionBadgeTemporarily();
    }

    if (active_download_count_increased || has_new_active_download) {
      window.setTimeout(() => this.showActiveDownloadsMenuTemporarily(), 0);
    }

    this.active_downloads_initialized = true;
  }

  private isActiveDownload(download: Download): boolean {
    if (!download) return false;
    return !download.finished && !download.paused && !download.error && !download.cancelled;
  }

  private showActiveDownloadsMenuTemporarily(): void {
    if (!this.activeDownloadsTrigger) return;
    if (this.activeDownloadsTrigger.menuOpen && this.active_downloads_opened_manually) return;

    this.active_downloads_opened_manually = false;
    this.active_downloads_auto_opened = true;

    if (!this.activeDownloadsTrigger.menuOpen) {
      this.activeDownloadsTrigger.openMenu();
    }
    this.scheduleActiveDownloadsAutoClose();
  }

  private scheduleActiveDownloadsAutoClose(): void {
    this.clearActiveDownloadsAutoCloseTimer();
    this.active_downloads_auto_close_timeout_id = window.setTimeout(() => {
      if (!this.active_downloads_auto_opened) return;

      if (this.activeDownloadsTrigger?.menuOpen) {
        this.activeDownloadsTrigger.closeMenu();
      }
      this.active_downloads_auto_opened = false;
    }, this.ACTIVE_DOWNLOADS_AUTO_CLOSE_MS);
  }

  private clearActiveDownloadsAutoCloseTimer(): void {
    if (this.active_downloads_auto_close_timeout_id) {
      clearTimeout(this.active_downloads_auto_close_timeout_id);
      this.active_downloads_auto_close_timeout_id = null;
    }
  }

  private showCompletionBadgeTemporarily(): void {
    this.show_completion_badge = true;
    this.clearCompletionBadgeTimer();
    this.active_downloads_completion_badge_timeout_id = window.setTimeout(() => {
      this.show_completion_badge = false;
      this.active_downloads_completion_badge_timeout_id = null;
    }, this.ACTIVE_DOWNLOADS_COMPLETION_BADGE_MS);
  }

  private clearCompletionBadgeTimer(): void {
    if (this.active_downloads_completion_badge_timeout_id) {
      clearTimeout(this.active_downloads_completion_badge_timeout_id);
      this.active_downloads_completion_badge_timeout_id = null;
    }
  }

  private detectSuccessfulCompletion(downloads: Download[]): boolean {
    const current_download_states = new Map<string, {finished: boolean, errored: boolean}>();
    let successful_completion_detected = false;

    for (const download of downloads) {
      if (!download || !download.uid) continue;

      const finished = !!download.finished;
      const errored = !!download.error;
      const previous_state = this.previous_download_states.get(download.uid);
      if (this.active_downloads_initialized && finished && !errored && previous_state && !previous_state.finished) {
        successful_completion_detected = true;
      }

      current_download_states.set(download.uid, {finished: finished, errored: errored});
    }

    this.previous_download_states = current_download_states;
    return successful_completion_detected;
  }

  private refreshOpenPlaylistProgressDialog(): void {
    if (!this.playlist_progress_dialog_ref || !this.playlist_progress_dialog_key) return;
    if (!this.dialog.openDialogs.includes(this.playlist_progress_dialog_ref)) {
      this.playlist_progress_dialog_ref = null;
      this.playlist_progress_dialog_key = null;
      return;
    }

    const matching_download = this.active_downloads.find(download => this.getPlaylistProgressDialogKey(download) === this.playlist_progress_dialog_key);
    if (!matching_download) return;
    this.playlist_progress_dialog_ref.componentInstance.updateDownload(matching_download as DownloadWithPlaylistProgress);
  }

  private getPlaylistProgressDialogKey(download: Download): string | null {
    if (!download || !download.uid) return null;
    return download.uid;
  }

  private parseNumericPercent(value: unknown): number | null {
    if (value === null || value === undefined || value === '') return null;
    const numeric_value = Number(value);
    if (!Number.isFinite(numeric_value)) return null;
    return numeric_value;
  }

}

interface PlaylistDownloadProgressItem {
  index: number,
  id?: string | null,
  title: string,
  expected_file_size: number,
  downloaded_size: number,
  percent_complete: number,
  status: string,
  progress_path_index?: number
}

interface DownloadWithPlaylistProgress extends Download {
  playlist_item_progress?: PlaylistDownloadProgressItem[] | null
}
