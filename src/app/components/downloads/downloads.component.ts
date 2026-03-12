import { Component, OnInit, OnDestroy, ViewChild, Input, EventEmitter, HostListener } from '@angular/core';
import { PostsService } from 'app/posts.services';
import { trigger, transition, animateChild, stagger, query, style, animate } from '@angular/animations';
import { Router } from '@angular/router';
import { MatPaginator } from '@angular/material/paginator';
import { MatTableDataSource } from '@angular/material/table';
import { MatDialog, MatDialogRef } from '@angular/material/dialog';
import { ConfirmDialogComponent } from 'app/dialogs/confirm-dialog/confirm-dialog.component';
import { MatSort } from '@angular/material/sort';
import { Clipboard } from '@angular/cdk/clipboard';
import { Download, RestartDownloadResponse, SuccessObject } from 'api-types';
import { forkJoin, of } from 'rxjs';
import { catchError, filter, take } from 'rxjs/operators';
import { PlaylistDownloadProgressDialogComponent } from 'app/dialogs/playlist-download-progress-dialog/playlist-download-progress-dialog.component';

@Component({
    selector: 'app-downloads',
    templateUrl: './downloads.component.html',
    styleUrls: ['./downloads.component.scss'],
    standalone: false
})
export class DownloadsComponent implements OnInit, OnDestroy {

  @Input() uids: string[] = null;

  downloads_check_interval = 1000;
  raw_downloads: Download[] = [];
  downloads: Download[] = [];
  finished_downloads = [];
  interval_id = null;

  keys = Object.keys;

  valid_sessions_length = 0;

  paused_download_exists = false;
  running_download_exists = false;

  STEP_INDEX_TO_LABEL = {
      0: $localize`Creating download`,
      1: $localize`Getting info`,
      2: $localize`Downloading file`,
      3: $localize`Complete`
  }

  actionsFlex = 2;
  minimizeButtons = false;
  displayedColumnsBig: string[] = ['timestamp_start', 'title', 'sub_name', 'percent_complete', 'actions'];
  displayedColumnsSmall: string[] = ['title', 'percent_complete', 'actions'];
  displayedColumns: string[] = this.displayedColumnsBig;
  dataSource = new MatTableDataSource<Download>([]);
  playlist_progress_dialog_ref: MatDialogRef<PlaylistDownloadProgressDialogComponent> = null;
  playlist_progress_dialog_key: string = null;
  COMPLETE_LABEL = $localize`Complete`;

  // The purpose of this is to reduce code reuse for displaying these actions as icons or in a menu
  downloadActions: DownloadAction[] = [
    {
      tooltip: $localize`Watch content`,
      action: (download: Download) => this.watchContent(download),
      show: (download: Download) => download.finished && !download.error && !!download['container'],
      icon: 'smart_display'
    },
    {
      tooltip: $localize`Show error`,
      action: (download: Download) => this.showError(download),
      show: (download: Download) => download.finished && !!download.error,
      icon: 'warning'
    },
    {
      tooltip: $localize`Restart`,
      action: (download: Download) => this.restartDownload(download),
      show: (download: Download) => download.finished,
      icon: 'restart_alt'
    },
    {
      tooltip: $localize`Pause`,
      action: (download: Download) => this.pauseDownload(download),
      show: (download: Download) => !download.finished && (!download.paused || !download.finished_step),
      icon: 'pause'
    },
    {
      tooltip: $localize`Resume`,
      action: (download: Download) => this.resumeDownload(download),
      show: (download: Download) => !download.finished && download.paused && download.finished_step,
      icon: 'play_arrow'
    },
    {
      tooltip: $localize`Cancel`,
      action: (download: Download) => this.cancelDownload(download),
      show: (download: Download) => !download.finished && !download.paused && !download.cancelled,
      icon: 'cancel'
    },
    {
      tooltip: $localize`Clear`,
      action: (download: Download) => this.clearDownload(download),
      show: (download: Download) => download.finished || download.paused,
      icon: 'delete'
    }
  ]

