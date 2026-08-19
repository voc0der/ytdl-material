import type { MockedObject } from "vitest";
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
  let postsService: MockedObject<PostsService>;
  let dialog: MockedObject<MatDialog>;
  const currentVersionTag = CURRENT_VERSION;
  const currentVersionWithoutPrefix = stripVersionPrefix(CURRENT_VERSION);
  const nextPatchVersion = getNextPatchVersion(CURRENT_VERSION);

  beforeEach(() => {
    postsService = {
      getAvailableRelease: vi.fn().mockName("PostsService.getAvailableRelease"),
      getVersionInfo: vi.fn().mockName("PostsService.getVersionInfo"),
      updateServer: vi.fn().mockName("PostsService.updateServer")
      // Only the methods the component touches are stubbed. jasmine.SpyObj allowed a
      // partial like this directly; MockedObject requires the whole surface, so cast.
    } as unknown as MockedObject<PostsService>;
    postsService.getVersionInfo.mockReturnValue(of({ version_info: { tag: currentVersionTag } } as any));
    dialog = {
      open: vi.fn().mockName("MatDialog.open")
    } as unknown as MockedObject<MatDialog>;
    component = new UpdaterComponent(postsService, dialog);
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('falls back to the current version when no releases are available', () => {
    postsService.getAvailableRelease.mockReturnValue(of([]));

    component.getAvailableVersions();

    expect(component.selectedVersion).toBe(currentVersionTag);
    expect(component.hasStableVersions).toBe(false);
    expect(component.showCurrentVersionOption).toBe(true);
    expect(component.currentVersionOptionValue).toBe(currentVersionTag);
    expect(component.canUpdateSelectedVersion()).toBe(false);
    expect(component.versionsLoaded).toBe(true);
  });

  it('falls back to the current version when no stable release exists', () => {
    postsService.getAvailableRelease.mockReturnValue(of([
      { tag_name: `${nextPatchVersion}-rc1` },
      { tag_name: `${nextPatchVersion}-rc0` }
    ]));

    component.getAvailableVersions();

    expect(component.selectedVersion).toBe(currentVersionTag);
    expect(component.hasStableVersions).toBe(false);
    expect(component.showCurrentVersionOption).toBe(true);
    expect(component.canUpdateSelectedVersion()).toBe(false);
  });

  it('selects the latest stable release when one exists', () => {
    postsService.getAvailableRelease.mockReturnValue(of([
      { tag_name: nextPatchVersion },
      { tag_name: currentVersionTag }
    ]));

    component.getAvailableVersions();

    expect(component.selectedVersion).toBe(nextPatchVersion);
    expect(component.hasStableVersions).toBe(true);
    expect(component.showCurrentVersionOption).toBe(false);
    expect(component.canUpdateSelectedVersion()).toBe(true);
    expect(component.isSelectedVersionUpgrade()).toBe(true);
  });

  it('treats equivalent tags with and without a v prefix as the same release', () => {
    postsService.getAvailableRelease.mockReturnValue(of([
      { tag_name: currentVersionWithoutPrefix }
    ]));

    component.getAvailableVersions();

    expect(component.selectedVersion).toBe(currentVersionWithoutPrefix);
    expect(component.hasStableVersions).toBe(true);
    expect(component.showCurrentVersionOption).toBe(false);
    expect(component.canUpdateSelectedVersion()).toBe(false);
    expect(component.isCurrentVersion(currentVersionWithoutPrefix)).toBe(true);
  });

  it('loads the runtime nightly tag before selecting available versions', () => {
    postsService.getAvailableRelease.mockReturnValue(of([
      { tag_name: nextPatchVersion },
      { tag_name: currentVersionTag }
    ]));
    postsService.getVersionInfo.mockReturnValue(of({ version_info: { tag: 'nightly' } } as any));

    component.ngOnInit();

    expect(postsService.getVersionInfo).toHaveBeenCalled();
    expect(component.selectedVersion).toBe('nightly');
    expect(component.hasStableVersions).toBe(true);
    expect(component.showCurrentVersionOption).toBe(true);
    expect(component.currentVersionOptionValue).toBe('nightly');
    expect(component.canUpdateSelectedVersion()).toBe(false);

    component.selectedVersion = nextPatchVersion;

    expect(component.canUpdateSelectedVersion()).toBe(true);
    expect(component.isSelectedVersionDowngrade()).toBe(true);
  });

  it('uses the cached runtime version tag when version info is already loaded', () => {
    postsService.version_info = { tag: 'nightly' } as any;
    postsService.getAvailableRelease.mockReturnValue(of([
      { tag_name: nextPatchVersion },
      { tag_name: currentVersionTag }
    ]));

    component.ngOnInit();

    expect(postsService.getVersionInfo).not.toHaveBeenCalled();
    expect(component.selectedVersion).toBe('nightly');
    expect(component.currentVersionOptionValue).toBe('nightly');
  });

  it('falls back to the current version when the release request fails', () => {
    postsService.getAvailableRelease.mockReturnValue(throwError(() => new Error('request failed')));

    component.getAvailableVersions();

    expect(component.selectedVersion).toBe(currentVersionTag);
    expect(component.hasStableVersions).toBe(false);
    expect(component.showCurrentVersionOption).toBe(true);
    expect(component.versionsLoaded).toBe(true);
  });
});
