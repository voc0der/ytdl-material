import { Component, OnInit, ChangeDetectionStrategy } from '@angular/core';
import { PostsService } from 'app/posts.services';
import { MatDialogRef, MatDialogTitle, MatDialogContent, MatDialogActions, MatDialogClose } from '@angular/material/dialog';
import { CdkScrollable } from '@angular/cdk/scrolling';
import { MatFormField, MatLabel, MatInput } from '@angular/material/input';
import { FormsModule } from '@angular/forms';
import { MatButton } from '@angular/material/button';

@Component({
    selector: 'app-add-user-dialog',
    templateUrl: './add-user-dialog.component.html',
    styleUrls: ['./add-user-dialog.component.scss'],
    changeDetection: ChangeDetectionStrategy.Eager,
    imports: [MatDialogTitle, CdkScrollable, MatDialogContent, MatFormField, MatLabel, MatInput, FormsModule, MatDialogActions, MatButton, MatDialogClose]
})
export class AddUserDialogComponent implements OnInit {

  usernameInput = '';
  passwordInput = '';

  constructor(private postsService: PostsService, public dialogRef: MatDialogRef<AddUserDialogComponent>) { }

  ngOnInit(): void {
  }

  createUser() {
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
