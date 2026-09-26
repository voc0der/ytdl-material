import { Component, OnDestroy, OnInit, ChangeDetectionStrategy } from '@angular/core';
import { PostsService } from 'app/posts.services';
import { ActivatedRoute, Router } from '@angular/router';
import { MatDialog } from '@angular/material/dialog';
import { openConfirmDialog } from 'app/dialogs/confirm-dialog/confirm-dialog.component';
import { Subscription, SubscriptionRefreshStatus } from 'api-types';
import { saveBlob } from '../../utils/save-blob';
import { firstValueFrom, Subscription as RxSubscription } from 'rxjs';
import { filter, finalize, take } from 'rxjs/operators';
import { MatButton } from '@angular/material/button';
import { MatIcon } from '@angular/material/icon';
import { MatTooltip } from '@angular/material/tooltip';
import { MatCard } from '@angular/material/card';
import { MatProgressBar } from '@angular/material/progress-bar';
import { MatChipSet, MatChip } from '@angular/material/chips';
import { MatMenu, MatMenuItem, MatMenuTrigger } from '@angular/material/menu';
import { MatDivider } from '@angular/material/divider';
import { MediaLibraryComponent } from '../../components/media-library/media-library.component';
import { MatProgressSpinner } from '@angular/material/progress-spinner';
import { SubscriptionSettingsComponent } from '../../components/subscription-settings/subscription-settings.component';
import {
  SubscriptionSettings, changedSubscriptionFields, formatRelativeTime, isSubscriptionChecking, lastCheckedAt, settingsFromSubscription,
  subscriptionState
} from '../../components/subscription-settings/subscription-settings';
import { SubscriptionActionsService } from '../../subscriptions/subscription-actions.service';

@Component({
    selector: 'app-subscription',
    templateUrl: './subscription.component.html',
    styleUrls: ['./subscription.component.scss'],
    changeDetection: ChangeDetectionStrategy.Eager,
    imports: [MatIcon, MatTooltip, MatDivider, MatCard, MatButton, MatProgressBar, MatChipSet, MatChip, MatMenu, MatMenuItem, MatMenuTrigger,
      MediaLibraryComponent, MatProgressSpinner, SubscriptionSettingsComponent]
})
export class SubscriptionComponent implements OnInit, OnDestroy {

  private readonly active_poll_interval_ms = 1000;
  private readonly idle_poll_interval_ms = 10000;
  id = null;
  subscription: Subscription = null;
  use_youtubedl_archive = false;
  descendingMode = true;
  downloading = false;
  archiveDownloadSubscription: RxSubscription | null = null;
  sub_interval = null;
  check_clicked = false;
  cancel_clicked = false;

  // The settings panel edits a copy, so Cancel leaves the subscription as it was.
  settingsOpen = false;
  refreshDetailsOpen = false;
  settingsDraft: SubscriptionSettings | null = null;
  private settingsSaved: SubscriptionSettings | null = null;
  savingSettings = false;
  private openSettingsOnLoad = false;

  readonly backLabel = $localize`Back to subscriptions`;
  readonly moreActionsLabel = $localize`More actions`;
  private active_subscription_request: {id: string | null; token: number} | null = null;
  private subscription_request_sequence = 0;
  private last_subscription_request_at = 0;

  constructor(private postsService: PostsService, private route: ActivatedRoute, private router: Router, private dialog: MatDialog,
              private actions: SubscriptionActionsService) { }

  ngOnInit() {
    this.route.params.subscribe(params => {
      const next_id = params['id'];
      if (next_id !== this.id) {
        this.subscription = null;
        this.last_subscription_request_at = 0;
        this.closeSettings();
      }
      this.id = next_id;
      // Asked for from a subscription's card: open once the subscription is here to edit.
      this.openSettingsOnLoad = params['settings'] === 'true';

      if (this.sub_interval) { clearInterval(this.sub_interval); }

      this.postsService.service_initialized
        .pipe(filter(Boolean), take(1))
        .subscribe(() => {
          this.getConfig();
          this.getSubscription();
          this.sub_interval = setInterval(() => this.pollSubscription(), this.active_poll_interval_ms);
        });
    });
  }

  ngOnDestroy() {
    this.archiveDownloadSubscription?.unsubscribe();
    this.archiveDownloadSubscription = null;

    // prevents subscription getter from running in the background
    if (this.sub_interval) {
      clearInterval(this.sub_interval);
    }
  }

  goBack() {
    this.router.navigate(['/subscriptions']);
  }

