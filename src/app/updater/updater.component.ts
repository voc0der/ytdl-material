import { Component, OnInit } from '@angular/core';
import { PostsService } from 'app/posts.services';
import { CURRENT_VERSION } from 'app/consts';
import { MatDialog } from '@angular/material/dialog';
import { UpdateProgressDialogComponent } from 'app/dialogs/update-progress-dialog/update-progress-dialog.component';
@Component({
    selector: 'app-updater',
    templateUrl: './updater.component.html',
    styleUrls: ['./updater.component.scss'],
    standalone: false
})
export class UpdaterComponent implements OnInit {

  readonly NIGHTLY_VERSION_LABEL = 'nightly';
  availableVersions = [];
  availableVersionsFiltered = [];
  versionsShowLimit = 5;
  versionsLoaded = false;
  latestStableRelease = null;
  selectedVersion = null;
  CURRENT_VERSION = CURRENT_VERSION;

  constructor(private postsService: PostsService, private dialog: MatDialog) { }

  ngOnInit(): void {
    this.getAvailableVersions();
  }

  updateServer() {
    this.postsService.updateServer(this.selectedVersion).subscribe(res => {
      if (res['success']) {
        this.openUpdateProgressDialog();
      }
    });
  }

  get hasStableVersions(): boolean {
    return !!this.latestStableRelease && this.availableVersionsFiltered.length > 0;
  }

  canUpdateSelectedVersion(): boolean {
    return this.hasStableVersions && !!this.selectedVersion && this.selectedVersion !== CURRENT_VERSION;
  }

  setNightlyFallback(): void {
    this.latestStableRelease = null;
    this.availableVersionsFiltered = [];
    this.selectedVersion = this.NIGHTLY_VERSION_LABEL;
  }

  getAvailableVersions() {
    this.versionsLoaded = false;
    this.latestStableRelease = null;
    this.selectedVersion = null;
    this.availableVersionsFiltered = [];
    this.postsService.getAvailableRelease().subscribe({
      next: res => {
        this.availableVersions = Array.isArray(res) ? res : [];
        for (let i = 0; i < this.availableVersions.length; i++) {
          const currentVersion = this.availableVersions[i];
          // if a stable release has not been found and the version is not "rc" (meaning it's stable) then set it as the stable release
          if (!this.latestStableRelease && !currentVersion.tag_name.includes('rc')) {
            this.latestStableRelease = currentVersion;
            this.selectedVersion = this.latestStableRelease.tag_name;
          }

          if (this.latestStableRelease && i >= this.versionsShowLimit) {
            break;
          }

          this.availableVersionsFiltered.push(currentVersion);
        }

        if (!this.hasStableVersions) {
          this.setNightlyFallback();
        }

        this.versionsLoaded = true;
      },
      error: () => {
        this.availableVersions = [];
        this.setNightlyFallback();
        this.versionsLoaded = true;
      }
    });
  }

  openUpdateProgressDialog() {
    this.dialog.open(UpdateProgressDialogComponent, {
      minWidth: '300px',
      minHeight: '200px'
    });
  }

}
