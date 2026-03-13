import { MainComponent } from './main.component';
import { of } from 'rxjs';

describe('MainComponent', () => {
  let component: MainComponent;

  beforeEach(() => {
    const posts_service_mock: any = {
      config: {
        Extra: {
          file_manager_enabled: false,
          download_only_mode: false,
          force_autoplay: false,
          allow_quality_select: false
        },
        Downloader: {
          custom_args: ''
        },
        API: {},
        Advanced: {
          allow_advanced_download: false,
          use_default_downloading_agent: true,
          custom_downloading_agent: ''
        }
      },
      hasPermission: () => true,
      getCurrentDownload: () => of({download: null}),
      openSnackBar: () => {},
      config_reloaded: of(false),
      service_initialized: of(true),
      initialized: true
    };
    const youtube_search_mock: any = { initializeAPI: () => {} };
    const snack_bar_mock: any = { open: () => {} };
    const router_mock: any = { navigate: () => {} };
    const dialog_mock: any = { open: () => ({ afterClosed: () => of(null) }) };
    const platform_mock: any = { IOS: false };
    const route_mock: any = { snapshot: { paramMap: { get: () => null } } };

    component = new MainComponent(
      posts_service_mock,
      youtube_search_mock,
      snack_bar_mock,
      router_mock,
      dialog_mock,
      platform_mock,
      route_mock
    );
  });

  it('should create component instance', () => {
    expect(component).toBeTruthy();
  });

  it('keeps polling state for unfinished downloads even when percent is null', () => {
    const api_download = {
      uid: 'download-1',
      percent_complete: null,
      finished: false,
      error: null
    };
    (component as any).postsService.getCurrentDownload = () => of({download: api_download});
    component.current_download = {uid: 'download-1'} as any;
    component.downloadingfile = true;

    component.getCurrentDownload();

    expect(component.current_download).toEqual(api_download as any);
    expect(component.downloadingfile).toBeTrue();
  });

  it('reloads videos when a finished download has no container metadata', () => {
    const api_download = {
      uid: 'download-2',
      percent_complete: 100,
      finished: true,
      error: null,
      file_uids: null,
      type: 'video',
      container: null
    };
    const reload_spy = spyOn(component, 'reloadMediaLibrary');
    const helper_spy = spyOn(component, 'downloadHelper');
    (component as any).postsService.getCurrentDownload = () => of({download: api_download});
    component.current_download = {uid: 'download-2'} as any;
    component.downloadingfile = true;

    component.getCurrentDownload();

    expect(helper_spy).not.toHaveBeenCalled();
    expect(reload_spy).toHaveBeenCalledWith(false);
    expect(component.downloadingfile).toBeFalse();
    expect(component.current_download).toBeNull();
  });

  it('routes finished downloads through downloadHelper when metadata is present', () => {
    const api_download = {
      uid: 'download-3',
      percent_complete: 100,
      finished: true,
      error: null,
      file_uids: ['file-1'],
      type: 'video',
      container: {uid: 'file-1'}
    };
    const helper_spy = spyOn(component, 'downloadHelper');
    (component as any).postsService.getCurrentDownload = () => of({download: api_download});
    component.current_download = {uid: 'download-3'} as any;

    component.getCurrentDownload();

    expect(helper_spy).toHaveBeenCalledWith(api_download.container as any, 'video', false, false);
    expect(component.current_download).toBeNull();
  });

  it('advances to the next queued download after a finished item without container metadata', () => {
    const api_download = {
      uid: 'download-4',
      percent_complete: 100,
      finished: true,
      error: null,
      file_uids: ['file-1', 'file-2'],
      type: 'video',
      container: null
    };
    const reload_spy = spyOn(component, 'reloadMediaLibrary');
    (component as any).postsService.getCurrentDownload = () => of({download: api_download});
    component.current_download = {uid: 'download-4'} as any;
    component.downloads = [{uid: 'download-4'} as any, {uid: 'download-5'} as any];
    component.download_uids = ['download-4', 'download-5'];

    component.getCurrentDownload();

    expect(component.download_uids).toEqual(['download-5']);
    expect(component.current_download && component.current_download.uid).toBe('download-5');
    expect(reload_spy).not.toHaveBeenCalled();
  });

  it('removes finished errored downloads and continues polling remaining queue', () => {
    const api_download = {
      uid: 'download-6',
      percent_complete: 100,
      finished: true,
      error: 'failed',
      file_uids: null,
      type: 'video',
      container: null
    };
    (component as any).postsService.getCurrentDownload = () => of({download: api_download});
    component.current_download = {uid: 'download-6'} as any;
    component.downloads = [{uid: 'download-6'} as any, {uid: 'download-7'} as any];
    component.download_uids = ['download-6', 'download-7'];

    component.getCurrentDownload();

    expect(component.download_uids).toEqual(['download-7']);
    expect(component.current_download && component.current_download.uid).toBe('download-7');
  });

  it('removes downloads by uid even when object references differ', () => {
    component.current_download = {uid: 'download-8'} as any;
    component.downloads = [{uid: 'download-8'} as any, {uid: 'download-9'} as any];
    component.download_uids = ['download-8', 'download-9'];

    const removed = component.removeDownloadFromCurrentDownloads({uid: 'download-8'} as any);

    expect(removed).toBeTrue();
    expect(component.download_uids).toEqual(['download-9']);
    expect(component.current_download && component.current_download.uid).toBe('download-9');
  });

  it('shows playlist download option for single YouTube URL with list param', () => {
    component.url = 'https://www.youtube.com/watch?v=wOWhfNB_r-0&list=PLIhvC56v63IJIujb5cyE13oLuyORZpdkL&index=6';

    expect(component.hasPlaylistUrlInInput()).toBeTrue();
    expect(component.shouldShowDownloadMenu()).toBeTrue();
  });

  it('does not show playlist download option for non-playlist URL', () => {
    component.url = 'https://www.youtube.com/watch?v=wOWhfNB_r-0';

    expect(component.hasPlaylistUrlInInput()).toBeFalse();
  });

  it('keeps download menu visible when sponsorblock option is enabled', () => {
    component.sponsorBlockApiEnabled = true;
    component.url = 'https://www.youtube.com/watch?v=wOWhfNB_r-0';

    expect(component.shouldShowDownloadMenu()).toBeTrue();
  });

  it('maps playlist menu action to canonical playlist URL', () => {
    component.url = 'https://www.youtube.com/watch?v=wOWhfNB_r-0&list=PLIhvC56v63IJIujb5cyE13oLuyORZpdkL&index=6';
    const download_spy = spyOn(component, 'downloadClicked');

    component.downloadPlaylistClicked();

    expect(download_spy).toHaveBeenCalledWith(
      false,
      'https://www.youtube.com/playlist?list=PLIhvC56v63IJIujb5cyE13oLuyORZpdkL',
      false
    );
  });

  it('falls back to normal download when playlist action is unavailable', () => {
    component.url = 'https://www.youtube.com/watch?v=wOWhfNB_r-0';
    const download_spy = spyOn(component, 'downloadClicked');

    component.downloadPlaylistClicked();

    expect(download_spy).toHaveBeenCalledWith();
  });

  it('keeps main download as single-video for watch URLs that include list param', () => {
    const download_file_spy = jasmine.createSpy('downloadFile').and.returnValue(of({download: {uid: 'queued-1'}}));
    (component as any).postsService.downloadFile = download_file_spy;
    component.url = 'https://www.youtube.com/watch?v=wOWhfNB_r-0&list=PLIhvC56v63IJIujb5cyE13oLuyORZpdkL&index=6';
    component.autoplay = true;

    component.downloadClicked();

    const called_url = download_file_spy.calls.argsFor(0)[0];
    expect(called_url).toBe('https://www.youtube.com/watch?v=wOWhfNB_r-0');
  });

  it('shows the playlist shortcut only when the library is on the playlists tab', () => {
    component.mediaLibrary = {
      showLibraryTabs: true,
      activeLibraryTab: 1,
      openCreatePlaylistDialog: () => {}
    } as any;

    expect(component.showCreatePlaylistShortcut).toBeTrue();

    component.mediaLibrary.activeLibraryTab = 0;
    expect(component.showCreatePlaylistShortcut).toBeFalse();

    component.mediaLibrary = {
      showLibraryTabs: false,
      activeLibraryTab: 1,
      openCreatePlaylistDialog: () => {}
    } as any;
    expect(component.showCreatePlaylistShortcut).toBeFalse();

    component.mediaLibrary = null;
    expect(component.showCreatePlaylistShortcut).toBeFalse();
  });

  it('delegates playlist creation to the media library component', () => {
    const open_dialog_spy = jasmine.createSpy('openCreatePlaylistDialog');
    component.mediaLibrary = {
      showLibraryTabs: true,
      activeLibraryTab: 1,
      openCreatePlaylistDialog: open_dialog_spy
    } as any;

    component.openCreatePlaylistDialog();

    expect(open_dialog_spy).toHaveBeenCalled();
  });
});
