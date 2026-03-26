import { BehaviorSubject, of } from 'rxjs';

import { SubscriptionComponent } from './subscription.component';

describe('SubscriptionComponent', () => {
  let component: SubscriptionComponent;
  let postsService: any;
  let router: any;

  beforeEach(() => {
    postsService = {
      config: {
        Downloader: {
          use_youtubedl_archive: false
        },
        Extra: {
          enable_downloads_manager: true
        },
        Advanced: {
          multi_user_mode: false
        }
      },
      service_initialized: new BehaviorSubject<boolean>(true),
      files_changed: new BehaviorSubject<boolean>(false),
      getSubscription: jasmine.createSpy('getSubscription'),
      getSubscriptionByID: jasmine.createSpy('getSubscriptionByID'),
      downloadSubFromServer: jasmine.createSpy('downloadSubFromServer'),
      checkSubscription: jasmine.createSpy('checkSubscription'),
      cancelCheckSubscription: jasmine.createSpy('cancelCheckSubscription'),
      openSnackBar: jasmine.createSpy('openSnackBar'),
      hasPermission: jasmine.createSpy('hasPermission').and.returnValue(true)
    };
    router = {
      navigate: jasmine.createSpy('navigate')
    };

    component = new SubscriptionComponent(
      postsService,
      { params: of({ id: 'sub-1' }) } as any,
      router,
      { open: jasmine.createSpy('open') } as any
    );
    component.id = 'sub-1';
  });

  it('should preserve the existing videos array during low-cost refresh polling', () => {
    const existing_videos = [{ id: 'video-1' }];
    component.subscription = {
      id: 'sub-1',
      name: 'Test subscription',
      downloading: true,
      refresh_status: {
        phase: 'collecting',
        active: true,
        discovered_count: 2,
        total_count: 10
      },
      videos: existing_videos
    } as any;
    spyOn(postsService.files_changed, 'next');
    postsService.getSubscription.and.returnValue(of({
      subscription: {
        ...component.subscription,
        downloading: false,
        refresh_status: {
          phase: 'queued',
          active: false,
          queued_count: 3,
          pending_download_count: 3,
          running_download_count: 1
        },
        videos: [{ id: 'replacement-video' }]
      }
    }));

    component.getSubscription(true);

    expect(component.subscription.videos).toBe(existing_videos);
    expect(component.subscription.downloading).toBeFalse();
    expect(component.subscription.refresh_status.phase).toBe('queued');
    expect(postsService.files_changed.next).not.toHaveBeenCalled();
  });

  it('should describe collecting progress when totals are known', () => {
    component.subscription = {
      id: 'sub-1',
      name: 'Test subscription',
      downloading: true,
      refresh_status: {
        phase: 'collecting',
        active: true,
        discovered_count: 4,
        total_count: 10,
        latest_item_title: 'Newest item',
        pending_download_count: 0,
        running_download_count: 0
      },
      videos: []
    } as any;

    expect(component.shouldShowRefreshStatus()).toBeTrue();
    expect(component.hasActiveRefresh()).toBeTrue();
    expect(component.getRefreshHeadline()).toBe('Checking channel metadata');
    expect(component.getRefreshProgressMode()).toBe('determinate');
    expect(component.getRefreshProgressValue()).toBe(40);
    expect(component.getRefreshMetrics()).toContain('4 / 10 items scanned');
  });

  it('should expose the downloads page action when queued downloads exist', () => {
    component.subscription = {
      id: 'sub-1',
      name: 'Test subscription',
      downloading: false,
      refresh_status: {
        phase: 'queued',
        active: false,
        queued_count: 2,
        pending_download_count: 2,
        running_download_count: 1
      },
      videos: []
    } as any;

    expect(component.canOpenDownloads()).toBeTrue();

    component.openDownloads();

    expect(router.navigate).toHaveBeenCalledWith(['/downloads']);
  });
});
