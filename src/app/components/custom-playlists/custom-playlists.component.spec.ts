import { of } from 'rxjs';

import { CustomPlaylistsComponent } from './custom-playlists.component';

describe('CustomPlaylistsComponent', () => {
  let component: CustomPlaylistsComponent;
  let dialogStub: any;
  let postsServiceStub: any;

  beforeEach(() => {
    postsServiceStub = {
      config: {
        Extra: {
          download_only_mode: false
        }
      },
      service_initialized: of(true),
      playlists_changed: { subscribe: () => ({ unsubscribe() {} }) },
      getPlaylists: jasmine.createSpy('getPlaylists').and.returnValue(of({ playlists: [] })),
      removePlaylist: jasmine.createSpy('removePlaylist').and.returnValue(of({
        success: true,
        playlist_removed: true,
        failed_file_count: 0
      })),
      openSnackBar: jasmine.createSpy('openSnackBar')
    };
    dialogStub = {
      open: jasmine.createSpy('open')
    };
    component = new CustomPlaylistsComponent(postsServiceStub, {} as any, dialogStub);
    component.playlists = [{
      id: 'playlist-1',
      name: 'My playlist',
      uids: ['file-1', 'file-2']
    }] as any;
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('removes only the playlist when the default delete action is chosen', () => {
    dialogStub.open.and.returnValue({ afterClosed: () => of('playlist_only') });
    const get_all_playlists_spy = spyOn(component, 'getAllPlaylists');

    component.deletePlaylist({ file: component.playlists[0], index: 0 });

    expect(postsServiceStub.removePlaylist).toHaveBeenCalledWith('playlist-1', false);
    expect(component.playlists).toEqual([]);
    expect(postsServiceStub.openSnackBar).toHaveBeenCalledWith('Playlist successfully removed.');
    expect(get_all_playlists_spy).toHaveBeenCalled();
  });

  it('shows a partial failure message when some playlist file deletions fail', () => {
    postsServiceStub.removePlaylist.and.returnValue(of({
      success: false,
      playlist_removed: true,
      failed_file_count: 2
    }));
    dialogStub.open.and.returnValue({ afterClosed: () => of('playlist_and_files') });
    spyOn(component, 'getAllPlaylists');

    component.deletePlaylist({ file: component.playlists[0], index: 0 });

    expect(postsServiceStub.removePlaylist).toHaveBeenCalledWith('playlist-1', true);
    expect(postsServiceStub.openSnackBar).toHaveBeenCalledWith('Playlist removed, but 2 file(s) could not be deleted.');
  });
});
