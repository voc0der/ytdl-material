import { BehaviorSubject, of, Subject } from 'rxjs';

import { SubscriptionComponent } from './subscription.component';

describe('SubscriptionComponent', () => {
  let component: SubscriptionComponent;
  let postsService: any;
  let router: any;
  let dialog: any;
  let actions: any;

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
      getSubscription: vi.fn().mockName('getSubscription'),
      getSubscriptionByID: vi.fn().mockName('getSubscriptionByID'),
      downloadSubFromServer: vi.fn().mockName('downloadSubFromServer'),
      checkSubscription: vi.fn().mockName('checkSubscription'),
      cancelCheckSubscription: vi.fn().mockName('cancelCheckSubscription'),
      updateSubscription: vi.fn().mockName('updateSubscription'),
      reloadSubscriptions: vi.fn().mockName('reloadSubscriptions'),
      openSnackBar: vi.fn().mockName('openSnackBar'),
      hasPermission: vi.fn().mockName('hasPermission').mockReturnValue(true)
    };
    router = {
      navigate: vi.fn().mockName('navigate')
    };
    dialog = {
      open: vi.fn().mockName('open')
    };
    actions = {
      setPaused: vi.fn().mockName('setPaused').mockResolvedValue(true),
      redownload: vi.fn().mockName('redownload').mockResolvedValue(true),
      unsubscribe: vi.fn().mockName('unsubscribe').mockResolvedValue(true),
      exportArchive: vi.fn().mockName('exportArchive').mockResolvedValue(true),
      coverURL: vi.fn().mockName('coverURL').mockReturnValue(null)
    };

    component = new SubscriptionComponent(postsService, { params: of({ id: 'sub-1' }) } as any, router, dialog, actions);
    component.id = 'sub-1';
  });

  it('should confirm before preparing a subscription archive', () => {
    component.subscription = {
      id: 'sub-1',
      name: 'Test subscription',
      file_count: 125
    } as any;
    dialog.open.mockReturnValue({afterClosed: () => of(false)});

    component.downloadContent();

    expect(dialog.open).toHaveBeenCalledWith(expect.any(Function), {
      data: {
        dialogTitle: 'Download subscription?',
        dialogText: expect.stringContaining('125 files from Test subscription'),
        submitText: 'Download'
      }
    });
    expect(postsService.downloadSubFromServer).not.toHaveBeenCalled();
  });

  it('should start preparing the archive after confirmation', () => {
    component.subscription = {
      id: 'sub-1',
      name: 'Test subscription',
      file_count: 2
    } as any;
    dialog.open.mockReturnValue({afterClosed: () => of(true)});
    postsService.downloadSubFromServer.mockReturnValue(new Subject<Blob>());

    component.downloadContent();

    expect(postsService.downloadSubFromServer).toHaveBeenCalledWith('sub-1');
    expect(component.downloading).toBe(true);
  });

  it('should cancel an in-progress subscription archive request', () => {
    const archive_response = new Subject<Blob>();
    component.subscription = {
      id: 'sub-1',
      name: 'Test subscription',
      file_count: 2
    } as any;
    postsService.downloadSubFromServer.mockReturnValue(archive_response);
    component.startSubscriptionDownload();
    const unsubscribe_spy = vi.spyOn(component.archiveDownloadSubscription, 'unsubscribe');

    component.cancelSubscriptionDownload();

    expect(unsubscribe_spy).toHaveBeenCalled();
    expect(component.archiveDownloadSubscription).toBeNull();
    expect(component.downloading).toBe(false);
    expect(postsService.openSnackBar).toHaveBeenCalledWith('Subscription download cancelled.');
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
    vi.spyOn(postsService.files_changed, 'next').mockReturnValue(undefined);
    postsService.getSubscription.mockReturnValue(of({
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
    expect(component.subscription.downloading).toBe(false);
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
    vi.spyOn(postsService.files_changed, 'next').mockReturnValue(undefined);
    postsService.getSubscription.mockReturnValue(of({
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
    vi.spyOn(postsService.files_changed, 'next').mockReturnValue(undefined);
    postsService.getSubscription.mockReturnValue(of({
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
    postsService.getSubscription.mockReturnValueOnce(first_response.asObservable()).mockReturnValueOnce(of({
      subscription: {
        id: 'sub-1',
        name: 'Test subscription',
        file_count: 1,
        downloading: false
      }
    }));

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
    postsService.getSubscription.mockReturnValueOnce(first_a_response.asObservable()).mockReturnValueOnce(b_response.asObservable()).mockReturnValueOnce(second_a_response.asObservable());

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
    const get_subscription_spy = vi.spyOn(component, 'getSubscription').mockReturnValue(undefined);
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
    postsService.checkSubscription.mockReturnValue(of({ success: true }));
    const get_subscription_spy = vi.spyOn(component, 'getSubscription').mockReturnValue(undefined);

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

    expect(component.shouldShowRefreshStatus()).toBe(true);
    expect(component.hasActiveRefresh()).toBe(true);
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

    expect(component.canOpenDownloads()).toBe(true);

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

    expect(component.shouldShowRefreshStatus()).toBe(true);
    expect(component.getRefreshHeadline()).toBe('Downloads skipped');
    expect(component.getRefreshDescription()).toContain('were skipped');
    expect(component.getRefreshMetrics()).toContain('2 skipped');
    expect(component.getRefreshMetrics()).not.toContain('2 queued');
    expect(component.canOpenDownloads()).toBe(false);
  });

  describe('settings', () => {
    const subscription = (overrides: Record<string, unknown> = {}) => ({
      id: 'sub-1',
      name: 'Test subscription',
      url: 'https://example.com/channel',
      type: 'video',
      isPlaylist: false,
      maxQuality: '1080',
      use_subfolder: true,
      auto_create_playlist: false,
      file_count: 2,
      refresh_status: { phase: 'complete', completed_at: Date.now() },
      ...overrides
    }) as any;

    beforeEach(() => {
      component.subscription = subscription();
      postsService.getSubscription.mockReturnValue(of({ subscription: component.subscription }));
    });

    it('opens on a copy, so cancelling changes nothing', () => {
      component.toggleSettings();
      expect(component.settingsOpen).toBe(true);

      component.settingsDraft.paused = true;
      component.closeSettings();

      expect(component.settingsOpen).toBe(false);
      expect(component.subscription.paused).toBeUndefined();
      expect(postsService.updateSubscription).not.toHaveBeenCalled();
    });

    it('cannot be saved until something changes', () => {
      component.openSettings();
      expect(component.canSaveSettings).toBe(false);

      component.settingsDraft.paused = true;

      expect(component.settingsChanged).toBe(true);
      expect(component.canSaveSettings).toBe(true);
    });

    it('waits for running downloads before it can be saved', () => {
      component.subscription = subscription({ downloading: true });
      component.openSettings();
      component.settingsDraft.use_subfolder = false;

      expect(component.settingsChanged).toBe(true);
      expect(component.canSaveSettings).toBe(false);
    });

    it('sends only what changed, then closes', async () => {
      postsService.updateSubscription.mockReturnValue(of({ success: true }));
      component.openSettings();
      component.settingsDraft.paused = true;
      component.settingsDraft.custom_args = '--verbose';

      await component.saveSettings();

      expect(postsService.updateSubscription).toHaveBeenCalledWith({ id: 'sub-1', paused: true, custom_args: '--verbose' });
      expect(component.settingsOpen).toBe(false);
      expect(component.subscription.paused).toBe(true);
      expect(postsService.openSnackBar).toHaveBeenCalledWith('Settings saved.');
      expect(postsService.reloadSubscriptions).toHaveBeenCalled();
    });

    it('keeps the panel open when saving is refused', async () => {
      postsService.updateSubscription.mockReturnValue(of({ success: false }));
      component.openSettings();
      component.settingsDraft.paused = true;

      await component.saveSettings();

      expect(component.settingsOpen).toBe(true);
      expect(component.savingSettings).toBe(false);
      expect(postsService.openSnackBar).toHaveBeenCalledWith('Couldn\'t save the settings. Nothing was changed.');
    });

    it('opens the settings when a card asked for them', () => {
      component.subscription = null;
      component.ngOnInit();
      // the route carried settings=true
      (component as any).openSettingsOnLoad = true;
      postsService.getSubscription.mockReturnValue(of({ subscription: subscription() }));

      component.getSubscription();

      expect(component.settingsOpen).toBe(true);
    });

    it('returns to the list after unsubscribing', async () => {
      await component.unsubscribe();

      expect(actions.unsubscribe).toHaveBeenCalledWith(expect.objectContaining({ id: 'sub-1', file_count: 2 }));
      expect(router.navigate).toHaveBeenCalledWith(['/subscriptions']);
    });

    it('stays put when unsubscribing is cancelled', async () => {
      actions.unsubscribe.mockResolvedValue(false);

      await component.unsubscribe();

      expect(router.navigate).not.toHaveBeenCalled();
    });
  });

  describe('what the header says', () => {
    it('sums up a quiet subscription', () => {
      component.subscription = { id: 'sub-1', name: 'Test', refresh_status: { phase: 'complete', completed_at: Date.now() - 60_000 } } as any;

      expect(component.statusText()).toContain('Checked');
      expect(component.shouldShowRefreshStatus()).toBe(false);
    });

    it('keeps the refresh card for a check under way', () => {
      component.subscription = { id: 'sub-1', name: 'Test', downloading: true, refresh_status: { phase: 'collecting', active: true } } as any;

      expect(component.isChecking).toBe(true);
      expect(component.statusText()).toBe('Checking for new uploads');
      expect(component.shouldShowRefreshStatus()).toBe(true);
    });

    it('names a playlist as one', () => {
      component.subscription = { id: 'sub-1', name: 'Test', isPlaylist: true, refresh_status: { phase: 'complete' } } as any;

      expect(component.getRefreshHeadline()).toBe('Playlist is up to date');
    });
  });
});
