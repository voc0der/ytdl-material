import { Component, OnInit, OnDestroy, ViewChild, Input, EventEmitter, HostListener } from '@angular/core';
import { PostsService } from 'app/posts.services';
import { trigger, transition, animateChild, stagger, query, style, animate } from '@angular/animations';
import { Router } from '@angular/router';
import { MatPaginator } from '@angular/material/paginator';
import { MatTableDataSource } from '@angular/material/table';
import { MatDialog } from '@angular/material/dialog';
import { ConfirmDialogComponent } from 'app/dialogs/confirm-dialog/confirm-dialog.component';
import { MatSort } from '@angular/material/sort';
import { Clipboard } from '@angular/cdk/clipboard';
import { Download } from 'api-types';
import { filter, take } from 'rxjs/operators';
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
  downloads = [];
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

  // The purpose of this is to reduce code reuse for displaying these actions as icons or in a menu
  downloadActions: DownloadAction[] = [
    {
      tooltip: $localize`Watch content`,
      action: (download: Download) => this.watchContent(download),
      show: (download: Download) => download.finished && !download.error,
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
  }

  getCurrentDownloads(): void {
    this.postsService.getCurrentDownloads(this.uids).subscribe(res => {
      if (res['downloads'] !== null && res['downloads'] !== undefined) {
        this.downloads = this.combineDownloads(this.downloads, res['downloads']);
        this.downloads.sort(this.sort_downloads);
        this.dataSource.data = this.downloads;
        this.dataSource.paginator = this.paginator;
        this.dataSource.sort = this.sort;
        this.paused_download_exists = !!this.downloads.find(download => download['paused'] && !download['error']);
        this.running_download_exists = !!this.downloads.find(download => !download['paused'] && !download['finished']);
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
    this.postsService.pauseDownload(download['uid']).subscribe(res => {
      if (!res['success']) {
        this.postsService.openSnackBar($localize`Failed to pause download! See server logs for more info.`);
      }
    });
  }

  pauseAllDownloads(): void {
    this.postsService.pauseAllDownloads().subscribe(res => {
      if (!res['success']) {
        this.postsService.openSnackBar($localize`Failed to pause all downloads! See server logs for more info.`);
      }
    });
  }

  resumeDownload(download: Download): void {
    this.postsService.resumeDownload(download['uid']).subscribe(res => {
      if (!res['success']) {
        this.postsService.openSnackBar($localize`Failed to resume download! See server logs for more info.`);
      }
    });
  }

  resumeAllDownloads(): void {
    this.postsService.resumeAllDownloads().subscribe(res => {
      if (!res['success']) {
        this.postsService.openSnackBar($localize`Failed to resume all downloads! See server logs for more info.`);
      }
    });
  }

  restartDownload(download: Download): void {
    this.postsService.restartDownload(download['uid']).subscribe(res => {
      if (!res['success']) {
        this.postsService.openSnackBar($localize`Failed to restart download! See server logs for more info.`);
      } else {
        if (this.uids && res['new_download_uid']) {
          this.uids.push(res['new_download_uid']);
        }
      }
    });
  }

  cancelDownload(download: Download): void {
    this.postsService.cancelDownload(download['uid']).subscribe(res => {
      if (!res['success']) {
        this.postsService.openSnackBar($localize`Failed to cancel download! See server logs for more info.`);
      }
    });
  }

  clearDownload(download: Download): void {
    this.postsService.clearDownload(download['uid']).subscribe(res => {
      if (!res['success']) {
        this.postsService.openSnackBar($localize`Failed to pause download! See server logs for more info.`);
      }
    });
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

  shouldShowPercentComplete(download: Download): boolean {
    if (!download || download.error) return false;
    if (download.step_index === 2) return true;
    return download.finished && this.hasPlaylistItemProgress(download);
  }

  getNormalizedPercent(download: Download): string | null {
    if (!download) return null;
    if (download.finished) return '100.00';

    const numeric_percent = Number(download['percent_complete']);
    if (!Number.isFinite(numeric_percent)) return null;
    return Math.min(100, Math.max(0, numeric_percent)).toFixed(2);
  }

  hasPlaylistItemProgress(download: Download): boolean {
    const playlist_item_progress = (download as DownloadWithPlaylistProgress)['playlist_item_progress'];
    return Array.isArray(playlist_item_progress) && playlist_item_progress.length > 1;
  }

  showPlaylistProgress(download: Download): void {
    if (!this.hasPlaylistItemProgress(download)) return;

    this.dialog.open(PlaylistDownloadProgressDialogComponent, {
      width: '720px',
      maxWidth: '95vw',
      data: {download: download as DownloadWithPlaylistProgress}
    });
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
