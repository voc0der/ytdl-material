import { Component, OnInit, ChangeDetectionStrategy } from '@angular/core';
import { PostsService } from 'app/posts.services';
import { CURRENT_VERSION } from 'app/consts';
import { MatDialogTitle, MatDialogContent, MatDialogActions, MatDialogClose } from '@angular/material/dialog';
import { CdkScrollable } from '@angular/cdk/scrolling';
import { MatDivider } from '@angular/material/list';
import { MatButton } from '@angular/material/button';

@Component({
    selector: 'app-about-dialog',
    templateUrl: './about-dialog.component.html',
    styleUrls: ['./about-dialog.component.scss'],
    changeDetection: ChangeDetectionStrategy.Eager,
    imports: [MatDialogTitle, CdkScrollable, MatDialogContent, MatDivider, MatDialogActions, MatButton, MatDialogClose]
})
export class AboutDialogComponent implements OnInit {

  projectLink = 'https://github.com/voc0der/ytdl-material';
  issuesLink = 'https://github.com/voc0der/ytdl-material/issues';
  latestUpdateLink = 'https://github.com/voc0der/ytdl-material/releases/latest'
  latestGithubRelease = null;
  checking_for_updates = true;

  current_version_tag = CURRENT_VERSION;

  constructor(public postsService: PostsService) { }

  ngOnInit(): void {
    this.getLatestGithubRelease();
  }

  getLatestGithubRelease() {
    this.postsService.getLatestGithubRelease().subscribe(res => {
      this.checking_for_updates = false;
      this.latestGithubRelease = res;
    });
  }
}
