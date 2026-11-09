import { of, Subject, throwError } from 'rxjs';

import { CustomPlaylistsComponent } from './custom-playlists.component';
import { CreatePlaylistComponent } from '../../create-playlist/create-playlist.component';
import { PLAYER_NAVIGATOR_STORAGE_KEY } from '../../media-library-navigation-state.service';

describe('CustomPlaylistsComponent', () => {
  let component: CustomPlaylistsComponent;
  let dialogStub: any;
  let postsServiceStub: any;
  let routerStub: any;

  beforeEach(() => {
    postsServiceStub = {
      config: {
        Extra: {
          download_only_mode: false
        }
      },
      service_initialized: of(true),
      playlists_changed: { subscribe: () => ({ unsubscribe() { } }) },
      getPlaylists: vi.fn().mockName('getPlaylists').mockReturnValue(of({ playlists: [] })),
      downloadPlaylistFromServer: vi.fn(),
      removePlaylist: vi.fn().mockName('removePlaylist').mockReturnValue(of({
        success: true,
        playlist_removed: true,
        failed_file_count: 0
      })),
      openSnackBar: vi.fn().mockName('openSnackBar')
    };
    dialogStub = {
      open: vi.fn().mockName('open')
    };
    routerStub = {url: '/playlists', navigate: vi.fn()};
    component = new CustomPlaylistsComponent(postsServiceStub, routerStub, dialogStub);
    component.playlists = [{
        id: 'playlist-1',
        name: 'My playlist',
        uids: ['file-1', 'file-2']
      }] as any;
  });

  afterEach(() => {
    sessionStorage.removeItem(PLAYER_NAVIGATOR_STORAGE_KEY);
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('removes only the playlist when the default delete action is chosen', () => {
    dialogStub.open.mockReturnValue({ afterClosed: () => of('playlist_only') });
    const get_all_playlists_spy = vi.spyOn(component, 'getAllPlaylists').mockReturnValue(undefined);

    component.deletePlaylist({ file: component.playlists[0], index: 0 });

    expect(postsServiceStub.removePlaylist).toHaveBeenCalledWith('playlist-1', false);
    expect(component.playlists).toEqual([]);
    expect(postsServiceStub.openSnackBar).toHaveBeenCalledWith('Playlist successfully removed.');
    expect(get_all_playlists_spy).toHaveBeenCalled();
  });

  it('shows a partial failure message when some playlist file deletions fail', () => {
    postsServiceStub.removePlaylist.mockReturnValue(of({
      success: false,
      playlist_removed: true,
      failed_file_count: 2
    }));
    dialogStub.open.mockReturnValue({ afterClosed: () => of('playlist_and_files') });
    vi.spyOn(component, 'getAllPlaylists').mockReturnValue(undefined);

    component.deletePlaylist({ file: component.playlists[0], index: 0 });

    expect(postsServiceStub.removePlaylist).toHaveBeenCalledWith('playlist-1', true);
    expect(postsServiceStub.openSnackBar).toHaveBeenCalledWith('Playlist removed, but 2 file(s) could not be deleted.');
  });

  it('waits for initialization and refreshes category playlists when the collection changes', () => {
    const initialized = new Subject<boolean>();
    const changed = new Subject<boolean>();
    const response = new Subject<any>();
    postsServiceStub.service_initialized = initialized;
    postsServiceStub.playlists_changed = changed;
    postsServiceStub.getPlaylists.mockReturnValue(response);
    component.ngOnInit();
    initialized.next(false);
    changed.next(false);
    expect(postsServiceStub.getPlaylists).not.toHaveBeenCalled();

    initialized.next(true);
    initialized.next(true);
    expect(postsServiceStub.getPlaylists).toHaveBeenCalledExactlyOnceWith(true);
    expect(component.playlists_received).toBe(false);
    response.next({playlists: [{id: 'category', auto: true}]});
    response.complete();
    expect(component.playlists_received).toBe(true);
    expect(component.playlists).toEqual([{id: 'category', auto: true}]);

    changed.next(true);
    expect(postsServiceStub.getPlaylists).toHaveBeenCalledTimes(2);
    initialized.complete();
    changed.complete();
  });

  it('opens the editor with creation or existing playlist data', () => {
    component.openCreatePlaylistDialog();
    expect(dialogStub.open).toHaveBeenLastCalledWith(CreatePlaylistComponent,
      expect.objectContaining({data: {create_mode: true}}));
    component.editPlaylistDialog({playlist: component.playlists[0], index: 0});
    expect(dialogStub.open).toHaveBeenLastCalledWith(CreatePlaylistComponent,
      expect.objectContaining({data: {playlist_id: 'playlist-1'}}));
  });

  it.each([
    [{share_id: 'ShortList'}, {list: 'ShortList'}],
    [{auto: true}, {playlist_id: 'playlist-1', auto: true}]
  ])('opens a playlist and remembers the library to return to (%s)', (extra, queryParams) => {
    component.goToPlaylist({file: {...component.playlists[0], ...extra}});
    expect(routerStub.navigate).toHaveBeenCalledWith(['/'], {queryParams});
    expect(sessionStorage.getItem(PLAYER_NAVIGATOR_STORAGE_KEY)).toBe('/playlists');
  });

  it('downloads a zip in download-only mode and tracks the pending request', () => {
    vi.useFakeTimers();
    postsServiceStub.config.Extra.download_only_mode = true;
    const response = new Subject<Blob>();
    postsServiceStub.downloadPlaylistFromServer.mockReturnValue(response);
    const objectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:playlist');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const clicked: HTMLAnchorElement[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function(this: HTMLAnchorElement) {
      clicked.push(this);
    });
    component.goToPlaylist({file: component.playlists[0]});
    expect(postsServiceStub.downloadPlaylistFromServer).toHaveBeenCalledWith('playlist-1');
    expect(component.downloading_content['playlist-1']).toBe(true);
    expect(objectURL).not.toHaveBeenCalled();
    expect(routerStub.navigate).not.toHaveBeenCalled();

    const blob = new Blob(['playlist']);
    response.next(blob);
    response.complete();
    expect(objectURL).toHaveBeenCalledWith(blob);
    expect(clicked).toHaveLength(1);
    expect(clicked[0].download).toBe('My playlist.zip');
    expect(clicked[0].href).toBe('blob:playlist');
    expect(component.downloading_content['playlist-1']).toBe(false);
  });

  it('leaves the playlist alone when the deletion dialog is dismissed', () => {
    dialogStub.open.mockReturnValue({afterClosed: () => of(undefined)});
    component.deletePlaylist({file: component.playlists[0], index: 0});
    expect(postsServiceStub.removePlaylist).not.toHaveBeenCalled();
    expect(postsServiceStub.getPlaylists).not.toHaveBeenCalled();
    expect(component.playlists).toHaveLength(1);
  });

  it('removes the selected playlist with its files and refreshes the remaining collection', () => {
    const refresh = new Subject<any>();
    postsServiceStub.getPlaylists.mockReturnValue(refresh);
    dialogStub.open.mockReturnValue({afterClosed: () => of('playlist_and_files')});
    const other = {id: 'other', name: 'Keep me', uids: []};
    component.playlists.push(other);
    component.deletePlaylist({file: component.playlists[0], index: 0});
    expect(postsServiceStub.removePlaylist).toHaveBeenCalledWith('playlist-1', true);
    expect(component.playlists).toEqual([other]);
    expect(postsServiceStub.openSnackBar).toHaveBeenCalledWith('Playlist and files successfully removed.');
    expect(postsServiceStub.getPlaylists).toHaveBeenCalledWith(true);
    refresh.next({playlists: [other]});
    refresh.complete();
    expect(component.playlists_received).toBe(true);
  });

  describe.each(['playlist_only', 'playlist_and_files'])('failed deletion: %s', action => {
    it.each(['refused', 'offline'])('keeps the playlist and refreshes after a %s request', failure => {
      dialogStub.open.mockReturnValue({afterClosed: () => of(action)});
      postsServiceStub.removePlaylist.mockReturnValue(failure === 'refused'
        ? of({success: false}) : throwError(() => new Error('Offline')));
      const playlists = component.playlists;
      postsServiceStub.getPlaylists.mockReturnValue(of({playlists}));
      component.deletePlaylist({file: playlists[0], index: 0});
      expect(postsServiceStub.removePlaylist).toHaveBeenCalledWith('playlist-1', action === 'playlist_and_files');
      expect(component.playlists).toEqual(playlists);
      expect(postsServiceStub.openSnackBar).toHaveBeenCalledWith(action === 'playlist_and_files'
        ? 'Failed to remove playlist and files.' : 'Failed to remove playlist.');
      expect(postsServiceStub.getPlaylists).toHaveBeenCalledWith(true);
    });
  });
});
