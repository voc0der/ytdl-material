import { Component, Inject, OnInit, ChangeDetectionStrategy } from '@angular/core';
import { MatDialogRef, MAT_DIALOG_DATA, MatDialogTitle, MatDialogContent, MatDialogActions, MatDialogClose } from '@angular/material/dialog';
import { PostsService } from 'app/posts.services';
import { CdkScrollable } from '@angular/cdk/scrolling';
import { MatIcon } from '@angular/material/icon';
import { MatTooltip } from '@angular/material/tooltip';
import { MatProgressSpinner } from '@angular/material/progress-spinner';
import { AppDatePipe } from 'app/pipes/app-date.pipe';

@Component({
    selector: 'app-restore-db-dialog',
    templateUrl: './restore-db-dialog.component.html',
    styleUrls: ['./restore-db-dialog.component.scss'],
    changeDetection: ChangeDetectionStrategy.Eager,
    host: { class: 'kit-dialog' },
    imports: [MatDialogTitle, CdkScrollable, MatDialogContent, MatIcon, MatTooltip, MatDialogActions, MatDialogClose, MatProgressSpinner, AppDatePipe]
})
export class RestoreDbDialogComponent implements OnInit {

  db_backups = [];
  // One backup, held as the one-item list the restore request is built from.
  selected_backup: string[] = null;
  restoring = false;
  loading = true;
  // Why the list could not be had. Without it, a failed request read as having no backups.
  load_error: string = null;

  readonly backupsLabel = $localize`Backups`;

  constructor(@Inject(MAT_DIALOG_DATA) public data: any, private dialogRef: MatDialogRef<RestoreDbDialogComponent>, private postsService: PostsService) {
    if (this.data?.db_backups) {
      this.db_backups = this.data.db_backups;
    }

    this.getDBBackups();
  }

  ngOnInit(): void {
  }

  isSelected(db_backup: {name: string}): boolean {
    return this.selected_backup?.[0] === db_backup.name;
  }

  select(db_backup: {name: string}): void {
    this.selected_backup = this.isSelected(db_backup) ? null : [db_backup.name];
  }

  getDBBackups(): void {
    this.postsService.getDBBackups().subscribe({
      next: res => {
        this.db_backups = res['db_backups'] ?? [];
        this.loading = false;
      },
      error: err => {
        // Anyone who manages tasks can open this from the tasks page, but only an admin can
        // list the backups or restore one.
        this.load_error = err?.status === 403
          ? $localize`Only an admin can restore the database.`
          : $localize`Couldn't load the backups.`;
        this.loading = false;
        console.error(err);
      }
    });
  }

  restoreClicked(): void {
    if (this.selected_backup?.length !== 1) return;
    this.restoring = true;
    this.postsService.restoreDBBackup(this.selected_backup[0]).subscribe(res => {
      this.restoring = false;
      if (res['success']) {
        this.postsService.openSnackBar($localize`Database successfully restored!`);
        this.dialogRef.close();
      } else {
        this.postsService.openSnackBar($localize`Failed to restore database! See logs for more info.`);
      }
    }, err => {
      this.restoring = false;
      this.postsService.openSnackBar($localize`Failed to restore database! See browser console for more info.`);
      console.error(err);
    });
  }

}