  downloads_retrieved = false;

  innerWidth: number;

  @ViewChild(MatPaginator) paginator: MatPaginator;
  @ViewChild(MatSort) sort: MatSort;

  @HostListener('window:resize')
  onResize(): void {
    this.innerWidth = window.innerWidth;
    this.recalculateColumns();
  }

  sort_downloads = (a: Download, b: Download): number => {
    const result = b.timestamp_start - a.timestamp_start;
    return result;
  }

  constructor(public postsService: PostsService, private router: Router, private dialog: MatDialog, private clipboard: Clipboard) { }

  ngOnInit(): void {
    // Remove sub name as it's not necessary for one-off downloads
    if (this.uids) this.displayedColumnsBig = this.displayedColumnsBig.filter(col => col !== 'sub_name');
    this.innerWidth = window.innerWidth;
    this.recalculateColumns();
    if (this.postsService.initialized) {
      this.getCurrentDownloadsRecurring();
    } else {
      this.postsService.service_initialized
        .pipe(filter(Boolean), take(1))
        .subscribe(() => this.getCurrentDownloadsRecurring());
    }
  }

  getCurrentDownloadsRecurring(): void {
    if (!this.postsService.config['Extra']['enable_downloads_manager']) {
      this.router.navigate(['/home']);
      return;
    }
    this.getCurrentDownloads();
    this.interval_id = setInterval(() => {
      this.getCurrentDownloads();
    }, this.downloads_check_interval);
  }

  ngOnDestroy(): void {
    if (this.interval_id) { clearInterval(this.interval_id) }
    if (this.playlist_progress_dialog_ref) {
      this.playlist_progress_dialog_ref.close();
    }
  }

  getCurrentDownloads(): void {
    this.postsService.getCurrentDownloads(this.uids).subscribe(res => {
      if (res['downloads'] !== null && res['downloads'] !== undefined) {
        this.raw_downloads = this.combineDownloads(this.raw_downloads, res['downloads']);
        this.raw_downloads.sort(this.sort_downloads);
        this.downloads = this.groupDownloadsForDisplay(this.raw_downloads);
        this.downloads.sort(this.sort_downloads);
        this.dataSource.data = this.downloads;
        this.dataSource.paginator = this.paginator;
        this.dataSource.sort = this.sort;
        this.refreshOpenPlaylistProgressDialog();
        this.paused_download_exists = !!this.raw_downloads.find(download => download['paused'] && !download['error']);
        this.running_download_exists = !!this.raw_downloads.find(download => !download['paused'] && !download['finished']);
      }
      this.downloads_retrieved = true;
    });
  }

  clearDownloadsByType(): void {
    const clearEmitter = new EventEmitter<boolean>();
    const dialogRef = this.dialog.open(ConfirmDialogComponent, {
      data: {
        dialogType: 'selection_list',
        dialogTitle: $localize`Clear downloads`,
        dialogText: $localize`Select downloads to clear`,
        submitText: $localize`Clear`,
        doneEmitter: clearEmitter,
        warnSubmitColor: true,
        list: [
          {
            title: $localize`Finished downloads`,
            key: 'clear_finished'
          },
          {
            title: $localize`Paused downloads`,
            key: 'clear_paused'
          },
          {
            title: $localize`Errored downloads`,
            key: 'clear_errors'
          }
        ]
      }
    });
    clearEmitter.subscribe((done: boolean) => {
      if (done) {
        const selected_items = dialogRef.componentInstance.selected_items;
        this.postsService.clearDownloads(selected_items.includes('clear_finished'), selected_items.includes('clear_paused'), selected_items.includes('clear_errors')).subscribe(res => {
          if (!res['success']) {
            this.postsService.openSnackBar($localize`Failed to clear finished downloads!`);
          } else {
            this.postsService.openSnackBar($localize`Cleared downloads!`);
            dialogRef.close();
          }
        });
      }
    });
  }

