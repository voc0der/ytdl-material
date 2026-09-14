import { Component, OnInit, ChangeDetectionStrategy } from '@angular/core';
import { PostsService } from 'app/posts.services';
import { MatDialogRef, MatDialogTitle, MatDialogContent, MatDialogActions } from '@angular/material/dialog';
import { CdkScrollable } from '@angular/cdk/scrolling';
import { MatFormField, MatLabel, MatInput } from '@angular/material/input';
import { FormsModule } from '@angular/forms';
import { MatButton } from '@angular/material/button';
import { MatProgressSpinner } from '@angular/material/progress-spinner';

@Component({
    selector: 'app-set-default-admin-dialog',
    templateUrl: './set-default-admin-dialog.component.html',
    styleUrls: ['./set-default-admin-dialog.component.scss'],
    changeDetection: ChangeDetectionStrategy.Eager,
    imports: [MatDialogTitle, CdkScrollable, MatDialogContent, MatFormField, MatLabel, MatInput, FormsModule, MatDialogActions, MatButton, MatProgressSpinner]
})
export class SetDefaultAdminDialogComponent implements OnInit {
  creating = false;
  input = '';
  constructor(private postsService: PostsService, public dialogRef: MatDialogRef<SetDefaultAdminDialogComponent>) { }

  ngOnInit(): void {
  }

  create() {
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
