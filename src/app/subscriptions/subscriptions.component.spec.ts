import { BehaviorSubject, of, throwError } from 'rxjs';

import { SubscriptionsComponent } from './subscriptions.component';

describe('SubscriptionsComponent', () => {
  let component: SubscriptionsComponent;
  let postsService: any;
  let actions: any;
  let router: any;

  const channel = (overrides: Record<string, unknown> = {}) => ({
    id: 'sub-1',
    name: 'A channel',
    url: 'https://example.com/channel',
    isPlaylist: false,
    file_count: 3,
    refresh_status: { phase: 'complete', completed_at: Date.now() },
    ...overrides
  });
  const playlist = (overrides: Record<string, unknown> = {}) => channel({ id: 'sub-2', name: 'B playlist', isPlaylist: true, ...overrides });

  const listReturns = (...subscriptions: unknown[]) => {
    postsService.getAllSubscriptions.mockReturnValue(of({ subscriptions }));
  };

  beforeEach(() => {
    vi.useFakeTimers();
    postsService = {
      service_initialized: new BehaviorSubject<boolean>(false),
      files_changed: new BehaviorSubject<boolean>(false),
      getAllSubscriptions: vi.fn().mockName('getAllSubscriptions').mockReturnValue(of({ subscriptions: [] })),
      createSubscription: vi.fn().mockName('createSubscription'),
      reloadSubscriptions: vi.fn().mockName('reloadSubscriptions'),
      openSnackBar: vi.fn().mockName('openSnackBar')
    };
    actions = {
      check: vi.fn().mockName('check').mockResolvedValue(true),
      cancelCheck: vi.fn().mockName('cancelCheck').mockResolvedValue(true),
      setPaused: vi.fn().mockName('setPaused').mockResolvedValue(true),
      redownload: vi.fn().mockName('redownload').mockResolvedValue(true),
      unsubscribe: vi.fn().mockName('unsubscribe').mockResolvedValue(true),
      coverURL: vi.fn().mockName('coverURL').mockReturnValue(null),
      artworkURL: vi.fn().mockName('artworkURL').mockReturnValue(null)
    };
    router = { navigate: vi.fn().mockName('navigate') };

    component = new SubscriptionsComponent(postsService, actions, router);
  });

  afterEach(() => {
    component.ngOnDestroy();
    vi.useRealTimers();
  });

  it('waits for the service before asking for subscriptions', () => {
    component.ngOnInit();
    expect(postsService.getAllSubscriptions).not.toHaveBeenCalled();

    postsService.service_initialized.next(true);

    expect(postsService.getAllSubscriptions).toHaveBeenCalled();
  });

  it('lists subscriptions by name', async () => {
    listReturns(playlist(), channel());

    await component.loadSubscriptions();

    expect(component.subscriptions.map(sub => sub.name)).toEqual(['A channel', 'B playlist']);
  });

  it('counts and filters each kind', async () => {
    listReturns(channel(), playlist());
    await component.loadSubscriptions();

    expect(component.channelCount).toBe(1);
    expect(component.playlistCount).toBe(1);
    expect(component.visibleSubscriptions.length).toBe(2);

    component.filter = 'playlists';
    expect(component.visibleSubscriptions.map(sub => sub.id)).toEqual(['sub-2']);

    component.filter = 'channels';
    expect(component.visibleSubscriptions.map(sub => sub.id)).toEqual(['sub-1']);
  });

  it('says so when the list cannot be loaded', async () => {
    postsService.getAllSubscriptions.mockReturnValue(throwError(() => new Error('nope')));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await component.loadSubscriptions();

    expect(component.loadFailed).toBe(true);
    expect(component.subscriptions).toEqual([]);
  });

  it('keeps a busy subscription up to date, and stops once it settles', async () => {
    listReturns(channel({ refresh_status: { phase: 'collecting', active: true } }));
    await component.loadSubscriptions();
    expect(postsService.getAllSubscriptions).toHaveBeenCalledTimes(1);

    listReturns(channel());
    await vi.advanceTimersByTimeAsync(5000);
    expect(postsService.getAllSubscriptions).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(30000);
    expect(postsService.getAllSubscriptions).toHaveBeenCalledTimes(2);
  });

  it('subscribes with what was chosen on the page, then clears the form', async () => {
    component.url = '  https://example.com/playlist  ';
    component.name = ' My name ';
    component.settings.maxQuality = '720';
    component.settings.timerange = 'now-1week';
    component.settings.auto_create_playlist = true;
    postsService.createSubscription.mockReturnValue(of({ new_sub: { id: 'sub-9', name: 'Subscribed' } }));

    await component.subscribe();

    expect(postsService.createSubscription).toHaveBeenCalledWith(
      'https://example.com/playlist', 'My name', 'now-1week', '720', false, '', '', true, true, false
    );
    expect(component.url).toBe('');
    expect(component.name).toBe('');
    expect(component.settings.maxQuality).toBe('best');
    expect(component.subscribeError).toBeNull();
    expect(postsService.reloadSubscriptions).toHaveBeenCalled();
  });

  it('subscribes without a custom name when none was given', async () => {
    component.url = 'https://example.com/channel';
    postsService.createSubscription.mockReturnValue(of({ new_sub: { id: 'sub-9' } }));

    await component.subscribe();

    expect(postsService.createSubscription.mock.calls[0][1]).toBeNull();
  });

  it('keeps the link and explains when subscribing fails', async () => {
    component.url = 'https://example.com/nope';
    postsService.createSubscription.mockReturnValue(of({ new_sub: null, error: 'Unsupported URL' }));

    await component.subscribe();

    expect(component.subscribeError).toBe('Unsupported URL');
    expect(component.url).toBe('https://example.com/nope');
    // The failed link is saved without a name, so the list is reloaded to show it.
    expect(postsService.getAllSubscriptions).toHaveBeenCalled();
  });

  it('explains a request that never answered', async () => {
    component.url = 'https://example.com/nope';
    postsService.createSubscription.mockReturnValue(throwError(() => new Error('offline')));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await component.subscribe();

    expect(component.subscribeError).toBe('Couldn\'t subscribe. Try again in a moment.');
    expect(component.subscribing).toBe(false);
  });

  it('does nothing without a link', async () => {
    component.url = '   ';

    await component.subscribe();

    expect(postsService.createSubscription).not.toHaveBeenCalled();
  });

  it('marks the options chip when something other than the defaults is set', () => {
    expect(component.hasCustomOptions).toBe(false);

    component.settings.custom_args = '--verbose';

    expect(component.hasCustomOptions).toBe(true);
  });

  it('opens a subscription on its own page with the settings showing', () => {
    component.openSettings(channel() as any);

    expect(router.navigate).toHaveBeenCalledWith(['/subscription', { id: 'sub-1', settings: true }]);
  });

  it('reloads after an action that changed something', async () => {
    listReturns(channel());
    await component.loadSubscriptions();
    const loads = postsService.getAllSubscriptions.mock.calls.length;

    await component.setPaused(channel() as any, true);

    expect(actions.setPaused).toHaveBeenCalledWith(expect.objectContaining({ id: 'sub-1' }), true);
    expect(postsService.getAllSubscriptions.mock.calls.length).toBe(loads + 1);
  });

  it('does not reload when an action was cancelled', async () => {
    actions.unsubscribe.mockResolvedValue(false);
    listReturns(channel());
    await component.loadSubscriptions();
    const loads = postsService.getAllSubscriptions.mock.calls.length;

    await component.unsubscribe(channel() as any);

    expect(postsService.getAllSubscriptions.mock.calls.length).toBe(loads);
  });

  describe('what a card says', () => {
    it('names the state of a subscription that needs attention', () => {
      expect(component.statusText(channel({ name: null }) as any)).toBe('Couldn\'t read this link');
      expect(component.statusText(channel({ paused: true }) as any)).toBe('Paused');
      expect(component.statusText(channel({ refresh_status: { phase: 'error' } }) as any)).toBe('Last check didn\'t finish');
    });

    it('counts what is still downloading', () => {
      const sub = channel({ refresh_status: { phase: 'queued', pending_download_count: 2 } });

      expect(component.statusText(sub as any)).toBe('Downloading 2 new');
      expect(component.isBusy(sub as any)).toBe(true);
    });

    it('says when a quiet subscription was last checked', () => {
      const sub = channel({ refresh_status: { phase: 'complete', completed_at: Date.now() - 5 * 60_000 } });

      expect(component.statusText(sub as any)).toContain('Checked');
      expect(component.statusText(channel({ refresh_status: { phase: 'idle' } }) as any)).toBe('Not checked yet');
    });

    it('stands in for a cover with the first letter of the name', () => {
      expect(component.initial(channel() as any)).toBe('A');
      expect(component.initial(channel({ name: null }) as any)).toBe('?');
    });

    it('previews the newest download, and shows the channel\'s avatar until there is one', () => {
      actions.artworkURL.mockReturnValue('/api/subscriptionArtwork/sub-1?v=1');

      expect(component.coverURL(channel() as any)).toBe('/api/subscriptionArtwork/sub-1?v=1');
      expect(component.coverIsAvatar(channel() as any)).toBe(true);
      // A playlist's own image is a cover like any thumbnail, not an avatar.
      expect(component.coverIsAvatar(playlist() as any)).toBe(false);

      actions.coverURL.mockReturnValue('/api/thumbnail/file-1');
      expect(component.coverURL(channel() as any)).toBe('/api/thumbnail/file-1');
      expect(component.coverIsAvatar(channel() as any)).toBe(false);
    });
  });
});