  pauseDownload(download: Download): void {
    const target_downloads = this.getActionTargetDownloads(download)
      .filter(target_download => !target_download.finished && (!target_download.paused || !target_download.finished_step));
    this.runSuccessActionForDownloads(
      target_downloads,
      (download_uid: string) => this.postsService.pauseDownload(download_uid),
      $localize`Failed to pause download! See server logs for more info.`
    );
  }

  pauseAllDownloads(): void {
    this.postsService.pauseAllDownloads().subscribe(res => {
      if (!res['success']) {
        this.postsService.openSnackBar($localize`Failed to pause all downloads! See server logs for more info.`);
      }
    });
  }

  resumeDownload(download: Download): void {
    const target_downloads = this.getActionTargetDownloads(download)
      .filter(target_download => !target_download.finished && target_download.paused && target_download.finished_step);
    this.runSuccessActionForDownloads(
      target_downloads,
      (download_uid: string) => this.postsService.resumeDownload(download_uid),
      $localize`Failed to resume download! See server logs for more info.`
    );
  }

  resumeAllDownloads(): void {
    this.postsService.resumeAllDownloads().subscribe(res => {
      if (!res['success']) {
        this.postsService.openSnackBar($localize`Failed to resume all downloads! See server logs for more info.`);
      }
    });
  }

  restartDownload(download: Download): void {
    const target_downloads = this.getActionTargetDownloads(download)
      .filter(target_download => target_download.finished);
    const target_uids = target_downloads.map(target_download => target_download.uid).filter(uid => !!uid);
    if (target_uids.length === 0) return;

    const restart_requests = target_uids.map(download_uid => {
      return this.postsService.restartDownload(download_uid).pipe(
        catchError(() => of({success: false} as RestartDownloadResponse))
      );
    });

    forkJoin(restart_requests).subscribe(results => {
      const all_successful = results.every(result => !!result && !!result['success']);
      if (!all_successful) {
        this.postsService.openSnackBar($localize`Failed to restart download! See server logs for more info.`);
        return;
      }

      if (this.uids) {
        results
          .map(result => result && result['new_download_uid'] ? result['new_download_uid'] : null)
          .filter(new_download_uid => !!new_download_uid)
          .forEach(new_download_uid => this.uids.push(new_download_uid));
      }
    });
  }

  cancelDownload(download: Download): void {
    const target_downloads = this.getActionTargetDownloads(download)
      .filter(target_download => !target_download.finished && !target_download.paused && !target_download.cancelled);
    this.runSuccessActionForDownloads(
      target_downloads,
      (download_uid: string) => this.postsService.cancelDownload(download_uid),
      $localize`Failed to cancel download! See server logs for more info.`
    );
  }

  clearDownload(download: Download): void {
    const target_downloads = this.getActionTargetDownloads(download)
      .filter(target_download => target_download.finished || target_download.paused);
    this.runSuccessActionForDownloads(
      target_downloads,
      (download_uid: string) => this.postsService.clearDownload(download_uid),
      $localize`Failed to clear download! See server logs for more info.`
    );
  }

  watchContent(download: Download): void {
    const container = download['container'];
    localStorage.setItem('player_navigator', this.router.url.split(';')[0]);
    const is_playlist = container['uids']; // hacky, TODO: fix
    if (is_playlist) {
      this.router.navigate(['/player', {playlist_id: container['id'], type: download['type']}]);
    } else {
      this.router.navigate(['/player', {type: download['type'], uid: container['uid']}]);
    }
  }

