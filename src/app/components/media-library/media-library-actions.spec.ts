import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MatDialog } from '@angular/material/dialog';
import { Router } from '@angular/router';
import { of, Subject, throwError } from 'rxjs';
import { DatabaseFile, Playlist } from 'api-types';
import { PostsService } from 'app/posts.services';
import { CreatePlaylistComponent } from 'app/create-playlist/create-playlist.component';
import { MediaLibraryNavigationStateService, PLAYER_NAVIGATOR_STORAGE_KEY } from 'app/media-library-navigation-state.service';
import { configureTestBed } from '../../../testing/test-bed';
import { MediaLibraryComponent } from './media-library.component';

describe('Media library actions', () => {
  let fixture: ComponentFixture<MediaLibraryComponent>;
  let component: MediaLibraryComponent;
  let posts: any;
  let router: any;
  let dialog: any;
  const file = { uid: 'clip', id: 'Road%20trip', title: 'Road trip', isAudio: false } as DatabaseFile;
  const playlist = { id: 'mix', name: 'Travel mix', uids: ['clip'] } as Playlist;

  beforeEach(async () => {
    localStorage.clear();
    sessionStorage.clear();
    posts = {
      config: { Extra: { download_only_mode: false, file_manager_enabled: true } },
      card_size: 'medium',
      categories: [],
      viewedLibraryUid: null,
      getAllFiles: vi.fn().mockReturnValue(of({ files: [], file_count: 0 })),
      getPlaylists: vi.fn().mockReturnValue(of({ playlists: [] })),
      addFileToPlaylist: vi.fn().mockReturnValue(of({ success: true })),
      removePlaylist: vi.fn().mockReturnValue(of({ success: true, playlist_removed: true })),
      deleteFile: vi.fn().mockReturnValue(of(true)),
      deleteSubscriptionFile: vi.fn().mockReturnValue(of({ success: true })),
      updateFile: vi.fn().mockReturnValue(of({ success: true })),
      downloadFileFromServer: vi.fn(),
      downloadPlaylistFromServer: vi.fn(),
      files_changed: new Subject<boolean>(),
      playlists_changed: new Subject<boolean>(),
      categories_changed: new Subject<boolean>(),
      library_changed: new Subject<void>(),
      openSnackBar: vi.fn()
    };
    router = {
      url: '/home',
      navigate: vi.fn(),
      createUrlTree: vi.fn().mockReturnValue('playlist-tree'),
      serializeUrl: vi.fn().mockReturnValue('/player;playlist_id=mix')
    };
    dialog = { open: vi.fn().mockReturnValue({ afterClosed: () => of(undefined) }) };
    await configureTestBed({
      imports: [MediaLibraryComponent],
      providers: [
        { provide: PostsService, useValue: posts },
        { provide: Router, useValue: router },
        { provide: MatDialog, useValue: dialog }
      ]
    }).compileComponents();
    fixture = TestBed.createComponent(MediaLibraryComponent);
    component = fixture.componentInstance;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    sessionStorage.clear();
  });

  describe('playlist listing', () => {
    const playlists = [
      { id: 'middle', name: 'bravo', registered: 300, duration: 10 },
      { id: 'last', name: 'Charlie', registered: 100, duration: 20 },
      { id: 'first', name: 'Alpha', registered: 200, duration: 30 }
    ] as Playlist[];
    const ascending = {
      registered: ['last', 'first', 'middle'],
      title: ['first', 'middle', 'last'],
      duration: ['middle', 'last', 'first']
    };

    for (const by of ['registered', 'title', 'duration']) {
      for (const order of [-1, 1]) {
        it(`sorts playlists by ${by} in ${order === -1 ? 'descending' : 'ascending'} order`, () => {
          component.activeLibraryTab = 1;
          component.playlistLibraryItems = playlists.slice();

          component.sortOptionChanged({ by, order });

          expect(component.visiblePlaylists.map(item => item.id)).toEqual(
            order === -1 ? ascending[by].slice().reverse() : ascending[by]
          );
          expect(component.playlistLibraryItems).toEqual(playlists);
          expect(posts.getAllFiles).not.toHaveBeenCalled();
          expect(localStorage.getItem('sort_property')).toBe(by);
          expect(localStorage.getItem(component.sortOrderStorageKey)).toBe(order === -1 ? 'descending' : 'ascending');
        });
      }
    }

    it('searches names without case or surrounding whitespace and preserves ties', () => {
      component.playlistLibraryItems = [
        { id: 'unnamed' },
        { id: 'first', name: 'Road trip' },
        { id: 'second', name: 'ROAD music' },
        { id: 'other', name: 'Chores' }
      ] as Playlist[];

      component.onPlaylistSearchInputChanged('  rOaD  ');
      expect(component.visiblePlaylists.map(item => item.id)).toEqual(['first', 'second']);
      component.clearPlaylistSearch();
      expect(component.visiblePlaylists).toEqual(component.playlistLibraryItems);
    });

    for (const by of ['title', 'duration', 'registered']) {
      it(`lists playlists with missing ${by} values`, () => {
        component.sortProperty = by;
        component.descendingMode = false;
        component.playlistLibraryItems = [playlists[0], { id: 'missing' } as Playlist];
        expect(component.visiblePlaylists.map(item => item.id)).toEqual(['missing', 'middle']);
      });
    }

    it('keeps playlist choices separate from the viewed subscription library', () => {
      const subscriptionPlaylist = { ...playlist, source_sub_id: 'sub-1' };
      posts.getPlaylists.mockReturnValue(of({ playlists: [playlist, subscriptionPlaylist] }));
      component.sub_id = 'sub-1';
      posts.viewedLibraryUid = 'another-user';

      component.getAllPlaylists();

      expect(posts.getPlaylists.mock.calls).toEqual([[], [false, null]]);
      expect(component.playlists).toEqual([playlist, subscriptionPlaylist]);
      expect(component.playlistLibraryItems).toEqual([subscriptionPlaylist]);
      expect(component.playlistLibraryReceived).toBe(true);
    });

    it('loads the playlist tab once and refreshes files when returning to them', () => {
      const response = new Subject<any>();
      posts.getPlaylists.mockReturnValue(response);
      component.libraryTabChanged(1);
      expect(component.playlistLibraryReceived).toBe(false);
      response.next({});
      response.complete();
      expect(component.playlistLibraryItems).toEqual([]);
      expect(component.playlistLibraryReceived).toBe(true);

      component.libraryTabChanged(1);
      expect(posts.getPlaylists).toHaveBeenCalledTimes(1);
      component.libraryTabChanged(0);
      expect(posts.getAllFiles).toHaveBeenCalledTimes(1);
      expect(localStorage.getItem(component.libraryTabStorageKey)).toBe('0');
    });
  });

  describe('navigation and editing', () => {
    it('remembers the library before opening a playlist in the player', () => {
      component.paged_data = [file];
      component.activeLibraryTab = 1;
      component.goToPlaylist({ file: playlist });

      expect(router.navigate).toHaveBeenCalledWith(['/player', { playlist_id: 'mix' }]);
      expect(sessionStorage.getItem(PLAYER_NAVIGATOR_STORAGE_KEY)).toBe('/home');
      const saved = TestBed.inject(MediaLibraryNavigationStateService).consumePendingRestoreState('/home', null);
      expect(saved.files).toEqual([file]);
      expect(saved.snapshot.activeLibraryTab).toBe(1);
    });

    it('opens an automatic shared playlist in a new tab without replacing return state', () => {
      const open = vi.spyOn(window, 'open').mockReturnValue(null);
      posts.viewedLibraryUid = 'owner';
      component.goToPlaylist({ file: { ...playlist, auto: true }, event: { ctrlKey: true } });

      expect(router.createUrlTree).toHaveBeenCalledWith(['/player', { playlist_id: 'mix', auto: 'true', library: 'owner' }]);
      expect(open).toHaveBeenCalledWith('/#/player;playlist_id=mix');
      expect(router.navigate).not.toHaveBeenCalled();
      expect(sessionStorage.getItem(PLAYER_NAVIGATOR_STORAGE_KEY)).toBeNull();
    });

    it('ignores a missing playlist', () => {
      component.goToPlaylist({ file: null });
      expect(router.navigate).not.toHaveBeenCalled();
      expect(posts.downloadPlaylistFromServer).not.toHaveBeenCalled();
    });

    it('opens a file with the current search and subscription queue', () => {
      component.sub_id = 'channel';
      component.search_mode = true;
      component.search_text = '  music  ';
      component.selectedFilters = ['audio_only', 'favorited'];
      component.descendingMode = false;

      component.goToFile({ file: { ...file, isAudio: true }, event: { ctrlKey: false } });

      expect(router.navigate).toHaveBeenCalledWith(['/player', {
        type: 'audio', uid: 'clip', queue_sort_by: 'registered', queue_sort_order: '1',
        queue_file_type_filter: 'audio_only', queue_favorite_filter: 'true',
        queue_search: 'music', queue_sub_id: 'channel'
      }]);
      component.goToSubscription({ ...file, sub_id: 'channel' });
      expect(router.navigate).toHaveBeenLastCalledWith(['/subscription', { id: 'channel' }]);
    });

    it('opens the playlist editor for creation and for the selected playlist', () => {
      component.openCreatePlaylistDialog();
      expect(dialog.open).toHaveBeenLastCalledWith(CreatePlaylistComponent, expect.objectContaining({ data: { create_mode: true } }));
      component.editPlaylistDialog({ playlist });
      expect(dialog.open).toHaveBeenLastCalledWith(CreatePlaylistComponent, expect.objectContaining({ data: { playlist_id: 'mix' } }));
    });

    for (const outcome of ['success', 'refused', 'error']) {
      it(`reports ${outcome} when adding a file to a playlist`, () => {
        component.playlists = [playlist];
        const changed = vi.fn();
        posts.playlists_changed.subscribe(changed);
        const error = new Error('unavailable');
        const log = vi.spyOn(console, 'error').mockReturnValue(undefined);
        posts.addFileToPlaylist.mockReturnValue(outcome === 'error'
          ? throwError(() => error) : of({ success: outcome === 'success' }));

        component.addFileToPlaylist({ file, playlist_id: playlist.id });

        expect(posts.addFileToPlaylist).toHaveBeenCalledWith('mix', 'clip');
        expect(posts.openSnackBar).toHaveBeenCalledWith(outcome === 'success'
          ? 'Successfully added Road trip to Travel mix!'
          : `Failed to add Road trip to Travel mix! ${outcome === 'refused' ? 'Unknown error.' : 'See browser console for error.'}`);
        expect(changed.mock.calls).toEqual(outcome === 'success' ? [[true]] : []);
        expect(log.mock.calls).toEqual(outcome === 'error' ? [[error]] : []);
      });
    }

    it('toggles a favorite both ways and saves each choice', () => {
      const item = { ...file, favorite: false };
      component.toggleFavorite(item);
      expect(item.favorite).toBe(true);
      component.toggleFavorite(item);
      expect(item.favorite).toBe(false);
      expect(posts.updateFile.mock.calls).toEqual([['clip', { favorite: true }], ['clip', { favorite: false }]]);
    });
  });

  describe('downloads', () => {
    let urls: { create: typeof URL.createObjectURL; revoke: typeof URL.revokeObjectURL };
    let click: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      vi.useFakeTimers();
      urls = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
      URL.createObjectURL = vi.fn(() => 'blob:download');
      URL.revokeObjectURL = vi.fn();
      click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
      posts.config.Extra.download_only_mode = true;
    });

    afterEach(() => {
      vi.runOnlyPendingTimers();
      vi.useRealTimers();
      URL.createObjectURL = urls.create;
      URL.revokeObjectURL = urls.revoke;
    });

    for (const isAudio of [false, true]) {
      it(`downloads a ${isAudio ? 'song' : 'video'} with its decoded filename`, () => {
        const response = new Subject<Blob>();
        posts.downloadFileFromServer.mockReturnValue(response);
        component.goToFile({ file: { ...file, isAudio }, event: { ctrlKey: false } });
        expect(component.downloading_content['clip']).toBe(true);
        expect(posts.downloadFileFromServer).toHaveBeenCalledWith('clip');

        const blob = new Blob(['media']);
        response.next(blob);
        response.complete();
        expect(component.downloading_content['clip']).toBe(false);
        expect(URL.createObjectURL).toHaveBeenCalledWith(blob);
        expect((click.mock.contexts[0] as HTMLAnchorElement).download).toBe(`Road trip.${isAudio ? 'mp3' : 'mp4'}`);
        expect(posts.deleteFile).not.toHaveBeenCalled();
        expect(router.navigate).not.toHaveBeenCalled();
      });
    }

    it('deletes a completed one-off download when the file manager is disabled', () => {
      posts.config.Extra.file_manager_enabled = false;
      const response = new Subject<Blob>();
      posts.downloadFileFromServer.mockReturnValue(response);
      component.downloadFile(file);
      expect(posts.deleteFile).not.toHaveBeenCalled();
      response.next(new Blob(['media']));
      response.complete();
      expect(posts.deleteFile).toHaveBeenCalledWith('clip');
      expect(posts.getAllFiles).toHaveBeenCalledTimes(1);
    });

    it('keeps subscription files when the file manager is disabled', () => {
      posts.config.Extra.file_manager_enabled = false;
      posts.downloadFileFromServer.mockReturnValue(of(new Blob(['media'])));
      component.downloadFile({ ...file, sub_id: 'channel' });
      expect(posts.deleteFile).not.toHaveBeenCalled();
    });

    it('downloads a playlist as a named zip in download-only mode', () => {
      const response = new Subject<Blob>();
      posts.downloadPlaylistFromServer.mockReturnValue(response);
      component.goToPlaylist({ file: playlist });
      expect(component.downloading_content['mix']).toBe(true);
      expect(posts.downloadPlaylistFromServer).toHaveBeenCalledWith('mix');
      const blob = new Blob(['zip']);
      response.next(blob);
      response.complete();
      expect(component.downloading_content['mix']).toBe(false);
      expect(URL.createObjectURL).toHaveBeenCalledWith(blob);
      expect((click.mock.contexts[0] as HTMLAnchorElement).download).toBe('Travel mix.zip');
      expect(router.navigate).not.toHaveBeenCalled();
    });
  });

  describe('deletion', () => {
    beforeEach(() => {
      component.paged_data = [file, { ...file, uid: 'other' }];
      component.playlists = [playlist];
      component.playlistLibraryItems = [playlist];
      // Keep the refresh pending so assertions see the immediate result of the action.
      posts.getAllFiles.mockReturnValue(new Subject());
      posts.getPlaylists.mockReturnValue(new Subject());
    });

    for (const blacklistMode of [false, true]) {
      it(`deletes a library file with blacklist mode ${blacklistMode}`, () => {
        component.deleteFile({ file, blacklistMode });
        expect(posts.deleteFile).toHaveBeenCalledWith('clip', blacklistMode);
        expect(component.paged_data.map(item => item.uid)).toEqual(['other']);
        expect(posts.openSnackBar).toHaveBeenCalledWith('Delete success!', 'OK.');
        expect(posts.getAllFiles).toHaveBeenCalledTimes(1);
      });

      it(`deletes a subscription file with blacklist mode ${blacklistMode}`, () => {
        component.deleteFile({ file: { ...file, sub_id: 'channel' }, blacklistMode });
        expect(posts.deleteSubscriptionFile).toHaveBeenCalledWith('clip', blacklistMode);
        expect(posts.deleteFile).not.toHaveBeenCalled();
        expect(component.paged_data.map(item => item.uid)).toEqual(['other']);
        expect(posts.openSnackBar).toHaveBeenCalledWith('Successfully deleted file: Road%20trip');
      });
    }

    for (const outcome of ['refused', 'error']) {
      it(`keeps the file card when deletion is ${outcome}`, () => {
        posts.deleteFile.mockReturnValue(outcome === 'error' ? throwError(() => new Error('offline')) : of(false));
        component.deleteFile({ file, blacklistMode: false });
        expect(component.paged_data.map(item => item.uid)).toEqual(['clip', 'other']);
        expect(posts.openSnackBar).toHaveBeenCalledWith('Delete failed!', 'OK.');
        expect(posts.getAllFiles).not.toHaveBeenCalled();
      });
    }

    it('keeps the new page intact when a deletion finishes after changing pages', () => {
      const response = new Subject<boolean>();
      posts.deleteFile.mockReturnValue(response);
      component.deleteFile({ file, blacklistMode: false });
      component.paged_data = [{ ...file, uid: 'new-page' }];

      response.next(true);
      response.complete();

      expect(component.paged_data.map(item => item.uid)).toEqual(['new-page']);
      expect(posts.getAllFiles).toHaveBeenCalledTimes(1);
    });

    it('leaves a playlist alone when its deletion dialog is cancelled', () => {
      component.deletePlaylist({ file: playlist, index: 0 });
      expect(dialog.open.mock.calls[0][1].data).toEqual({ playlistName: 'Travel mix', fileCount: 1 });
      expect(posts.removePlaylist).not.toHaveBeenCalled();
      expect(component.playlistLibraryItems).toEqual([playlist]);
    });

    it('removes a playlist and its files after confirmation', () => {
      dialog.open.mockReturnValue({ afterClosed: () => of('playlist_and_files') });
      component.deletePlaylist({ file: playlist, index: 0 });
      expect(posts.removePlaylist).toHaveBeenCalledWith('mix', true);
      expect(component.playlists).toEqual([]);
      expect(component.playlistLibraryItems).toEqual([]);
      expect(posts.getAllFiles).toHaveBeenCalledTimes(1);
      expect(posts.getPlaylists).toHaveBeenCalledTimes(2);
      expect(posts.openSnackBar).toHaveBeenCalledWith('Playlist and files successfully removed.');
    });

    for (const deleteFiles of [false, true]) {
      for (const outcome of ['refused', 'error']) {
        it(`keeps a playlist when deletion ${deleteFiles ? 'with' : 'without'} its files is ${outcome}`, () => {
          dialog.open.mockReturnValue({ afterClosed: () => of(deleteFiles ? 'playlist_and_files' : 'playlist_only') });
          posts.removePlaylist.mockReturnValue(outcome === 'error'
            ? throwError(() => new Error('offline')) : of({ success: false, playlist_removed: false }));
          component.deletePlaylist({ file: playlist, index: 0 });
          expect(component.playlists).toEqual([playlist]);
          expect(component.playlistLibraryItems).toEqual([playlist]);
          expect(posts.openSnackBar).toHaveBeenCalledWith(deleteFiles ? 'Failed to remove playlist and files.' : 'Failed to remove playlist.');
          expect(posts.getAllFiles).not.toHaveBeenCalled();
          expect(posts.getPlaylists).toHaveBeenCalledTimes(2);
        });
      }
    }
  });
});
