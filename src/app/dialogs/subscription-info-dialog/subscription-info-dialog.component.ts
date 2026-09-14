import { Component, OnInit, Inject, ChangeDetectionStrategy } from '@angular/core';
import { MatDialog, MatDialogRef, MAT_DIALOG_DATA, MatDialogTitle, MatDialogContent, MatDialogActions, MatDialogClose } from '@angular/material/dialog';
import { PostsService } from 'app/posts.services';
import { ConfirmDialogComponent } from '../confirm-dialog/confirm-dialog.component';
import { Subscription } from 'api-types';
import { saveBlob } from '../../utils/save-blob';
import { CdkScrollable } from '@angular/cdk/scrolling';
import { MatButton } from '@angular/material/button';

@Component({
    selector: 'app-subscription-info-dialog',
    templateUrl: './subscription-info-dialog.component.html',
    styleUrls: ['./subscription-info-dialog.component.scss'],
    changeDetection: ChangeDetectionStrategy.Eager,
    imports: [MatDialogTitle, CdkScrollable, MatDialogContent, MatDialogActions, MatButton, MatDialogClose]
})
export class SubscriptionInfoDialogComponent implements OnInit {

  sub: Subscription = null;
  unsubbedEmitter = null;

  constructor(public dialogRef: MatDialogRef<SubscriptionInfoDialogComponent>,
    @Inject(MAT_DIALOG_DATA) public data: any, private postsService: PostsService,
    private dialog: MatDialog) { }

  ngOnInit() {
    if (this.data) {
      this.sub = this.data.sub;
      this.unsubbedEmitter = this.data.unsubbedEmitter;
    }
  }

  confirmUnsubscribe() {
    const dialogRef = this.dialog.open(ConfirmDialogComponent, {
      data: {
        dialogTitle: $localize`Unsubscribe from ${this.sub['name']}:subscription name:`,
        dialogText: $localize`Would you like to unsubscribe from ${this.sub['name']}:subscription name:?`,
        submitText: $localize`Unsubscribe`,
        warnSubmitColor: true
      }
    });
    dialogRef.afterClosed().subscribe(confirmed => {
      if (confirmed) {
        this.unsubscribe();
      }
    });
  }

  unsubscribe() {
    this.postsService.unsubscribe(this.sub.id, true).subscribe(res => {
      this.unsubbedEmitter.emit(true);
      this.dialogRef.close();
    });
  }

  downloadArchive() {
    this.postsService.downloadArchive(null, this.sub.id).subscribe(res => {
      const blob: Blob = res;
      saveBlob(blob, 'archive.txt');
    });
  }

}
