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
});
