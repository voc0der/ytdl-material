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

  it('falls back to nightly when no releases are available', () => {
    postsService.getAvailableRelease.and.returnValue(of([]));

    component.getAvailableVersions();

    expect(component.selectedVersion).toBe('nightly');
    expect(component.hasStableVersions).toBeFalse();
    expect(component.canUpdateSelectedVersion()).toBeFalse();
    expect(component.versionsLoaded).toBeTrue();
  });

  it('falls back to nightly when no stable release exists', () => {
    postsService.getAvailableRelease.and.returnValue(of([
      { tag_name: '4.3.3-rc1' },
      { tag_name: '4.3.3-rc0' }
    ]));

    component.getAvailableVersions();

    expect(component.selectedVersion).toBe('nightly');
    expect(component.hasStableVersions).toBeFalse();
    expect(component.canUpdateSelectedVersion()).toBeFalse();
  });

  it('selects the latest stable release when one exists', () => {
    postsService.getAvailableRelease.and.returnValue(of([
      { tag_name: '4.3.3' },
      { tag_name: '4.3.2' }
    ]));

    component.getAvailableVersions();

    expect(component.selectedVersion).toBe('4.3.3');
    expect(component.hasStableVersions).toBeTrue();
    expect(component.canUpdateSelectedVersion()).toBeTrue();
  });

  it('falls back to nightly when the release request fails', () => {
    postsService.getAvailableRelease.and.returnValue(throwError(() => new Error('request failed')));

    component.getAvailableVersions();

    expect(component.selectedVersion).toBe('nightly');
    expect(component.hasStableVersions).toBeFalse();
    expect(component.versionsLoaded).toBeTrue();
  });
});