  getSubscription(low_cost = false) {
    const requested_id = this.id as string | null;
    if (this.active_subscription_request?.id === requested_id) return;

    const request_token = ++this.subscription_request_sequence;
    this.active_subscription_request = {id: requested_id, token: request_token};
    this.last_subscription_request_at = Date.now();
    this.postsService.getSubscription(requested_id, null, false)
      .pipe(finalize(() => {
        if (this.active_subscription_request?.token === request_token) {
          this.active_subscription_request = null;
        }
      }))
      .subscribe(res => {
      if (requested_id !== this.id || this.active_subscription_request?.token !== request_token) return;
      const next_subscription = res['subscription'] as Subscription;
      const current_video_count = this.getSubscriptionFileCount(this.subscription);
      const next_video_count = this.getSubscriptionFileCount(next_subscription);

      if (low_cost && this.subscription && next_video_count === current_video_count) {
        this.subscription = {
          ...this.subscription,
          ...next_subscription,
          videos: this.subscription.videos
        };
        return;
      } else if (this.subscription && next_video_count > current_video_count) {
        // only when files are added so we don't reload files when one is deleted
        this.postsService.files_changed.next(true);
      }
      this.subscription = next_subscription;
      if (this.openSettingsOnLoad) {
        this.openSettingsOnLoad = false;
        this.openSettings();
      }
    }, err => console.error(err));
  }

  private pollSubscription(): void {
    const refresh_status = this.getRefreshStatus();
    const poll_interval = !this.subscription
      || this.hasActiveRefresh()
      || (refresh_status?.pending_download_count ?? 0) > 0
      || (refresh_status?.running_download_count ?? 0) > 0
      ? this.active_poll_interval_ms
      : this.idle_poll_interval_ms;

    if ((Date.now() - this.last_subscription_request_at) < poll_interval) return;
    this.getSubscription(true);
  }

  private getSubscriptionFileCount(subscription: Subscription | null): number {
    const file_count = Number((subscription as any)?.file_count);
    if (Number.isFinite(file_count)) return Math.max(0, Math.floor(file_count));
    return subscription?.videos?.length || 0;
  }

  getConfig(): void {
    this.use_youtubedl_archive = this.postsService.config['Downloader']['use_youtubedl_archive'];
  }

  downloadContent(): void {
    if (this.downloading) return;

    const file_count = this.getSubscriptionFileCount(this.subscription);
    const dialogRef = openConfirmDialog(this.dialog, {
      dialogTitle: $localize`Download subscription?`,
      dialogText: $localize`Download all ${file_count}:subscription file count: files from ${this.subscription.name}:subscription name: as a zip? Creating the archive can take a while and use significant disk space.`,
      submitText: $localize`Download`
    });

    dialogRef.afterClosed().pipe(take(1)).subscribe(confirmed => {
      if (confirmed) this.startSubscriptionDownload();
    });
  }

  startSubscriptionDownload(): void {
    const zip_name = this.subscription.name;
    this.downloading = true;
    this.archiveDownloadSubscription = this.postsService.downloadSubFromServer(this.subscription.id).subscribe(res => {
      this.downloading = false;
      this.archiveDownloadSubscription = null;
      const blob: Blob = res;
      saveBlob(blob, zip_name + '.zip');
    }, err => {
      console.error(err);
      this.downloading = false;
      this.archiveDownloadSubscription = null;
    });
  }

  cancelSubscriptionDownload(): void {
    if (!this.downloading) return;

    this.archiveDownloadSubscription?.unsubscribe();
    this.archiveDownloadSubscription = null;
    this.downloading = false;
    this.postsService.openSnackBar($localize`Subscription download cancelled.`);
  }

  get fileCount(): number {
    return this.getSubscriptionFileCount(this.subscription);
  }

  // The page stands for the channel or playlist itself, so its own image comes first.
  get coverURL(): string | null {
    return this.actions.artworkURL(this.subscription) || this.actions.coverURL(this.subscription);
  }

  // A channel's avatar is shown round, as the channel shows it; anything else fills the frame.
  get coverIsAvatar(): boolean {
    return !!this.subscription && !this.subscription.isPlaylist && !!this.actions.artworkURL(this.subscription);
  }

  get initial(): string {
    return (this.subscription?.name || '?').trim().charAt(0).toUpperCase();
  }

  get isChecking(): boolean {
    return !!this.subscription && isSubscriptionChecking(this.subscription);
  }

