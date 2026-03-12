import { AppComponent } from './app.component';
import { of } from 'rxjs';
import { Download } from 'api-types';

describe('AppComponent', () => {
  let component: AppComponent;
  let posts_service_mock: any;
  let active_downloads_trigger_mock: any;

  const createDownload = (overrides: Partial<Download>): Download => ({
    uid: 'download-1',
    running: true,
    finished: false,
    paused: false,
    finished_step: false,
    url: 'https://example.com/video',
    type: 'video',
    title: 'Example Video',
    step_index: 2,
    percent_complete: 42.5,
    timestamp_start: 1000,
    ...overrides
  });

  beforeEach(() => {
    posts_service_mock = {
      config_reloaded: of(false),
      open_create_default_admin_dialog: of(false),
      service_initialized: of(true),
      initialized: true,
      config: { Advanced: { multi_user_mode: false } },
      isLoggedIn: true,
      hasPermission: () => true,
      getCurrentDownloads: () => of({downloads: []}),
      pauseDownload: () => of({success: true}),
      cancelDownload: () => of({success: true}),
      openSnackBar: () => {},
      reloadSubscriptions: () => {},
      reloadCategories: () => {},
      getVersionInfo: () => of({version_info: {}}),
      setTheme: () => {},
      theme: {key: 'default', css_label: 'light-theme', background_color: '#fff'}
    };
    const snack_bar_mock: any = {};
    const dialog_mock: any = { open: () => ({ afterClosed: () => of(null) }) };
    const router_mock: any = { events: of(), navigate: () => {}, navigateByUrl: () => {}, url: '/home' };
    const overlay_container_mock: any = { getContainerElement: () => ({ classList: { remove: () => {}, add: () => {} } }) };
    const element_ref_mock: any = { nativeElement: { ownerDocument: { body: { style: {} } } } };

    component = new AppComponent(
      posts_service_mock,
      snack_bar_mock,
      dialog_mock,
      router_mock,
      overlay_container_mock,
      element_ref_mock
    );

    active_downloads_trigger_mock = {
      menuOpen: false,
      openMenu: jasmine.createSpy('openMenu'),
      closeMenu: jasmine.createSpy('closeMenu')
    };
    component.activeDownloadsTrigger = active_downloads_trigger_mock as any;
  });

  it('should create component instance', () => {
    expect(component).toBeTruthy();
  });

  it('filters out paused, finished, cancelled and errored downloads', () => {
    posts_service_mock.getCurrentDownloads = () => of({
      downloads: [
        createDownload({uid: 'active-1', timestamp_start: 1000}),
        createDownload({uid: 'paused-1', paused: true, timestamp_start: 2000}),
        createDownload({uid: 'finished-1', finished: true, timestamp_start: 3000}),
        createDownload({uid: 'cancelled-1', cancelled: true, timestamp_start: 4000}),
        createDownload({uid: 'error-1', error: 'failed', timestamp_start: 5000}),
        createDownload({uid: 'active-2', timestamp_start: 6000})
      ]
    });

    (component as any).refreshActiveDownloads();

    expect(component.active_download_count).toBe(2);
    expect(component.active_downloads.map(download => download.uid)).toEqual(['active-2', 'active-1']);
  });

  it('does not auto-open on initial active download load', () => {
    const show_spy = spyOn<any>(component, 'showActiveDownloadsMenuTemporarily');
    (component as any).active_downloads_initialized = false;

    (component as any).setActiveDownloads([createDownload({uid: 'active-1'})]);

    expect(show_spy).not.toHaveBeenCalled();
  });

  it('auto-opens when a new active download appears after initialization', () => {
    jasmine.clock().install();
    const show_spy = spyOn<any>(component, 'showActiveDownloadsMenuTemporarily');
    (component as any).active_downloads_initialized = true;
    component.active_download_count = 0;
    (component as any).active_download_uids = new Set<string>();

    (component as any).setActiveDownloads([createDownload({uid: 'active-1'})]);
    jasmine.clock().tick(1);

    expect(show_spy).toHaveBeenCalled();
    jasmine.clock().uninstall();
  });

  it('auto-close timer closes the menu when auto-opened', () => {
    jasmine.clock().install();
    active_downloads_trigger_mock.menuOpen = true;
    (component as any).active_downloads_auto_opened = true;

    (component as any).scheduleActiveDownloadsAutoClose();
    jasmine.clock().tick(5000);

    expect(active_downloads_trigger_mock.closeMenu).toHaveBeenCalled();
    expect((component as any).active_downloads_auto_opened).toBeFalse();
    jasmine.clock().uninstall();
  });

  it('shows green completion badge for a short time after final successful completion', () => {
    jasmine.clock().install();
    (component as any).active_downloads_initialized = true;
    component.active_download_count = 1;
    (component as any).active_download_uids = new Set<string>(['active-1']);

    (component as any).setActiveDownloads([], true);

    expect(component.show_completion_badge).toBeTrue();
    expect(component.shouldShowActiveDownloadsIndicator()).toBeTrue();
    expect(component.getActiveDownloadsBadgeValue()).toBe('✓');
    expect(component.getActiveDownloadsBadgeColor()).toBe('accent');
    expect(component.getActiveDownloadsIndicatorIcon()).toBe('download_done');

    jasmine.clock().tick(2501);
    expect(component.show_completion_badge).toBeFalse();
    expect(component.shouldShowActiveDownloadsIndicator()).toBeFalse();
    jasmine.clock().uninstall();
  });

  it('clears completion badge immediately when new active downloads appear', () => {
    component.show_completion_badge = true;
    component.active_download_count = 0;
    (component as any).setActiveDownloads([createDownload({uid: 'active-1'})], false);

    expect(component.show_completion_badge).toBeFalse();
    expect(component.getActiveDownloadsBadgeValue()).toBe(1);
    expect(component.getActiveDownloadsBadgeColor()).toBe('warn');
    expect(component.getActiveDownloadsIndicatorIcon()).toBe('download');
  });

  it('pause action calls pauseDownload for the selected download', () => {
    const pause_spy = spyOn(posts_service_mock, 'pauseDownload').and.returnValue(of({success: true}));
    const event_mock = { stopPropagation: jasmine.createSpy('stopPropagation') } as any;

    component.pauseActiveDownload(createDownload({uid: 'active-1'}), event_mock);

    expect(event_mock.stopPropagation).toHaveBeenCalled();
    expect(pause_spy).toHaveBeenCalledWith('active-1');
  });

  it('cancel action calls cancelDownload for the selected download', () => {
    const cancel_spy = spyOn(posts_service_mock, 'cancelDownload').and.returnValue(of({success: true}));
    const event_mock = { stopPropagation: jasmine.createSpy('stopPropagation') } as any;

    component.cancelActiveDownload(createDownload({uid: 'active-1'}), event_mock);

    expect(event_mock.stopPropagation).toHaveBeenCalled();
    expect(cancel_spy).toHaveBeenCalledWith('active-1');
  });
});
