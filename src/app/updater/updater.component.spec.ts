import { of, throwError } from 'rxjs';
import { MatDialog } from '@angular/material/dialog';
import { PostsService } from 'app/posts.services';
import { UpdaterComponent } from './updater.component';

describe('UpdaterComponent', () => {
  let component: UpdaterComponent;
  let postsService: jasmine.SpyObj<PostsService>;
  let dialog: jasmine.SpyObj<MatDialog>;

  beforeEach(() => {
    postsService = jasmine.createSpyObj<PostsService>('PostsService', ['getAvailableRelease', 'updateServer']);
    dialog = jasmine.createSpyObj<MatDialog>('MatDialog', ['open']);
    component = new UpdaterComponent(postsService, dialog);
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('falls back to the current version when no releases are available', () => {
    postsService.getAvailableRelease.and.returnValue(of([]));

    component.getAvailableVersions();

    expect(component.selectedVersion).toBe('v1.0.0');
    expect(component.hasStableVersions).toBeFalse();
    expect(component.showCurrentVersionOption).toBeTrue();
    expect(component.currentVersionOptionValue).toBe('v1.0.0');
    expect(component.canUpdateSelectedVersion()).toBeFalse();
    expect(component.versionsLoaded).toBeTrue();
  });

  it('falls back to the current version when no stable release exists', () => {
    postsService.getAvailableRelease.and.returnValue(of([
      { tag_name: 'v1.0.1-rc1' },
      { tag_name: 'v1.0.1-rc0' }
    ]));

    component.getAvailableVersions();

    expect(component.selectedVersion).toBe('v1.0.0');
    expect(component.hasStableVersions).toBeFalse();
    expect(component.showCurrentVersionOption).toBeTrue();
    expect(component.canUpdateSelectedVersion()).toBeFalse();
  });

  it('selects the latest stable release when one exists', () => {
    postsService.getAvailableRelease.and.returnValue(of([
      { tag_name: 'v1.0.1' },
      { tag_name: 'v1.0.0' }
    ]));

    component.getAvailableVersions();

    expect(component.selectedVersion).toBe('v1.0.1');
    expect(component.hasStableVersions).toBeTrue();
    expect(component.showCurrentVersionOption).toBeFalse();
    expect(component.canUpdateSelectedVersion()).toBeTrue();
    expect(component.isSelectedVersionUpgrade()).toBeTrue();
  });

  it('treats equivalent tags with and without a v prefix as the same release', () => {
    postsService.getAvailableRelease.and.returnValue(of([
      { tag_name: '1.0.0' }
    ]));

    component.getAvailableVersions();

    expect(component.selectedVersion).toBe('1.0.0');
    expect(component.hasStableVersions).toBeTrue();
    expect(component.showCurrentVersionOption).toBeFalse();
    expect(component.canUpdateSelectedVersion()).toBeFalse();
    expect(component.isCurrentVersion('1.0.0')).toBeTrue();
  });

  it('shows nightly as the current option when the running build is nightly', () => {
    component.CURRENT_VERSION = 'nightly';
    postsService.getAvailableRelease.and.returnValue(of([
      { tag_name: 'v1.0.1' },
      { tag_name: 'v1.0.0' }
    ]));

    component.getAvailableVersions();

    expect(component.selectedVersion).toBe('nightly');
    expect(component.hasStableVersions).toBeTrue();
    expect(component.showCurrentVersionOption).toBeTrue();
    expect(component.currentVersionOptionValue).toBe('nightly');
    expect(component.canUpdateSelectedVersion()).toBeFalse();

    component.selectedVersion = 'v1.0.1';

    expect(component.canUpdateSelectedVersion()).toBeTrue();
    expect(component.isSelectedVersionDowngrade()).toBeTrue();
  });

  it('falls back to the current version when the release request fails', () => {
    postsService.getAvailableRelease.and.returnValue(throwError(() => new Error('request failed')));

    component.getAvailableVersions();

    expect(component.selectedVersion).toBe('v1.0.0');
    expect(component.hasStableVersions).toBeFalse();
    expect(component.showCurrentVersionOption).toBeTrue();
    expect(component.versionsLoaded).toBeTrue();
  });
});