  // Files are moved when their folder changes, which must not happen under a running download.
  get canSaveSettings(): boolean {
    return !!this.settingsDraft && !this.savingSettings && !this.subscription?.downloading && this.settingsChanged;
  }

  get settingsChanged(): boolean {
    return !!this.settingsDraft && Object.keys(changedSubscriptionFields(this.settingsSaved, this.settingsDraft)).length > 0;
  }

  statusText(): string {
    const sub = this.subscription;
    if (!sub) return '';
    switch (subscriptionState(sub)) {
    case 'paused':
      return $localize`Paused`;
    case 'checking':
      return $localize`Checking for new uploads`;
    case 'downloading':
      return $localize`Downloading ${sub.refresh_status?.pending_download_count ?? 0}:download count: new`;
    case 'failed':
      return $localize`Last check didn't finish`;
    default: {
      const checked_at = lastCheckedAt(sub);
      return checked_at
        ? $localize`Checked ${formatRelativeTime(checked_at)}:relative time:`
        : $localize`Not checked yet`;
    }
    }
  }

  toggleSettings(): void {
    if (this.settingsOpen) {
      this.closeSettings();
    } else {
      this.openSettings();
    }
  }

  openSettings(): void {
    if (!this.subscription) return;
    this.settingsSaved = settingsFromSubscription(this.subscription);
    this.settingsDraft = settingsFromSubscription(this.subscription);
    this.settingsOpen = true;
  }

  closeSettings(): void {
    this.settingsOpen = false;
    this.settingsDraft = null;
    this.settingsSaved = null;
  }

  async saveSettings(): Promise<void> {
    if (!this.canSaveSettings) return;

    const changes = changedSubscriptionFields(this.settingsSaved, this.settingsDraft);
    this.savingSettings = true;
    try {
      const res = await firstValueFrom(this.postsService.updateSubscription({ id: this.subscription.id, ...changes }));
      if (!res?.success) {
        this.postsService.openSnackBar($localize`Couldn't save the settings. Nothing was changed.`);
        return;
      }
    } catch (err) {
      console.error(err);
      this.postsService.openSnackBar($localize`Couldn't save the settings. Nothing was changed.`);
      return;
    } finally {
      this.savingSettings = false;
    }

    this.subscription = { ...this.subscription, ...changes };
    this.closeSettings();
    this.postsService.openSnackBar($localize`Settings saved.`);
    this.postsService.reloadSubscriptions();
    this.last_subscription_request_at = 0;
    this.getSubscription(true);
  }

  async setPaused(paused: boolean): Promise<void> {
    if (await this.actions.setPaused(this.subscription, paused)) {
      this.subscription = { ...this.subscription, paused };
      this.last_subscription_request_at = 0;
      this.getSubscription(true);
    }
  }

  async redownloadSubscription(): Promise<void> {
    if (await this.actions.redownload(this.subscription)) {
      this.last_subscription_request_at = 0;
      this.getSubscription();
    }
  }

  async exportArchive(): Promise<void> {
    await this.actions.exportArchive(this.subscription);
  }

  async unsubscribe(): Promise<void> {
    const sub = { ...this.subscription, file_count: this.fileCount };
    if (await this.actions.unsubscribe(sub)) {
      this.goBack();
    }
  }

  watchSubscription(): void {
    this.router.navigate(['/player', {sub_id: this.subscription.id}])
  }

  checkSubscription(): void {
    this.check_clicked = true;
    this.postsService.checkSubscription(this.subscription.id).subscribe(res => {
      this.check_clicked = false;
      if (!res['success']) {
        this.postsService.openSnackBar('Failed to check subscription!');
        return;
      }
      this.last_subscription_request_at = 0;
      this.getSubscription(true);
    }, err => {
      console.error(err);
      this.check_clicked = false;
      this.postsService.openSnackBar('Failed to check subscription!');
    });
  }

  cancelCheckSubscription(): void {
    this.cancel_clicked = true;
    this.postsService.cancelCheckSubscription(this.subscription.id).subscribe(res => {
      this.cancel_clicked = false;
      if (!res['success']) {
        this.postsService.openSnackBar('Failed to cancel check subscription!');
        return;
      }
      this.last_subscription_request_at = 0;
      this.getSubscription(true);
    }, err => {
      console.error(err);
      this.cancel_clicked = false;
      this.postsService.openSnackBar('Failed to cancel check subscription!');
    });
  }

  getRefreshStatus(): SubscriptionRefreshStatus | null {
    return this.subscription?.refresh_status || null;
  }

