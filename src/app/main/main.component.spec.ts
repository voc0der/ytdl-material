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

  it('does not treat null percent as determinate progress', () => {
    component.percentDownloaded = null;
    expect(component.hasCurrentDownloadPercent()).toBeFalse();
  });

  it('treats numeric percent as determinate progress', () => {
    component.percentDownloaded = 42.5;
    expect(component.hasCurrentDownloadPercent()).toBeTrue();
  });

  it('keeps percentDownloaded null when API returns null percent_complete', () => {
    const api_download = {
      uid: 'download-1',
      percent_complete: null,
      finished: false,
      error: null
    };
    (component as any).postsService.getCurrentDownload = () => of({download: api_download});
    component.current_download = {uid: 'download-1'} as any;
    component.percentDownloaded = 50;

    component.getCurrentDownload();

    expect(component.percentDownloaded).toBeNull();
    expect(component.hasCurrentDownloadPercent()).toBeFalse();
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
    const reload_spy = spyOn(component, 'reloadRecentVideos');
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
    const reload_spy = spyOn(component, 'reloadRecentVideos');
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
});
