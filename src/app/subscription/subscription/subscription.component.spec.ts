import { BehaviorSubject, of, Subject } from 'rxjs';

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
      file_count: 1,
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
        file_count: 1
      }
    }));

    component.getSubscription(true);

    expect(postsService.getSubscription).toHaveBeenCalledWith('sub-1', null, false);
    expect(component.subscription.videos).toBe(existing_videos);
    expect(component.subscription.downloading).toBeFalse();
    expect(component.subscription.refresh_status.phase).toBe('queued');
    expect(postsService.files_changed.next).not.toHaveBeenCalled();
  });
  it('should notify the media library when lightweight subscription file count increases', () => {
    component.subscription = {
      id: 'sub-1',
      name: 'Test subscription',
      file_count: 1,
      downloading: true,
      videos: [{ id: 'video-1' }]
    } as any;
    spyOn(postsService.files_changed, 'next');
    postsService.getSubscription.and.returnValue(of({
      subscription: {
        id: 'sub-1',
        name: 'Test subscription',
        file_count: 2,
        downloading: false
      }
    }));

    component.getSubscription(true);

    expect(component.subscription.file_count).toBe(2);
    expect(postsService.files_changed.next).toHaveBeenCalledWith(true);
  });

  it('should not publish a file change while initially loading subscription metadata', () => {
    spyOn(postsService.files_changed, 'next');
    postsService.getSubscription.and.returnValue(of({
      subscription: {
        id: 'sub-1',
        name: 'Test subscription',
        file_count: 400,
        downloading: false
      }
    }));

    component.getSubscription();

    expect(component.subscription.file_count).toBe(400);
    expect(postsService.files_changed.next).not.toHaveBeenCalled();
  });

  it('should not overlap lightweight subscription status requests', () => {
    const first_response = new Subject<any>();
    postsService.getSubscription.and.returnValues(
      first_response.asObservable(),
      of({
        subscription: {
          id: 'sub-1',
          name: 'Test subscription',
          file_count: 1,
          downloading: false
        }
      })
    );

    component.getSubscription(true);
    component.getSubscription(true);

    expect(postsService.getSubscription).toHaveBeenCalledTimes(1);

    first_response.next({
      subscription: {
        id: 'sub-1',
        name: 'Test subscription',
        file_count: 1,
        downloading: true
      }
    });
    first_response.complete();
    component.getSubscription(true);

    expect(postsService.getSubscription).toHaveBeenCalledTimes(2);
  });

  it('should discard outdated responses across rapid subscription route changes', () => {
    const first_a_response = new Subject<any>();
    const b_response = new Subject<any>();
    const second_a_response = new Subject<any>();
    postsService.getSubscription.and.returnValues(
      first_a_response.asObservable(),
      b_response.asObservable(),
      second_a_response.asObservable()
    );

    component.id = 'sub-1';
    component.getSubscription(true);
    component.id = 'sub-2';
    component.subscription = null;
    component.getSubscription(true);
    component.id = 'sub-1';
    component.subscription = null;
    component.getSubscription(true);

    second_a_response.next({
      subscription: {
        id: 'sub-1',
        name: 'Current first subscription',
        file_count: 3,
        downloading: false
      }
    });
    second_a_response.complete();
    first_a_response.next({
      subscription: {
        id: 'sub-1',
        name: 'Outdated first subscription',
        file_count: 1,
        downloading: false
      }
    });
    first_a_response.complete();
    b_response.next({
      subscription: {
        id: 'sub-2',
        name: 'Outdated second subscription',
        file_count: 2,
        downloading: false
      }
    });
    b_response.complete();

    expect(postsService.getSubscription).toHaveBeenCalledTimes(3);
    expect(component.subscription.id).toBe('sub-1');
    expect(component.subscription.name).toBe('Current first subscription');
  });

  it('should poll idle subscriptions less often while keeping active refreshes responsive', () => {
    component.subscription = {
      id: 'sub-1',
      name: 'Test subscription',
      file_count: 1,
      downloading: false,
      refresh_status: {
        phase: 'complete',
        active: false,
        pending_download_count: 0,
        running_download_count: 0
      }
    } as any;
    const get_subscription_spy = spyOn(component, 'getSubscription');
    (component as any).last_subscription_request_at = Date.now();

    (component as any).pollSubscription();
    expect(get_subscription_spy).not.toHaveBeenCalled();

    component.subscription.refresh_status.active = true;
    component.subscription.refresh_status.phase = 'collecting';
    (component as any).last_subscription_request_at = Date.now() - 1001;
    (component as any).pollSubscription();

    expect(get_subscription_spy).toHaveBeenCalledWith(true);
  });

  it('should refresh subscription status immediately after starting a check', () => {
    component.subscription = {
      id: 'sub-1',
      name: 'Test subscription',
      file_count: 1,
      downloading: false
    } as any;
    postsService.checkSubscription.and.returnValue(of({success: true}));
    const get_subscription_spy = spyOn(component, 'getSubscription');

    component.checkSubscription();

    expect(get_subscription_spy).toHaveBeenCalledWith(true);
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

  it('should describe skipped downloads instead of leaving queued wording behind', () => {
    component.subscription = {
      id: 'sub-1',
      name: 'Test subscription',
      downloading: false,
      refresh_status: {
        phase: 'complete',
        active: false,
        new_items_count: 2,
        queued_count: 2,
        skipped_count: 2,
        pending_download_count: 0,
        running_download_count: 0
      },
      videos: []
    } as any;

    expect(component.shouldShowRefreshStatus()).toBeTrue();
    expect(component.getRefreshHeadline()).toBe('Downloads skipped');
    expect(component.getRefreshDescription()).toContain('were skipped');
    expect(component.getRefreshMetrics()).toContain('2 skipped');
    expect(component.getRefreshMetrics()).not.toContain('2 queued');
    expect(component.canOpenDownloads()).toBeFalse();
  });
});
