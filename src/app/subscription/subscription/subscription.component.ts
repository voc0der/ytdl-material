import { Component, OnDestroy, OnInit } from '@angular/core';
import { PostsService } from 'app/posts.services';
import { ActivatedRoute, Router } from '@angular/router';
import { MatDialog } from '@angular/material/dialog';
import { EditSubscriptionDialogComponent } from 'app/dialogs/edit-subscription-dialog/edit-subscription-dialog.component';
import { Subscription, SubscriptionRefreshStatus } from 'api-types';
import { saveAs } from 'file-saver';
import { filter, take } from 'rxjs/operators';

@Component({
    selector: 'app-subscription',
    templateUrl: './subscription.component.html',
    styleUrls: ['./subscription.component.scss'],
    standalone: false
})
export class SubscriptionComponent implements OnInit, OnDestroy {

  id = null;
  subscription: Subscription = null;
  use_youtubedl_archive = false;
  descendingMode = true;
  downloading = false;
  sub_interval = null;
  check_clicked = false;
  cancel_clicked = false;

  constructor(private postsService: PostsService, private route: ActivatedRoute, private router: Router, private dialog: MatDialog) { }

  ngOnInit() {
    this.route.params.subscribe(params => {
      this.id = params['id'];

      if (this.sub_interval) { clearInterval(this.sub_interval); }

      this.postsService.service_initialized
        .pipe(filter(Boolean), take(1))
        .subscribe(() => {
          this.getConfig();
          this.getSubscription();
          this.sub_interval = setInterval(() => this.getSubscription(true), 1000);
        });
    });
  }

  ngOnDestroy() {
    // prevents subscription getter from running in the background
    if (this.sub_interval) {
      clearInterval(this.sub_interval);
    }
  }

  goBack() {
    this.router.navigate(['/subscriptions']);
  }

  getSubscription(low_cost = false) {
    this.postsService.getSubscription(this.id).subscribe(res => {
      const next_subscription = res['subscription'] as Subscription;
      const current_video_count = this.subscription?.videos?.length || 0;
      const next_video_count = next_subscription?.videos?.length || 0;

      if (low_cost && this.subscription && next_video_count === current_video_count) {
        this.subscription = {
          ...this.subscription,
          ...next_subscription,
          videos: this.subscription.videos
        };
        return;
      } else if (next_video_count > current_video_count) {
        // only when files are added so we don't reload files when one is deleted
        this.postsService.files_changed.next(true);
      }
      this.subscription = next_subscription;
    });
  }

  getConfig(): void {
    this.use_youtubedl_archive = this.postsService.config['Downloader']['use_youtubedl_archive'];
  }

  downloadContent(): void {
    this.downloading = true;
    this.postsService.downloadSubFromServer(this.subscription.id).subscribe(res => {
      this.downloading = false;
      const blob: Blob = res;
      saveAs(blob, this.subscription.name + '.zip');
    }, err => {
      console.log(err);
      this.downloading = false;
    });
  }

