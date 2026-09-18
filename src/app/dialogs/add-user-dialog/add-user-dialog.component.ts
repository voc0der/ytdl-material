import { Component, OnInit, ChangeDetectionStrategy } from '@angular/core';
import { PostsService } from 'app/posts.services';
import { MatDialogRef, MatDialogTitle, MatDialogContent, MatDialogActions, MatDialogClose } from '@angular/material/dialog';
import { CdkScrollable } from '@angular/cdk/scrolling';
import { MatIcon } from '@angular/material/icon';
import { FormsModule } from '@angular/forms';

@Component({
    selector: 'app-add-user-dialog',
    templateUrl: './add-user-dialog.component.html',
    styleUrls: ['./add-user-dialog.component.scss'],
    changeDetection: ChangeDetectionStrategy.Eager,
    host: { class: 'kit-dialog' },
    imports: [MatDialogTitle, CdkScrollable, MatDialogContent, MatIcon, FormsModule, MatDialogActions, MatDialogClose]
})
export class AddUserDialogComponent implements OnInit {

  usernameInput = '';
  passwordInput = '';

  constructor(private postsService: PostsService, public dialogRef: MatDialogRef<AddUserDialogComponent>) { }

  ngOnInit(): void {
  }

  createUser() {
    if (!this.usernameInput || !this.passwordInput) return;
    this.postsService.register(this.usernameInput, this.passwordInput).subscribe(res => {
      if (res['user']) {
        this.dialogRef.close(res['user']);
      } else {
        this.dialogRef.close({error: 'Unknown error'});
      }
    }, err => {
      this.dialogRef.close({error: err});
    });
  }

}
