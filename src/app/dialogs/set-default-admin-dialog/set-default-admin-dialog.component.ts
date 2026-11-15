import { Component, OnInit, ChangeDetectionStrategy } from '@angular/core';
import { PostsService } from 'app/posts.services';
import { MatDialogRef, MatDialogTitle, MatDialogContent, MatDialogActions } from '@angular/material/dialog';
import { CdkScrollable } from '@angular/cdk/scrolling';
import { MatIcon } from '@angular/material/icon';
import { FormsModule } from '@angular/forms';
import { MatProgressSpinner } from '@angular/material/progress-spinner';

@Component({
    selector: 'app-set-default-admin-dialog',
    templateUrl: './set-default-admin-dialog.component.html',
    styleUrls: ['./set-default-admin-dialog.component.scss'],
    changeDetection: ChangeDetectionStrategy.Eager,
    host: { class: 'kit-dialog' },
    imports: [MatDialogTitle, CdkScrollable, MatDialogContent, MatIcon, FormsModule, MatDialogActions, MatProgressSpinner]
})
export class SetDefaultAdminDialogComponent implements OnInit {
  creating = false;
  failed = false;
  input = '';
  constructor(private postsService: PostsService, public dialogRef: MatDialogRef<SetDefaultAdminDialogComponent>) { }

  ngOnInit(): void {
  }

  // The server answers with the account it made, and refuses with an error status. On a
  // failure the dialog stays open with the password, so it can be tried again.
  create() {
    if (!this.input || this.creating) return;
    this.creating = true;
    this.failed = false;
    this.postsService.createAdminAccount(this.input).subscribe({
      next: res => {
        this.creating = false;
        if (res?.user) {
          this.dialogRef.close(true);
        } else {
          this.failed = true;
        }
      },
      error: () => {
        this.creating = false;
        this.failed = true;
      }
    });
  }

}
