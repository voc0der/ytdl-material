import { Component, Inject, OnInit } from '@angular/core';
import { MAT_DIALOG_DATA } from '@angular/material/dialog';
import { Download } from 'api-types';

@Component({
    selector: 'app-playlist-download-progress-dialog',
    templateUrl: './playlist-download-progress-dialog.component.html',
    styleUrls: ['./playlist-download-progress-dialog.component.scss'],
    standalone: false
})
export class PlaylistDownloadProgressDialogComponent implements OnInit {
  download: DownloadWithPlaylistProgress = null;
  playlist_item_progress: PlaylistDownloadProgressItem[] = [];
  overall_percent = '0.00';

  constructor(@Inject(MAT_DIALOG_DATA) public data: PlaylistDownloadProgressDialogData) { }

  ngOnInit(): void {
    this.updateDownload(this.data && this.data.download ? this.data.download : null);
  }

  updateDownload(download: DownloadWithPlaylistProgress): void {
    this.download = download;

    const incoming_items = this.download && Array.isArray(this.download.playlist_item_progress)
      ? this.download.playlist_item_progress
      : [];
    this.playlist_item_progress = [...incoming_items].sort((a, b) => {
      return this.asFiniteNumber(a && a.index, 0) - this.asFiniteNumber(b && b.index, 0);
    });

    this.overall_percent = this.getOverallPercent();
  }

  getOverallPercent(): string {
    if (!this.download) return '0.00';
    if (this.download.finished) return '100.00';

    const numeric_percent = Number(this.download.percent_complete);
    if (!Number.isFinite(numeric_percent)) return '0.00';
    return Math.min(100, Math.max(0, numeric_percent)).toFixed(2);
  }

  getItemPercent(item: PlaylistDownloadProgressItem): number {
    const numeric_percent = Number(item && item.percent_complete);
    if (!Number.isFinite(numeric_percent)) return 0;
    return Math.min(100, Math.max(0, numeric_percent));
  }

  getItemStatusLabel(item: PlaylistDownloadProgressItem): string {
    const status = item && item.status ? item.status : 'pending';
    switch (status) {
      case 'complete':
        return $localize`Complete`;
      case 'downloading':
        return $localize`Downloading`;
      case 'failed':
        return $localize`Failed`;
      default:
        return $localize`Pending`;
    }
  }

  private asFiniteNumber(value: unknown, defaultValue = 0): number {
    const numeric_value = Number(value);
    return Number.isFinite(numeric_value) ? numeric_value : defaultValue;
  }
}

interface PlaylistDownloadProgressDialogData {
  download: DownloadWithPlaylistProgress
}

interface DownloadWithPlaylistProgress extends Download {
  playlist_item_progress?: PlaylistDownloadProgressItem[] | null
}

interface PlaylistDownloadProgressItem {
  index: number,
  id?: string | null,
  title: string,
  expected_file_size: number,
  downloaded_size: number,
  percent_complete: number,
  status: string
}
