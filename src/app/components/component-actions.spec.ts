import { of, Subject } from 'rxjs';

import { NotificationsListComponent } from './notifications-list/notifications-list.component';
import { SeeMoreComponent } from './see-more/see-more.component';
import { LogsViewerComponent } from './logs-viewer/logs-viewer.component';
import { AboutDialogComponent } from '../dialogs/about-dialog/about-dialog.component';
import { MediaLibraryNavigationStateService, MediaLibraryRestoreState } from '../media-library-navigation-state.service';
import { PickerComponent } from './picker/picker.component';
import { NotificationsComponent } from './notifications/notifications.component';

// Small actions that pass something on or flip a flag, built without a template.
describe('Component actions', () => {
  it('passes a notification\'s action and its removal up to the page', () => {
    const list = new NotificationsListComponent();
    const actions: unknown[] = [];
    const removed: string[] = [];
    list.notificationAction.subscribe(event => actions.push(event));
    list.deleteNotification.subscribe(uid => removed.push(uid));
    const notification = { uid: 'note-1' } as any;

    list.emitNotificationAction(notification, 'play' as any);
    list.emitDeleteNotification('note-1');

    expect(actions).toEqual([{ notification, action: 'play' }]);
    expect(removed).toEqual(['note-1']);
  });

  it('opens and closes a long description', () => {
    const see_more = new SeeMoreComponent();
    see_more.toggleSeeMore();
    expect(see_more.see_more_active).toBe(true);
    see_more.toggleSeeMore();
    expect(see_more.see_more_active).toBe(false);
  });

  it('says the logs were copied', () => {
    const posts = { openSnackBar: vi.fn() };
    new LogsViewerComponent(posts as any, {} as any).copiedLogsToClipboard();
    expect(posts.openSnackBar).toHaveBeenCalledWith('Logs copied to clipboard!');
  });

  it('shows the latest release once it has been looked up', () => {
    const release = { tag_name: 'v9.9.9' };
    const about = new AboutDialogComponent({ getLatestGithubRelease: () => of(release) } as any);
    expect(about.checking_for_updates).toBe(true);

    about.ngOnInit();

    expect(about.checking_for_updates).toBe(false);
    expect(about.latestGithubRelease).toBe(release);
  });

  it('marks the picked part in the picker\'s sheet, and switches to another one from it', () => {
    let data: any;
    const sheet = { open: vi.fn((component, config) => { data = config.data; return { afterDismissed: () => of(undefined) }; }) };
    const picker = new PickerComponent(sheet as any, {} as any);
    picker.segments = [{ value: 'video', label: 'Video' }, { value: 'audio', label: 'Audio' }] as any;
    picker.segment = 'video';
    const chosen: string[] = [];
    picker.segmentChange.subscribe(segment => chosen.push(segment));

    (picker as any).openSheet();

    expect(data.isSegmentSelected('video')).toBe(true);
    expect(data.isSegmentSelected('audio')).toBe(false);
    data.selectSegment('audio');
    data.selectSegment('audio');
    expect(chosen).toEqual(['audio']);
    expect(picker.expanded).toBe(false);
  });

  it('lists the kinds of notification in the order they are written', () => {
    const notifications = new NotificationsComponent({} as any, {} as any, {} as any);
    expect(notifications.originalOrder()).toBe(0);
  });

  describe('the library state kept for coming back from the player', () => {
    const state = (): MediaLibraryRestoreState => ({
      snapshot: { routeKey: '/', subId: null, selectedFilters: ['favorited'] } as any,
      files: [{ uid: 'file-1', chapters: [{ title: 'Intro', start_time: 0, end_time: 5 }] } as any],
      playlistLibraryItems: [{ id: 'playlist-1', uids: ['file-1'] } as any],
      playlistLibraryReceived: true
    });

    it('hands back a copy, so the page cannot change what was saved', () => {
      const service = new MediaLibraryNavigationStateService({
        files_changed: new Subject(), playlists_changed: new Subject(), library_changed: new Subject()
      } as any);
      const saved = state();
      service.savePendingRestoreState(saved);
      saved.files[0].chapters[0].title = 'Changed';
      saved.playlistLibraryItems[0].uids.push('file-2');

      const restored = service.consumePendingRestoreState('/', null);

      expect(restored.files[0].chapters[0].title).toBe('Intro');
      expect(restored.playlistLibraryItems[0].uids).toEqual(['file-1']);
      expect(service.consumePendingRestoreState('/', null)).toBeNull();
    });

    it('marks what changed while the player was open, and forgets it all when the library changes', () => {
      const files_changed = new Subject<boolean>();
      const playlists_changed = new Subject<boolean>();
      const library_changed = new Subject<void>();
      const service = new MediaLibraryNavigationStateService({ files_changed, playlists_changed, library_changed } as any);

      files_changed.next(true);
      service.savePendingRestoreState(state());
      files_changed.next(true);
      playlists_changed.next(true);
      const restored = service.consumePendingRestoreState('/', null);
      expect([restored.filesInvalidated, restored.playlistsInvalidated]).toEqual([true, true]);

      service.savePendingRestoreState(state());
      library_changed.next();
      expect(service.consumePendingRestoreState('/', null)).toBeNull();
    });
  });
});