  // A refresh that finished with nothing to report is summed up in the header instead
  // ("Checked 5 minutes ago"), so the card is kept for one under way or one worth a look.
  shouldShowRefreshStatus(): boolean {
    const refresh_status = this.getRefreshStatus();
    return !!(refresh_status && (
      refresh_status.active
      || refresh_status.phase === 'collecting'
      || refresh_status.phase === 'queueing'
      || refresh_status.phase === 'error'
      || refresh_status.phase === 'cancelled'
      || refresh_status.pending_download_count > 0
      || refresh_status.running_download_count > 0
      || refresh_status.skipped_count > 0
    ));
  }

  hasActiveRefresh(): boolean {
    const refresh_status = this.getRefreshStatus();
    return !!(this.subscription?.downloading || refresh_status?.active);
  }

  getRefreshHeadline(): string {
    const refresh_status = this.getRefreshStatus();
    if (this.hasSkippedDownloads(refresh_status) && !this.hasUnfinishedDownloads(refresh_status)) {
      return this.getQueuedAfterSkippedCount(refresh_status) > 0
        ? $localize`Refresh completed with skips`
        : $localize`Downloads skipped`;
    }

    const is_playlist = !!this.subscription?.isPlaylist;
    switch (refresh_status?.phase) {
    case 'collecting':
      return is_playlist ? $localize`Checking playlist metadata` : $localize`Checking channel metadata`;
    case 'queueing':
      return $localize`Queueing new downloads`;
    case 'queued':
      return refresh_status.pending_download_count > 0
        ? $localize`Downloads queued`
        : $localize`Downloads were queued`;
    case 'complete':
      return is_playlist ? $localize`Playlist is up to date` : $localize`Channel is up to date`;
    case 'cancelled':
      return $localize`Refresh cancelled`;
    case 'error':
      return $localize`Check didn't finish`;
    default:
      if (this.subscription?.downloading) {
        return is_playlist ? $localize`Checking playlist metadata` : $localize`Checking channel metadata`;
      }
      return is_playlist ? $localize`Playlist refresh` : $localize`Channel refresh`;
    }
  }

  getRefreshDescription(): string {
    const refresh_status = this.getRefreshStatus();
    const latest_item_title = refresh_status?.latest_item_title ? ` "${refresh_status.latest_item_title}"` : '';
    if (this.hasSkippedDownloads(refresh_status) && !this.hasUnfinishedDownloads(refresh_status) && !refresh_status?.active) {
      return this.getSkippedRefreshDescription(refresh_status);
    }

    switch (refresh_status?.phase) {
    case 'collecting':
      return (this.subscription?.isPlaylist
        ? $localize`The app is scanning this playlist before it creates download jobs. Files will appear here after queued downloads finish.`
        : $localize`The app is scanning this channel before it creates download jobs. Files will appear here after queued downloads finish.`) + latest_item_title;
    case 'queueing':
      return refresh_status?.new_items_count > 0
        ? $localize`Found ${refresh_status.new_items_count}:new item count: new item(s). The app is creating download jobs now.`
        : $localize`The metadata scan finished. The app is preparing download jobs now.`;
    case 'queued':
      if (refresh_status?.pending_download_count > 0) {
        if (this.hasSkippedDownloads(refresh_status)) {
          return $localize`Download jobs are queued, and ${this.getSkippedCount(refresh_status)}:skipped count: were skipped because they are unavailable or members-only. New files will appear here as each download completes.`;
        }
        return $localize`Download jobs are queued. New files will appear here as each download completes.`;
      }
      if (this.hasSkippedDownloads(refresh_status)) {
        return this.getSkippedRefreshDescription(refresh_status);
      }
      return $localize`The refresh queued download jobs successfully.`;
    case 'complete':
      if (this.hasSkippedDownloads(refresh_status)) {
        return this.getSkippedRefreshDescription(refresh_status);
      }
      return refresh_status?.new_items_count > 0
        ? $localize`The refresh finished successfully.`
        : $localize`The last refresh did not find any new videos to download.`;
    case 'cancelled':
      return $localize`The refresh was stopped before it finished collecting metadata or queueing all downloads.`;
    case 'error':
      // Most often the site or the network for a moment. Nothing is lost: the next check
      // looks at everything again.
      return $localize`The check stopped before it finished, so nothing new was queued. The next check starts over.`;
    default:
      return $localize`The subscription page will show completed files only.`;
    }
  }

  shouldShowRefreshProgressBar(): boolean {
    const phase = this.getRefreshStatus()?.phase;
    return phase === 'collecting' || phase === 'queueing';
  }