  editSubscription(): void {
    this.dialog.open(EditSubscriptionDialogComponent, {
      data: {
        sub: this.postsService.getSubscriptionByID(this.subscription.id)
      }
    });
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
    }, err => {
      console.error(err);
      this.cancel_clicked = false;
      this.postsService.openSnackBar('Failed to cancel check subscription!');
    });
  }

  getRefreshStatus(): SubscriptionRefreshStatus | null {
    return this.subscription?.refresh_status || null;
  }

  shouldShowRefreshStatus(): boolean {
    const refresh_status = this.getRefreshStatus();
    return !!(refresh_status && (
      refresh_status.phase !== 'idle'
      || refresh_status.active
      || refresh_status.pending_download_count > 0
      || refresh_status.running_download_count > 0
      || refresh_status.started_at
      || refresh_status.completed_at
    ));
  }

  hasActiveRefresh(): boolean {
    const refresh_status = this.getRefreshStatus();
    return !!(this.subscription?.downloading || refresh_status?.active);
  }

  getRefreshHeadline(): string {
    const refresh_status = this.getRefreshStatus();
    switch (refresh_status?.phase) {
    case 'collecting':
      return $localize`Checking channel metadata`;
    case 'queueing':
      return $localize`Queueing new downloads`;
    case 'queued':
      return refresh_status.pending_download_count > 0
        ? $localize`Downloads queued`
        : $localize`Downloads were queued`;
    case 'complete':
      return $localize`Channel is up to date`;
    case 'cancelled':
      return $localize`Refresh cancelled`;
    case 'error':
      return $localize`Refresh failed`;
    default:
      return this.subscription?.downloading
        ? $localize`Checking channel metadata`
        : $localize`Channel refresh`;
    }
  }

  getRefreshDescription(): string {
    const refresh_status = this.getRefreshStatus();
    const latest_item_title = refresh_status?.latest_item_title ? ` "${refresh_status.latest_item_title}"` : '';
    switch (refresh_status?.phase) {
    case 'collecting':
      return $localize`The app is scanning this channel before it creates download jobs. Files will appear here after queued downloads finish.` + latest_item_title;
    case 'queueing':
      return refresh_status?.new_items_count > 0
        ? $localize`Found ${refresh_status.new_items_count}:new item count: new item(s). The app is creating download jobs now.`
        : $localize`The metadata scan finished. The app is preparing download jobs now.`;
    case 'queued':
      if (refresh_status?.pending_download_count > 0) {
        return $localize`Download jobs are queued. New files will appear here as each download completes.`;
      }
      return $localize`The refresh queued download jobs successfully.`;
    case 'complete':
      return refresh_status?.new_items_count > 0
        ? $localize`The refresh finished successfully.`
        : $localize`The last refresh did not find any new videos to download.`;
    case 'cancelled':
      return $localize`The refresh was stopped before it finished collecting channel metadata or queueing all downloads.`;
    case 'error':
      return refresh_status?.error
        ? `${$localize`The refresh failed:`} ${refresh_status.error}`
        : $localize`The refresh failed before the app could finish collecting metadata or queue downloads.`;
    default:
      return $localize`The subscription page will show completed files only.`;
    }
  }

  shouldShowRefreshProgressBar(): boolean {
    const phase = this.getRefreshStatus()?.phase;
    return phase === 'collecting' || phase === 'queueing';
  }

  getRefreshProgressMode(): 'determinate' | 'indeterminate' {
    const refresh_status = this.getRefreshStatus();
    if (!refresh_status) return 'indeterminate';

    if (refresh_status.phase === 'collecting' && refresh_status.total_count > 0) {
      return 'determinate';
    }

    if (refresh_status.phase === 'queueing' && refresh_status.new_items_count > 0) {
      return 'determinate';
    }

    return 'indeterminate';
  }

  getRefreshProgressValue(): number {
    const refresh_status = this.getRefreshStatus();
    if (!refresh_status) return 0;

    if (refresh_status.phase === 'collecting' && refresh_status.total_count > 0) {
      return Math.min(100, (refresh_status.discovered_count / refresh_status.total_count) * 100);
    }

    if (refresh_status.phase === 'queueing' && refresh_status.new_items_count > 0) {
      return Math.min(100, (refresh_status.queued_count / refresh_status.new_items_count) * 100);
    }

    return 0;
  }

  getRefreshMetrics(): string[] {
    const refresh_status = this.getRefreshStatus();
    if (!refresh_status) return [];

    const metrics: string[] = [];
    if (refresh_status.phase === 'collecting') {
      if (refresh_status.total_count > 0) {
        metrics.push($localize`${refresh_status.discovered_count}:discovered count: / ${refresh_status.total_count}:total count: items scanned`);
      } else if (refresh_status.discovered_count > 0) {
        metrics.push($localize`${refresh_status.discovered_count}:discovered count: items scanned`);
      }
    }

    if (refresh_status.new_items_count > 0) {
      metrics.push($localize`${refresh_status.new_items_count}:new items count: new downloads found`);
    }

    if (refresh_status.queued_count > 0) {
      metrics.push($localize`${refresh_status.queued_count}:queued count: queued`);
    }

    if (refresh_status.running_download_count > 0) {
      metrics.push($localize`${refresh_status.running_download_count}:running download count: running now`);
    }

    if (refresh_status.pending_download_count > 0) {
      metrics.push($localize`${refresh_status.pending_download_count}:pending download count: pending in downloads`);
    }

    return metrics;
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