  combineDownloads(downloads_old: Download[], downloads_new: Download[]): Download[] {
    const old_by_uid = new Map<string, Download>();
    downloads_old.forEach(download => old_by_uid.set(download.uid, download));

    const combined_downloads: Download[] = [];
    for (let i = 0; i < downloads_new.length; i++) {
      const incoming_download = downloads_new[i];
      const existing_download = old_by_uid.get(incoming_download.uid);

      if (!existing_download) {
        combined_downloads.push({...incoming_download});
        continue;
      }

      const incoming_keys = new Set(Object.keys(incoming_download));
      Object.keys(existing_download).forEach(key => {
        if (!incoming_keys.has(key)) {
          delete existing_download[key];
        }
      });
      Object.assign(existing_download, incoming_download);
      combined_downloads.push(existing_download);
    }

    return combined_downloads;
  }

  showError(download: Download): void {
    const copyToClipboardEmitter = new EventEmitter<boolean>();
    this.dialog.open(ConfirmDialogComponent, {
      data: {
        dialogTitle: $localize`Error for ${download['url']}:url:`,
        dialogText: download['error'],
        submitText: $localize`Copy to clipboard`,
        cancelText: $localize`Close`,
        closeOnSubmit: false,
        onlyEmitOnDone: true,
        doneEmitter: copyToClipboardEmitter
      }
    });
    copyToClipboardEmitter.subscribe(done => {
      if (done) {
        this.postsService.openSnackBar($localize`Copied to clipboard!`);
        this.clipboard.copy(download['error']);
      }
    });
  }

  private parseNumericPercent(value: unknown): number | null {
    if (value === null || value === undefined || value === '') return null;
    const numeric_value = Number(value);
    if (!Number.isFinite(numeric_value)) return null;
    return numeric_value;
  }

  shouldShowPercentComplete(download: Download): boolean {
    if (!download || download.error) return false;
    if (download.finished) return false;
    const numeric_percent = this.parseNumericPercent(download['percent_complete']);
    return numeric_percent !== null;
  }

  getNormalizedPercent(download: Download): string | null {
    if (!download) return null;
    if (download.finished) return '100.00';

    const numeric_percent = this.parseNumericPercent(download['percent_complete']);
    if (numeric_percent === null) return null;
    return Math.min(100, Math.max(0, numeric_percent)).toFixed(2);
  }

  hasPlaylistItemProgress(download: Download): boolean {
    const playlist_item_progress = (download as DownloadWithPlaylistProgress)['playlist_item_progress'];
    return Array.isArray(playlist_item_progress) && playlist_item_progress.length > 1;
  }