  // Collecting has no honest fraction to show: yt-dlp reports only the uploads it keeps, and
  // says nothing of the ones it passes over as already downloaded or outside a date filter.
  getRefreshProgressMode(): 'determinate' | 'indeterminate' {
    const refresh_status = this.getRefreshStatus();
    if (!refresh_status) return 'indeterminate';

    if (refresh_status.phase === 'queueing' && refresh_status.new_items_count > 0) {
      return 'determinate';
    }

    return 'indeterminate';
  }

  getRefreshProgressValue(): number {
    const refresh_status = this.getRefreshStatus();
    if (!refresh_status) return 0;

    if (refresh_status.phase === 'queueing' && refresh_status.new_items_count > 0) {
      return Math.min(100, (refresh_status.queued_count / refresh_status.new_items_count) * 100);
    }

    return 0;
  }

  getRefreshMetrics(): string[] {
    const refresh_status = this.getRefreshStatus();
    if (!refresh_status) return [];

    const metrics: string[] = [];
    const skipped_count = this.getSkippedCount(refresh_status);
    const queued_count = this.getQueuedAfterSkippedCount(refresh_status);
    // A count of what was found, not of what was looked at. Measured against the size of the
    // channel it read as progress, and sat at "1 / 386" through every upload it passed over.
    if (refresh_status.phase === 'collecting' && refresh_status.discovered_count > 0) {
      metrics.push($localize`${refresh_status.discovered_count}:discovered count: found so far`);
    }

    if (refresh_status.new_items_count > 0) {
      metrics.push($localize`${refresh_status.new_items_count}:new items count: new downloads found`);
    }

    if (queued_count > 0) {
      metrics.push($localize`${queued_count}:queued count: queued`);
    }

    if (skipped_count > 0) {
      metrics.push($localize`${skipped_count}:skipped count: skipped`);
    }

    if (refresh_status.running_download_count > 0) {
      metrics.push($localize`${refresh_status.running_download_count}:running download count: running now`);
    }

    if (refresh_status.pending_download_count > 0) {
      metrics.push($localize`${refresh_status.pending_download_count}:pending download count: pending in downloads`);
    }

    return metrics;
  }

  private getSkippedCount(refresh_status: SubscriptionRefreshStatus | null = this.getRefreshStatus()): number {
    return Math.max(0, Math.floor(Number(refresh_status?.skipped_count) || 0));
  }

  private hasSkippedDownloads(refresh_status: SubscriptionRefreshStatus | null = this.getRefreshStatus()): boolean {
    return this.getSkippedCount(refresh_status) > 0;
  }

  private hasUnfinishedDownloads(refresh_status: SubscriptionRefreshStatus | null = this.getRefreshStatus()): boolean {
    return !!(refresh_status && (refresh_status.pending_download_count > 0 || refresh_status.running_download_count > 0));
  }

  private getQueuedAfterSkippedCount(refresh_status: SubscriptionRefreshStatus | null = this.getRefreshStatus()): number {
    const queued_count = Math.max(0, Math.floor(Number(refresh_status?.queued_count) || 0));
    if (this.hasUnfinishedDownloads(refresh_status)) {
      const unfinished_count = Math.max(
        Number(refresh_status?.pending_download_count) || 0,
        Number(refresh_status?.running_download_count) || 0
      );
      return Math.max(unfinished_count, queued_count - this.getSkippedCount(refresh_status));
    }
    return Math.max(0, queued_count - this.getSkippedCount(refresh_status));
  }

  private getSkippedRefreshDescription(refresh_status: SubscriptionRefreshStatus | null): string {
    const skipped_count = this.getSkippedCount(refresh_status);
    const found_count = Math.max(0, Math.floor(Number(refresh_status?.new_items_count) || 0));
    if (found_count > skipped_count) {
      return $localize`The refresh found ${found_count}:new item count: new item(s), but ${skipped_count}:skipped count: were skipped because they are unavailable or members-only.`;
    }
    return $localize`The refresh found ${skipped_count}:skipped count: new item(s), but they were skipped because they are unavailable or members-only.`;
  }

  canOpenDownloads(): boolean {
    const refresh_status = this.getRefreshStatus();
    return !!(
      refresh_status?.pending_download_count > 0
      && this.postsService.config?.Extra?.enable_downloads_manager
      && this.postsService.hasPermission('downloads_manager')
    );
  }

  openDownloads(): void {
    this.router.navigate(['/downloads']);
  }

}
