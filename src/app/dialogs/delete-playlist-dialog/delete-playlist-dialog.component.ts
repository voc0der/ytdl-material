import { Component, Inject, ChangeDetectionStrategy } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialog, MatDialogRef, MatDialogTitle, MatDialogContent, MatDialogActions, MatDialogClose } from '@angular/material/dialog';
import { take } from 'rxjs/operators';
import { openConfirmDialog } from '../confirm-dialog/confirm-dialog.component';
import { CdkScrollable } from '@angular/cdk/scrolling';
import { MatIcon } from '@angular/material/icon';

export type DeletePlaylistDialogAction = 'playlist_only' | 'playlist_and_files';

@Component({
    selector: 'app-delete-playlist-dialog',
    templateUrl: './delete-playlist-dialog.component.html',
    styleUrls: ['./delete-playlist-dialog.component.scss'],
    changeDetection: ChangeDetectionStrategy.Eager,
    host: { class: 'kit-dialog' },
    imports: [MatDialogTitle, CdkScrollable, MatDialogContent, MatIcon, MatDialogActions, MatDialogClose]
})
export class DeletePlaylistDialogComponent {
  playlistName = $localize`this playlist`;
  fileCount = 0;

  constructor(
    @Inject(MAT_DIALOG_DATA) public data: {playlistName?: string; fileCount?: number},
    private dialog: MatDialog,
    public dialogRef: MatDialogRef<DeletePlaylistDialogComponent, DeletePlaylistDialogAction | undefined>
  ) {
    if (typeof this.data?.playlistName === 'string' && this.data.playlistName.trim() !== '') {
      this.playlistName = this.data.playlistName;
    }
    if (Number.isFinite(this.data?.fileCount)) {
      this.fileCount = Number(this.data.fileCount);
    }
  }

  deletePlaylistOnly(): void {
    this.dialogRef.close('playlist_only');
  }

  confirmDeletePlaylistAndFiles(): void {
    const dialogRef = openConfirmDialog(this.dialog, {
      dialogTitle: $localize`Delete playlist files`,
      dialogText: $localize`This will delete the playlist and ${this.fileCount}:file count: file(s) from ${this.playlistName}:playlist name:. This cannot be undone.`,
      submitText: $localize`Delete files too`,
      warnSubmitColor: true
    });

    dialogRef.afterClosed().pipe(take(1)).subscribe(confirmed => {
      if (confirmed) {
        this.dialogRef.close('playlist_and_files');
      }
    });
  }
}