  showPlaylistProgress(download: Download): void {
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

  private refreshOpenPlaylistProgressDialog(): void {
    if (!this.playlist_progress_dialog_ref || !this.playlist_progress_dialog_key) return;
    if (!this.dialog.openDialogs.includes(this.playlist_progress_dialog_ref)) {
      this.playlist_progress_dialog_ref = null;
      this.playlist_progress_dialog_key = null;
      return;
    }

    const matching_download = this.downloads.find(download => this.getPlaylistProgressDialogKey(download) === this.playlist_progress_dialog_key);
    if (!matching_download) return;
    this.playlist_progress_dialog_ref.componentInstance.updateDownload(matching_download as DownloadWithPlaylistProgress);
  }

  private runSuccessActionForDownloads(
    downloads: Download[],
    action: (download_uid: string) => any,
    failure_message: string
  ): void {
    const target_uids = downloads.map(download => download.uid).filter(uid => !!uid);
    if (target_uids.length === 0) return;

    const requests = target_uids.map(download_uid => action(download_uid).pipe(
      catchError(() => of({success: false} as SuccessObject))
    ));

    forkJoin(requests).subscribe(results => {
      const all_successful = results.every(result => !!result && !!result['success']);
      if (!all_successful) this.postsService.openSnackBar(failure_message);
    });
  }

  private getActionTargetDownloads(download: Download): Download[] {
    const aggregate_download = download as BatchAggregateDownload;
    if (!aggregate_download?.is_batch_aggregate || !Array.isArray(aggregate_download.batch_download_uids) || aggregate_download.batch_download_uids.length === 0) {
      return [download];
    }

    const target_uid_set = new Set<string>(aggregate_download.batch_download_uids);
    return this.raw_downloads.filter(raw_download => target_uid_set.has(raw_download.uid));
  }

  private getPlaylistBatchId(download: Download): string | null {
    if (!download || typeof download !== 'object') return null;
    const download_with_batch = download as BatchAggregateDownload;
    if (download_with_batch.playlist_batch_id && typeof download_with_batch.playlist_batch_id === 'string') {
      const normalized_batch_id = download_with_batch.playlist_batch_id.trim();
      if (normalized_batch_id !== '') return normalized_batch_id;
    }

    const options = (download as DownloadWithOptions).options;
    const options_batch_id = options && typeof options.playlistBatchId === 'string' ? options.playlistBatchId.trim() : '';
    return options_batch_id !== '' ? options_batch_id : null;
  }

  private isChunkedPlaylistDownload(download: Download): boolean {
    const batch_id = this.getPlaylistBatchId(download);
    if (!batch_id) return false;
    const options = (download as DownloadWithOptions).options;
    return !!(options && options.playlistChunkRange);
  }

  private groupDownloadsForDisplay(downloads: Download[]): Download[] {
    const grouped_downloads = new Map<string, Download[]>();
    const display_downloads: Download[] = [];

    for (const download of downloads) {
      if (!this.isChunkedPlaylistDownload(download)) {
        display_downloads.push(download);
        continue;
      }
      const batch_id = this.getPlaylistBatchId(download);
      if (!batch_id) {
        display_downloads.push(download);
        continue;
      }
      const existing_batch_downloads = grouped_downloads.get(batch_id) || [];
      existing_batch_downloads.push(download);
      grouped_downloads.set(batch_id, existing_batch_downloads);
    }

    grouped_downloads.forEach((batch_downloads, batch_id) => {
      if (batch_downloads.length <= 1) {
        display_downloads.push(...batch_downloads);
        return;
      }
      display_downloads.push(this.buildBatchAggregateDownload(batch_id, batch_downloads));
    });

    return display_downloads;
  }

  private buildBatchAggregateDownload(batch_id: string, batch_downloads: Download[]): BatchAggregateDownload {
    const sorted_batch_downloads = [...batch_downloads].sort((download1, download2) => download1.timestamp_start - download2.timestamp_start);
    const representative_download = sorted_batch_downloads[0];
    const merged_playlist_progress = this.mergeBatchPlaylistProgress(sorted_batch_downloads as DownloadWithPlaylistProgress[]);
    const all_finished = sorted_batch_downloads.every(download => !!download.finished);
    const all_paused = sorted_batch_downloads.every(download => !!download.paused);
    const any_running = sorted_batch_downloads.some(download => !!download.running);
    const any_cancelled = sorted_batch_downloads.some(download => !!download.cancelled);
    const finished_step = sorted_batch_downloads.every(download => !!download.finished_step);
    const normalized_percent_complete = this.getAggregatePercentComplete(sorted_batch_downloads, merged_playlist_progress, representative_download.percent_complete);
    const aggregate_error = this.getAggregateError(sorted_batch_downloads);
    const aggregate_step_index = this.getAggregateStepIndex(sorted_batch_downloads);
    const aggregate_options = {...((representative_download as DownloadWithOptions).options || {})};
    delete aggregate_options.playlistChunkRange;
    delete aggregate_options.playlistChunkIndex;
    delete aggregate_options.playlistChunkCount;

    return {
      ...(representative_download as DownloadWithPlaylistProgress),
      uid: `playlist-batch:${batch_id}`,
      title: this.getAggregateTitle(sorted_batch_downloads),
      options: aggregate_options,
      timestamp_start: sorted_batch_downloads.reduce((current_minimum, download) => {
        return Math.min(current_minimum, Number(download.timestamp_start));
      }, Number(representative_download.timestamp_start)),
      running: any_running,
      finished: all_finished,
      paused: all_paused,
      cancelled: any_cancelled,
      finished_step: finished_step,
      step_index: aggregate_step_index,
      percent_complete: normalized_percent_complete,
      error: aggregate_error,
      playlist_item_progress: merged_playlist_progress,
      container: this.getAggregateContainer(sorted_batch_downloads),
      is_batch_aggregate: true,
      playlist_batch_id: batch_id,
      batch_download_uids: sorted_batch_downloads.map(download => download.uid)
    };
  }

  private getAggregateTitle(batch_downloads: Download[]): string {
    for (const download of batch_downloads) {
      const options = (download as DownloadWithOptions).options;
      const title_candidate = options && typeof options.playlistChunkTitle === 'string' ? options.playlistChunkTitle.trim() : '';
      if (title_candidate !== '') return title_candidate;
    }

    const fallback_title = batch_downloads.find(download => typeof download.title === 'string' && download.title.trim() !== '');
    if (!fallback_title) return $localize`Playlist`;

    const normalized_title = fallback_title.title.trim();
    const without_chunk_suffix = normalized_title.replace(/\s*\[Chunk\s+\d+\/\d+:\s*[^\]]+\]\s*$/i, '').trim();
    return without_chunk_suffix !== '' ? without_chunk_suffix : normalized_title;
  }

