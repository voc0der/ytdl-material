import { Component, OnInit } from '@angular/core';
import { PostsService } from 'app/posts.services';
import { CURRENT_VERSION } from 'app/consts';
import { MatDialog } from '@angular/material/dialog';
import { UpdateProgressDialogComponent } from 'app/dialogs/update-progress-dialog/update-progress-dialog.component';

type ParsedReleaseVersion = {
  major: number;
  minor: number;
  patch: number;
  prerelease: number | null;
};

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
    this.loadCurrentVersionAndAvailableVersions();
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

  get currentVersionTag(): string {
    return this.postsService.version_info?.tag || this.CURRENT_VERSION;
  }

  canUpdateSelectedVersion(): boolean {
    return this.hasStableVersions && !!this.selectedVersion && this.compareReleaseVersions(this.selectedVersion, this.currentVersionTag) !== 0;
  }

  isCurrentVersion(tagName: string): boolean {
    return this.compareReleaseVersions(tagName, this.currentVersionTag) === 0;
  }

  isSelectedVersionUpgrade(): boolean {
    return this.compareReleaseVersions(this.selectedVersion, this.currentVersionTag) > 0;
  }

  isSelectedVersionDowngrade(): boolean {
    return this.compareReleaseVersions(this.selectedVersion, this.currentVersionTag) < 0;
  }

  get showCurrentVersionOption(): boolean {
    return !this.hasStableVersions || this.isNightlyVersion(this.currentVersionTag);
  }

  get currentVersionOptionValue(): string {
    return this.isNightlyVersion(this.currentVersionTag) ? this.NIGHTLY_VERSION_LABEL : this.currentVersionTag;
  }

  get currentVersionOptionLabel(): string {
    return `${this.currentVersionOptionValue} - Current Version`;
  }

  isNightlyVersion(tag: string | null): boolean {
    return String(tag || '').trim().toLowerCase() === this.NIGHTLY_VERSION_LABEL;
  }

  compareReleaseVersions(a: string | null, b: string | null): number {
    if (this.isNightlyVersion(a) && this.isNightlyVersion(b)) {
      return 0;
    }

    if (this.isNightlyVersion(a)) {
      return 1;
    }

    if (this.isNightlyVersion(b)) {
      return -1;
    }

    const parsedA = this.parseReleaseVersion(a);
    const parsedB = this.parseReleaseVersion(b);

    if (!parsedA || !parsedB) {
      return String(a || '').localeCompare(String(b || ''), undefined, { numeric: true, sensitivity: 'base' });
    }

    const numericFields: Array<keyof ParsedReleaseVersion> = ['major', 'minor', 'patch'];
    for (const field of numericFields) {
      if (parsedA[field] !== parsedB[field]) {
        return parsedA[field] - parsedB[field];
      }
    }

    if (parsedA.prerelease === parsedB.prerelease) {
      return 0;
    }

    if (parsedA.prerelease === null) {
      return 1;
    }

    if (parsedB.prerelease === null) {
      return -1;
    }

    return parsedA.prerelease - parsedB.prerelease;
  }

  private parseReleaseVersion(tag: string | null): ParsedReleaseVersion | null {
    if (!tag) {
      return null;
    }

    const match = tag.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-rc(\d+))?$/i);
    if (!match) {
      return null;
    }

    return {
      major: Number(match[1]),
      minor: Number(match[2]),
      patch: Number(match[3]),
      prerelease: match[4] === undefined ? null : Number(match[4])
    };
  }

  setCurrentVersionFallback(): void {
    this.latestStableRelease = null;
    this.availableVersionsFiltered = [];
    this.selectedVersion = this.currentVersionOptionValue;
  }

  loadCurrentVersionAndAvailableVersions(): void {
    if (this.postsService.version_info?.tag) {
      this.getAvailableVersions();
      return;
    }

    this.postsService.getVersionInfo().subscribe({
      next: res => {
        this.postsService.version_info = res['version_info'] || this.postsService.version_info;
        this.getAvailableVersions();
      },
      error: () => {
        this.getAvailableVersions();
      }
    });
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
          this.setCurrentVersionFallback();
        } else if (this.isNightlyVersion(this.currentVersionTag)) {
          this.selectedVersion = this.NIGHTLY_VERSION_LABEL;
        }

        this.versionsLoaded = true;
      },
      error: () => {
        this.availableVersions = [];
        this.setCurrentVersionFallback();
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
