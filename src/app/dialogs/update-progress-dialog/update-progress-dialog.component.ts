import { Component, OnInit, ChangeDetectionStrategy } from '@angular/core';
import { PostsService } from 'app/posts.services';
import { UpdaterStatus } from '../../../api-types';
import { MatDialogTitle, MatDialogContent, MatDialogActions, MatDialogClose } from '@angular/material/dialog';
import { CdkScrollable } from '@angular/cdk/scrolling';
import { MatProgressBar } from '@angular/material/progress-bar';
import { MatButton } from '@angular/material/button';

@Component({
    selector: 'app-update-progress-dialog',
    templateUrl: './update-progress-dialog.component.html',
    styleUrls: ['./update-progress-dialog.component.scss'],
    changeDetection: ChangeDetectionStrategy.Eager,
    imports: [MatDialogTitle, CdkScrollable, MatDialogContent, MatProgressBar, MatDialogActions, MatButton, MatDialogClose]
})
export class UpdateProgressDialogComponent implements OnInit {

  updateStatus: UpdaterStatus = null;
  updateInterval = 250;
  errored = false;

  constructor(private postsService: PostsService) { }

  ngOnInit(): void {
    this.getUpdateProgress();
    setInterval(() => {
      if (this.updateStatus['updating']) { this.getUpdateProgress(); }
    }, 250);
  }

  getUpdateProgress() {
    this.postsService.getUpdaterStatus().subscribe(res => {
      if (res) {
        this.updateStatus = res;
        if (this.updateStatus && this.updateStatus['error']) {
          this.postsService.openSnackBar($localize`Update failed. Check logs for more details.`);
        }
      }
    });
  }
}