  private getAggregateContainer(batch_downloads: Download[]): any {
    const playlist_container_download = batch_downloads.find(download => {
      const container = (download as DownloadWithContainer).container;
      return !!(container && container['id']);
    });
    if (playlist_container_download) return (playlist_container_download as DownloadWithContainer).container;

    const file_container_download = batch_downloads.find(download => {
      const container = (download as DownloadWithContainer).container;
      return !!(container && container['uid']);
    });
    return file_container_download ? (file_container_download as DownloadWithContainer).container : null;
  }

  private getAggregateStepIndex(batch_downloads: Download[]): number {
    if (batch_downloads.every(download => !!download.finished)) return 3;
    if (batch_downloads.some(download => !download.finished && download.step_index >= 2)) return 2;
    if (batch_downloads.some(download => !download.finished && download.step_index >= 1)) return 1;
    return 0;
  }

  private getAggregateError(batch_downloads: Download[]): string | null {
    const error_downloads = batch_downloads.filter(download => !!download.error);
    if (error_downloads.length === 0) return null;
    const unique_errors = Array.from(new Set(error_downloads.map(download => download.error).filter(error => !!error)));
    if (unique_errors.length === 1) return unique_errors[0];
    return `${error_downloads.length} chunk(s) failed. ${unique_errors[0]}`;
  }

  private mergeBatchPlaylistProgress(batch_downloads: DownloadWithPlaylistProgress[]): PlaylistDownloadProgressItem[] | null {
    const merged_items: PlaylistDownloadProgressItem[] = [];
    for (const download of batch_downloads) {
      if (!Array.isArray(download.playlist_item_progress)) continue;
      for (const item of download.playlist_item_progress) {
        merged_items.push({...item});
      }
    }

    if (merged_items.length === 0) return null;

    merged_items.sort((item1, item2) => {
      const path_index_1 = Number.isFinite(Number(item1.progress_path_index)) ? Number(item1.progress_path_index) : Number.MAX_SAFE_INTEGER;
      const path_index_2 = Number.isFinite(Number(item2.progress_path_index)) ? Number(item2.progress_path_index) : Number.MAX_SAFE_INTEGER;
      if (path_index_1 !== path_index_2) return path_index_1 - path_index_2;

      const index_1 = Number.isFinite(Number(item1.index)) ? Number(item1.index) : Number.MAX_SAFE_INTEGER;
      const index_2 = Number.isFinite(Number(item2.index)) ? Number(item2.index) : Number.MAX_SAFE_INTEGER;
      if (index_1 !== index_2) return index_1 - index_2;

      return String(item1.title || '').localeCompare(String(item2.title || ''));
    });
    return merged_items;
  }

