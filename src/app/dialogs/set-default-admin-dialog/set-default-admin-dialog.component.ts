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
  input = '';
  constructor(private postsService: PostsService, public dialogRef: MatDialogRef<SetDefaultAdminDialogComponent>) { }

  ngOnInit(): void {
  }

  create() {
    if (!this.input || this.creating) return;
    this.creating = true;
    this.postsService.createAdminAccount(this.input).subscribe(res => {
      this.creating = false;
      if (res['success']) {
        this.dialogRef.close(true);
      } else {
        this.dialogRef.close(false);
      }
    }, err => {
      console.log(err);
      this.dialogRef.close(false);
    });
  }

}
