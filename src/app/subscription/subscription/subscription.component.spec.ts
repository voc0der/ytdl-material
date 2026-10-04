import { BehaviorSubject, of, Subject, throwError } from 'rxjs';

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
      coverURL: vi.fn().mockName('coverURL').mockReturnValue(null),
      artworkURL: vi.fn().mockName('artworkURL').mockReturnValue(null)
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

    expect(dialog.open).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({
      data: {
        dialogTitle: 'Download subscription?',
        dialogText: expect.stringContaining('125 files from Test subscription'),
        submitText: 'Download'
      }
    }));
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

  it('should count what collecting found without passing it off as progress through the channel', () => {
    component.subscription = {
      id: 'sub-1',
      name: 'Test subscription',
      downloading: true,
      refresh_status: {
        phase: 'collecting',
        active: true,
        discovered_count: 1,
        // The size of the listing: yt-dlp passes over most of it without a word.
        total_count: 386,
        latest_item_title: 'Newest item',
        pending_download_count: 0,
        running_download_count: 0
      },
      videos: []
    } as any;

    expect(component.shouldShowRefreshStatus()).toBe(true);
    expect(component.hasActiveRefresh()).toBe(true);
    expect(component.getRefreshHeadline()).toBe('Checking channel metadata');
    expect(component.getRefreshProgressMode()).toBe('indeterminate');
    expect(component.getRefreshMetrics()).toEqual(['1 found so far']);
  });

  it('should show a channel by its avatar, and a playlist by its cover', () => {
    component.subscription = { id: 'sub-1', name: 'Test subscription', isPlaylist: false } as any;
    actions.coverURL.mockReturnValue('/api/thumbnail/file-1');
    expect(component.coverURL).toBe('/api/thumbnail/file-1');
    expect(component.coverIsAvatar).toBe(false);

    actions.artworkURL.mockReturnValue('/api/subscriptionArtwork/sub-1?v=1');
    expect(component.coverURL).toBe('/api/subscriptionArtwork/sub-1?v=1');
    expect(component.coverIsAvatar).toBe(true);

    component.subscription = { ...component.subscription, isPlaylist: true } as any;
    expect(component.coverURL).toBe('/api/subscriptionArtwork/sub-1?v=1');
    expect(component.coverIsAvatar).toBe(false);
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

  describe('opening and leaving the page', () => {
    let params: Subject<Record<string, string>>;

    beforeEach(() => {
      vi.useFakeTimers();
      params = new Subject();
      component = new SubscriptionComponent(postsService, { params } as any, router, dialog, actions);
      postsService.getSubscription.mockImplementation((id: string) => of({ subscription: { id, name: `Subscription ${id}`, file_count: 0 } }));
    });

    afterEach(() => {
      component.ngOnDestroy();
      vi.useRealTimers();
    });

    it('starts over on another subscription, closing the settings it had open', () => {
      component.ngOnInit();
      params.next({ id: 'sub-1' });
      component.openSettings();
      expect(component.settingsOpen).toBe(true);

      // The next one has not answered yet.
      postsService.getSubscription.mockReturnValue(new Subject());
      params.next({ id: 'sub-2' });

      expect(component.id).toBe('sub-2');
      expect(component.subscription).toBeNull();
      expect(component.settingsOpen).toBe(false);
      expect(postsService.getSubscription).toHaveBeenLastCalledWith('sub-2', null, false);
    });

    it('stops asking after the subscription once the page is closed', () => {
      component.ngOnInit();
      params.next({ id: 'sub-1' });
      vi.advanceTimersByTime(10_000);
      const asked = postsService.getSubscription.mock.calls.length;
      expect(asked).toBeGreaterThan(1);

      component.ngOnDestroy();
      vi.advanceTimersByTime(60_000);

      expect(postsService.getSubscription).toHaveBeenCalledTimes(asked);
    });

    it('drops a zip still being prepared when the page is closed', () => {
      component.ngOnInit();
      params.next({ id: 'sub-1' });
      const archive = new Subject<Blob>();
      postsService.downloadSubFromServer.mockReturnValue(archive);
      component.startSubscriptionDownload();

      component.ngOnDestroy();

      expect(archive.observed).toBe(false);
      expect(component.archiveDownloadSubscription).toBeNull();
    });
  });

  describe('the zip of a subscription', () => {
    let objectURLs: { create: typeof URL.createObjectURL; revoke: typeof URL.revokeObjectURL };

    beforeEach(() => {
      // Saving revokes the blob's URL on a timer, which must not outlive the test.
      vi.useFakeTimers();
      objectURLs = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
      URL.createObjectURL = vi.fn(() => 'blob:subscription-zip');
      URL.revokeObjectURL = vi.fn();
      component.subscription = { id: 'sub-1', name: 'Test subscription', file_count: 2 } as any;
    });

    afterEach(() => {
      URL.createObjectURL = objectURLs.create;
      URL.revokeObjectURL = objectURLs.revoke;
      vi.restoreAllMocks();
      vi.useRealTimers();
    });

    it('is saved under the name of the subscription', () => {
      const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
      const archive = new Subject<Blob>();
      postsService.downloadSubFromServer.mockReturnValue(archive);

      component.startSubscriptionDownload();
      archive.next(new Blob(['zip']));

      expect(click).toHaveBeenCalledTimes(1);
      expect((click.mock.contexts[0] as HTMLAnchorElement).download).toBe('Test subscription.zip');
      expect(component.downloading).toBe(false);
      expect(component.archiveDownloadSubscription).toBeNull();
    });

    it('lets the page try again after preparing it failed', () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const archive = new Subject<Blob>();
      postsService.downloadSubFromServer.mockReturnValue(archive);

      component.startSubscriptionDownload();
      archive.error(new Error('disk full'));

      expect(component.downloading).toBe(false);
      expect(component.archiveDownloadSubscription).toBeNull();
    });

    it('is not asked for twice at once', () => {
      component.downloading = true;

      component.downloadContent();

      expect(dialog.open).not.toHaveBeenCalled();
    });
  });

  describe('actions', () => {
    beforeEach(() => {
      component.subscription = { id: 'sub-1', name: 'Test subscription', file_count: 2, paused: false } as any;
      postsService.getSubscription.mockReturnValue(of({ subscription: { ...component.subscription } }));
    });

    it('pauses, and asks again for where the subscription is', async () => {
      postsService.getSubscription.mockReturnValue(of({ subscription: { ...component.subscription, paused: true } }));

      await component.setPaused(true);

      expect(actions.setPaused).toHaveBeenCalledWith(expect.objectContaining({ id: 'sub-1' }), true);
      expect(component.subscription.paused).toBe(true);
      expect(postsService.getSubscription).toHaveBeenCalledWith('sub-1', null, false);
    });

    it('leaves the subscription as it was when pausing is refused', async () => {
      actions.setPaused.mockResolvedValue(false);

      await component.setPaused(true);

      expect(component.subscription.paused).toBe(false);
      expect(postsService.getSubscription).not.toHaveBeenCalled();
    });

    it('reloads once a redownload has started', async () => {
      await component.redownloadSubscription();

      expect(actions.redownload).toHaveBeenCalledWith(component.subscription);
      expect(postsService.getSubscription).toHaveBeenCalledWith('sub-1', null, false);
    });

    it('exports the archive', async () => {
      await component.exportArchive();

      expect(actions.exportArchive).toHaveBeenCalledWith(component.subscription);
    });

    it('plays everything downloaded', () => {
      component.watchSubscription();

      expect(router.navigate).toHaveBeenCalledWith(['/player', { sub_id: 'sub-1' }]);
    });

    it('says so when a check could not start', () => {
      postsService.checkSubscription.mockReturnValue(of({ success: false }));

      component.checkSubscription();

      expect(component.check_clicked).toBe(false);
      expect(postsService.openSnackBar).toHaveBeenCalledWith('Failed to check subscription!');
      expect(postsService.getSubscription).not.toHaveBeenCalled();
    });

    it('says so when asking for a check failed', () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      postsService.checkSubscription.mockReturnValue(throwError(() => new Error('offline')));

      component.checkSubscription();

      expect(component.check_clicked).toBe(false);
      expect(postsService.openSnackBar).toHaveBeenCalledWith('Failed to check subscription!');
    });

    it('stops a check, and asks again for where the subscription is', () => {
      postsService.cancelCheckSubscription.mockReturnValue(of({ success: true }));

      component.cancelCheckSubscription();

      expect(postsService.cancelCheckSubscription).toHaveBeenCalledWith('sub-1');
      expect(component.cancel_clicked).toBe(false);
      expect(postsService.getSubscription).toHaveBeenCalledWith('sub-1', null, false);
    });

    it('says so when a check could not be stopped', () => {
      postsService.cancelCheckSubscription.mockReturnValue(of({ success: false }));

      component.cancelCheckSubscription();

      expect(component.cancel_clicked).toBe(false);
      expect(postsService.openSnackBar).toHaveBeenCalledWith('Failed to cancel check subscription!');
      expect(postsService.getSubscription).not.toHaveBeenCalled();
    });

    it('says so when asking to stop a check failed', () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      postsService.cancelCheckSubscription.mockReturnValue(throwError(() => new Error('offline')));

      component.cancelCheckSubscription();

      expect(component.cancel_clicked).toBe(false);
      expect(postsService.openSnackBar).toHaveBeenCalledWith('Failed to cancel check subscription!');
    });

    it('keeps the settings open when saving them failed outright', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      postsService.updateSubscription.mockReturnValue(throwError(() => new Error('offline')));
      component.toggleSettings();
      component.settingsDraft.paused = true;

      await component.saveSettings();

      expect(component.settingsOpen).toBe(true);
      expect(component.savingSettings).toBe(false);
      expect(postsService.openSnackBar).toHaveBeenCalledWith('Couldn\'t save the settings. Nothing was changed.');

      component.toggleSettings();
      expect(component.settingsOpen).toBe(false);
    });
  });

  describe('what the refresh card says', () => {
    const withStatus = (refresh_status: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
      component.subscription = {
        id: 'sub-1',
        name: 'Test subscription',
        refresh_status: { active: false, pending_download_count: 0, running_download_count: 0, ...refresh_status },
        ...extra
      } as any;
    };

    it('counts the downloads a check is queueing', () => {
      withStatus({ phase: 'queueing', active: true, new_items_count: 4, queued_count: 1 });

      expect(component.getRefreshHeadline()).toBe('Queueing new downloads');
      expect(component.getRefreshDescription()).toBe('Found 4 new item(s). The app is creating download jobs now.');
      expect(component.shouldShowRefreshProgressBar()).toBe(true);
      expect(component.getRefreshProgressMode()).toBe('determinate');
      expect(component.getRefreshProgressValue()).toBe(25);
      expect(component.getRefreshMetrics()).toEqual(['4 new downloads found', '1 queued']);
    });

    it('waits on a check that found nothing yet to queue', () => {
      withStatus({ phase: 'queueing', active: true, new_items_count: 0, queued_count: 0 });

      expect(component.getRefreshDescription()).toBe('The metadata scan finished. The app is preparing download jobs now.');
      expect(component.getRefreshProgressMode()).toBe('indeterminate');
      expect(component.getRefreshProgressValue()).toBe(0);
    });

    it('describes a playlist being scanned, with the newest item it found', () => {
      withStatus({ phase: 'collecting', active: true, latest_item_title: 'Newest item' }, { isPlaylist: true });

      expect(component.getRefreshHeadline()).toBe('Checking playlist metadata');
      expect(component.getRefreshDescription()).toContain('scanning this playlist');
      expect(component.getRefreshDescription()).toContain('"Newest item"');
    });

    it('counts queued downloads still to run, and running ones', () => {
      withStatus({ phase: 'queued', new_items_count: 3, queued_count: 3, pending_download_count: 3, running_download_count: 1 });

      expect(component.statusText()).toBe('Downloading 3 new');
      expect(component.getRefreshHeadline()).toBe('Downloads queued');
      expect(component.getRefreshDescription()).toBe('Download jobs are queued. New files will appear here as each download completes.');
      expect(component.shouldShowRefreshProgressBar()).toBe(false);
      expect(component.getRefreshMetrics()).toEqual(['3 new downloads found', '3 queued', '1 running now', '3 pending in downloads']);
    });

    it('says how many were skipped while the rest are still queued', () => {
      withStatus({ phase: 'queued', new_items_count: 3, queued_count: 3, skipped_count: 1, pending_download_count: 2 });

      expect(component.getRefreshDescription()).toContain('and 1 were skipped');
      expect(component.getRefreshMetrics()).toEqual(['3 new downloads found', '2 queued', '1 skipped', '2 pending in downloads']);
    });

    it('says the queued downloads have gone through', () => {
      withStatus({ phase: 'queued', new_items_count: 2, queued_count: 2 });

      expect(component.getRefreshHeadline()).toBe('Downloads were queued');
      expect(component.getRefreshDescription()).toBe('The refresh queued download jobs successfully.');
    });

    it('sums up a refresh that found more than it skipped', () => {
      withStatus({ phase: 'queued', new_items_count: 3, queued_count: 3, skipped_count: 1 });

      expect(component.getRefreshHeadline()).toBe('Refresh completed with skips');
      expect(component.getRefreshDescription()).toBe('The refresh found 3 new item(s), but 1 were skipped because they are unavailable or members-only.');
    });

    it('says what a finished refresh did', () => {
      withStatus({ phase: 'complete', new_items_count: 2, queued_count: 2 });
      expect(component.getRefreshHeadline()).toBe('Channel is up to date');
      expect(component.getRefreshDescription()).toBe('The refresh finished successfully.');

      withStatus({ phase: 'complete', new_items_count: 0 });
      expect(component.getRefreshDescription()).toBe('The last refresh did not find any new videos to download.');
    });

    it('says a refresh was stopped', () => {
      withStatus({ phase: 'cancelled' });

      expect(component.shouldShowRefreshStatus()).toBe(true);
      expect(component.getRefreshHeadline()).toBe('Refresh cancelled');
      expect(component.getRefreshDescription()).toBe('The refresh was stopped before it finished collecting metadata or queueing all downloads.');
    });

    it('names a check that has started before it says what it is doing', () => {
      withStatus({ phase: 'idle' }, { downloading: true });
      expect(component.getRefreshHeadline()).toBe('Checking channel metadata');

      withStatus({ phase: 'idle' }, { downloading: true, isPlaylist: true });
      expect(component.getRefreshHeadline()).toBe('Checking playlist metadata');

      withStatus({ phase: 'idle' }, { isPlaylist: true });
      expect(component.getRefreshHeadline()).toBe('Playlist refresh');
      expect(component.getRefreshDescription()).toBe('The subscription page will show completed files only.');
    });

    it('has nothing to say without a refresh', () => {
      component.subscription = { id: 'sub-1', name: 'Test subscription' } as any;

      expect(component.getRefreshProgressMode()).toBe('indeterminate');
      expect(component.getRefreshProgressValue()).toBe(0);
      expect(component.getRefreshMetrics()).toEqual([]);
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

    it('keeps a check that did not finish to one quiet line, with the details folded away', () => {
      component.subscription = {
        id: 'sub-1', name: 'Test', refresh_status: { phase: 'error', error: '[site] abc: This live event will begin in a few moments.' }
      } as any;

      expect(component.statusText()).toBe('Last check didn\'t finish');
      expect(component.shouldShowRefreshStatus()).toBe(true);
      expect(component.refreshDetailsOpen).toBe(false);
      expect(component.getRefreshHeadline()).toBe('Check didn\'t finish');
      expect(component.getRefreshDescription()).not.toContain('This live event');
    });

    it('says a subscription is paused', () => {
      component.subscription = { id: 'sub-1', name: 'Test', paused: true, refresh_status: { phase: 'complete' } } as any;

      expect(component.statusText()).toBe('Paused');
    });

    it('says when the link of a subscription could not be read', () => {
      component.subscription = { id: 'sub-1', name: null, url: 'https://example.com/nope', refresh_status: { phase: 'idle' } } as any;

      expect(component.statusText()).toBe('Couldn\'t read this link');
    });

    it('names a playlist as one', () => {
      component.subscription = { id: 'sub-1', name: 'Test', isPlaylist: true, refresh_status: { phase: 'complete' } } as any;

      expect(component.getRefreshHeadline()).toBe('Playlist is up to date');
    });
  });
});