  private getAggregatePercentComplete(batch_downloads: Download[], playlist_progress: PlaylistDownloadProgressItem[] | null, fallback_percent: number): number {
    if (batch_downloads.every(download => !!download.finished)) return 100;

    const playlist_percent = this.getPlaylistProgressPercent(playlist_progress);
    if (playlist_percent !== null) return playlist_percent;

    const chunk_percents = batch_downloads
      .map(download => this.parseNumericPercent(download.percent_complete))
      .filter(percent => percent !== null) as number[];
    if (chunk_percents.length > 0) {
      const average_percent = chunk_percents.reduce((sum, percent) => sum + percent, 0) / chunk_percents.length;
      return Math.max(0, Math.min(100, average_percent));
    }

    const normalized_fallback_percent = this.parseNumericPercent(fallback_percent);
    if (normalized_fallback_percent !== null) return Math.max(0, Math.min(100, normalized_fallback_percent));
    return 0;
  }

  private getPlaylistProgressPercent(playlist_progress: PlaylistDownloadProgressItem[] | null): number | null {
    if (!Array.isArray(playlist_progress) || playlist_progress.length === 0) return null;

    let total_expected_size = 0;
    let total_downloaded_size = 0;
    for (const item of playlist_progress) {
      const expected_size = Number(item.expected_file_size);
      const downloaded_size = Number(item.downloaded_size);
      if (Number.isFinite(expected_size) && expected_size > 0) {
        total_expected_size += expected_size;
        const normalized_downloaded_size = Number.isFinite(downloaded_size) ? downloaded_size : 0;
        total_downloaded_size += Math.max(0, Math.min(expected_size, normalized_downloaded_size));
        continue;
      }

      const item_percent = this.parseNumericPercent(item.percent_complete);
      if (item_percent !== null) {
        total_expected_size += 100;
        total_downloaded_size += Math.max(0, Math.min(100, item_percent));
      }
    }

    if (!Number.isFinite(total_expected_size) || total_expected_size <= 0) return null;
    return Math.max(0, Math.min(100, (total_downloaded_size / total_expected_size) * 100));
  }

  private getPlaylistProgressDialogKey(download: Download): string {
    const playlist_batch_id = this.getPlaylistBatchId(download);
    if (playlist_batch_id) return `playlist-batch:${playlist_batch_id}`;
    return download.uid;
  }

  recalculateColumns() {
    if (this.innerWidth < 650) this.displayedColumns = this.displayedColumnsSmall;
    else                       this.displayedColumns = this.displayedColumnsBig;

    this.actionsFlex = this.uids || this.innerWidth < 800 ? 1 : 2;

    if (this.innerWidth < 800 && !this.uids || this.innerWidth < 1100 && this.uids) this.minimizeButtons = true;
    else                                                                            this.minimizeButtons = false;
  }
}

interface DownloadAction {
  tooltip: string,
  action: (download: Download) => void,
  show: (download: Download) => boolean,
  icon: string,
  loading?: (download: Download) => boolean
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

interface DownloadWithOptions extends DownloadWithPlaylistProgress {
  options?: {
    playlistBatchId?: string,
    playlistChunkRange?: string,
    playlistChunkIndex?: number,
    playlistChunkCount?: number,
    playlistChunkTitle?: string
  }
}

interface DownloadWithContainer extends DownloadWithOptions {
  container?: {
    id?: string,
    uid?: string,
    uids?: string[]
  } | null
}

interface BatchAggregateDownload extends DownloadWithContainer {
  is_batch_aggregate?: boolean,
  playlist_batch_id?: string,
  batch_download_uids?: string[]
}
