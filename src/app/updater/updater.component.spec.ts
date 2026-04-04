import { of, throwError } from 'rxjs';
import { MatDialog } from '@angular/material/dialog';
import { PostsService } from 'app/posts.services';
import { CURRENT_VERSION } from 'app/consts';
import { UpdaterComponent } from './updater.component';

function stripVersionPrefix(tag: string): string {
  return tag.replace(/^v/i, '');
}

function getNextPatchVersion(tag: string): string {
  const match = stripVersionPrefix(tag).match(/^(\d+)\.(\d+)\.(\d+)$/);

  if (!match) {
    throw new Error(`Unexpected CURRENT_VERSION format: ${tag}`);
  }

  return `v${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

describe('UpdaterComponent', () => {
  let component: UpdaterComponent;
  let postsService: jasmine.SpyObj<PostsService>;
  let dialog: jasmine.SpyObj<MatDialog>;
  const currentVersionTag = CURRENT_VERSION;
  const currentVersionWithoutPrefix = stripVersionPrefix(CURRENT_VERSION);
  const nextPatchVersion = getNextPatchVersion(CURRENT_VERSION);

  beforeEach(() => {
    postsService = jasmine.createSpyObj<PostsService>('PostsService', ['getAvailableRelease', 'getVersionInfo', 'updateServer']);
    postsService.getVersionInfo.and.returnValue(of({ version_info: { tag: currentVersionTag } } as any));
    dialog = jasmine.createSpyObj<MatDialog>('MatDialog', ['open']);
    component = new UpdaterComponent(postsService, dialog);
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('falls back to the current version when no releases are available', () => {
    postsService.getAvailableRelease.and.returnValue(of([]));

    component.getAvailableVersions();

    expect(component.selectedVersion).toBe(currentVersionTag);
    expect(component.hasStableVersions).toBeFalse();
    expect(component.showCurrentVersionOption).toBeTrue();
    expect(component.currentVersionOptionValue).toBe(currentVersionTag);
    expect(component.canUpdateSelectedVersion()).toBeFalse();
    expect(component.versionsLoaded).toBeTrue();
  });

  it('falls back to the current version when no stable release exists', () => {
    postsService.getAvailableRelease.and.returnValue(of([
      { tag_name: `${nextPatchVersion}-rc1` },
      { tag_name: `${nextPatchVersion}-rc0` }
    ]));

    component.getAvailableVersions();

    expect(component.selectedVersion).toBe(currentVersionTag);
    expect(component.hasStableVersions).toBeFalse();
    expect(component.showCurrentVersionOption).toBeTrue();
    expect(component.canUpdateSelectedVersion()).toBeFalse();
  });

  it('selects the latest stable release when one exists', () => {
    postsService.getAvailableRelease.and.returnValue(of([
      { tag_name: nextPatchVersion },
      { tag_name: currentVersionTag }
    ]));

    component.getAvailableVersions();

    expect(component.selectedVersion).toBe(nextPatchVersion);
    expect(component.hasStableVersions).toBeTrue();
    expect(component.showCurrentVersionOption).toBeFalse();
    expect(component.canUpdateSelectedVersion()).toBeTrue();
    expect(component.isSelectedVersionUpgrade()).toBeTrue();
  });

  it('treats equivalent tags with and without a v prefix as the same release', () => {
    postsService.getAvailableRelease.and.returnValue(of([
      { tag_name: currentVersionWithoutPrefix }
    ]));

    component.getAvailableVersions();

    expect(component.selectedVersion).toBe(currentVersionWithoutPrefix);
    expect(component.hasStableVersions).toBeTrue();
    expect(component.showCurrentVersionOption).toBeFalse();
    expect(component.canUpdateSelectedVersion()).toBeFalse();
    expect(component.isCurrentVersion(currentVersionWithoutPrefix)).toBeTrue();
  });

  it('loads the runtime nightly tag before selecting available versions', () => {
    postsService.getAvailableRelease.and.returnValue(of([
      { tag_name: nextPatchVersion },
      { tag_name: currentVersionTag }
    ]));
    postsService.getVersionInfo.and.returnValue(of({ version_info: { tag: 'nightly' } } as any));

    component.ngOnInit();

    expect(postsService.getVersionInfo).toHaveBeenCalled();
    expect(component.selectedVersion).toBe('nightly');
    expect(component.hasStableVersions).toBeTrue();
    expect(component.showCurrentVersionOption).toBeTrue();
    expect(component.currentVersionOptionValue).toBe('nightly');
    expect(component.canUpdateSelectedVersion()).toBeFalse();

    component.selectedVersion = nextPatchVersion;

    expect(component.canUpdateSelectedVersion()).toBeTrue();
    expect(component.isSelectedVersionDowngrade()).toBeTrue();
  });

  it('uses the cached runtime version tag when version info is already loaded', () => {
    postsService.version_info = { tag: 'nightly' } as any;
    postsService.getAvailableRelease.and.returnValue(of([
      { tag_name: nextPatchVersion },
      { tag_name: currentVersionTag }
    ]));

    component.ngOnInit();

    expect(postsService.getVersionInfo).not.toHaveBeenCalled();
    expect(component.selectedVersion).toBe('nightly');
    expect(component.currentVersionOptionValue).toBe('nightly');
  });

  it('falls back to the current version when the release request fails', () => {
    postsService.getAvailableRelease.and.returnValue(throwError(() => new Error('request failed')));

    component.getAvailableVersions();

    expect(component.selectedVersion).toBe(currentVersionTag);
    expect(component.hasStableVersions).toBeFalse();
    expect(component.showCurrentVersionOption).toBeTrue();
    expect(component.versionsLoaded).toBeTrue();
  });
});
