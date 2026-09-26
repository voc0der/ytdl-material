import { BehaviorSubject, of, throwError } from 'rxjs';

import { SubscriptionActionsService } from './subscription-actions.service';

describe('SubscriptionActionsService', () => {
  let service: SubscriptionActionsService;
  let postsService: any;
  let dialog: any;

  const sub = (overrides: Record<string, unknown> = {}) => ({
    id: 'sub-1',
    name: 'Test subscription',
    url: 'https://example.com/channel',
    file_count: 4,
    ...overrides
  }) as any;

  const confirms = (confirmed: boolean) => dialog.open.mockReturnValue({ afterClosed: () => of(confirmed) });
  const dialogData = () => dialog.open.mock.calls[0][1].data;

  beforeEach(() => {
    postsService = {
      path: 'http://localhost:17442/api/',
      token: null,
      isLoggedIn: false,
      files_changed: new BehaviorSubject<boolean>(false),
      checkSubscription: vi.fn().mockName('checkSubscription').mockReturnValue(of({ success: true })),
      cancelCheckSubscription: vi.fn().mockName('cancelCheckSubscription').mockReturnValue(of({ success: true })),
      updateSubscription: vi.fn().mockName('updateSubscription').mockReturnValue(of({ success: true })),
      unsubscribe: vi.fn().mockName('unsubscribe').mockReturnValue(of({ success: true })),
      redownloadSubscription: vi.fn().mockName('redownloadSubscription').mockReturnValue(of({ success: true })),
      downloadArchive: vi.fn().mockName('downloadArchive'),
      reloadSubscriptions: vi.fn().mockName('reloadSubscriptions'),
      openSnackBar: vi.fn().mockName('openSnackBar')
    };
    dialog = { open: vi.fn().mockName('open') };

    service = new SubscriptionActionsService(postsService, dialog);
  });

  describe('cover', () => {
    it('points at the thumbnail of the file the backend named', () => {
      expect(service.coverURL(sub({ thumbnail_file_uid: 'file-1' })))
        .toBe('http://localhost:17442/api/thumbnail/file-1');
    });

    it('carries the token when logged in', () => {
      postsService.isLoggedIn = true;
      postsService.token = 'a token';

      expect(service.coverURL(sub({ thumbnail_file_uid: 'file-1' }))).toContain('?jwt=a%20token');
    });

    it('has no cover for a subscription with no downloads yet', () => {
      expect(service.coverURL(sub())).toBeNull();
    });
  });

  describe('artwork', () => {
    it('points at the subscription\'s own image, versioned by when it last changed', () => {
      expect(service.artworkURL(sub({ artwork_updated_at: 1234 })))
        .toBe('http://localhost:17442/api/subscriptionArtwork/sub-1?v=1234');
    });

    it('carries the token when logged in', () => {
      postsService.isLoggedIn = true;
      postsService.token = 'a token';

      expect(service.artworkURL(sub({ artwork_updated_at: 1234 }))).toBe(
        'http://localhost:17442/api/subscriptionArtwork/sub-1?v=1234&jwt=a%20token'
      );
    });

    it('has no artwork until the backend has fetched one', () => {
      expect(service.artworkURL(sub())).toBeNull();
    });
  });

  describe('pausing', () => {
    it('sends only the setting it changes', async () => {
      expect(await service.setPaused(sub(), true)).toBe(true);

      expect(postsService.updateSubscription).toHaveBeenCalledWith({ id: 'sub-1', paused: true });
      expect(postsService.reloadSubscriptions).toHaveBeenCalled();
    });

    it('reports a refusal instead of pretending it worked', async () => {
      postsService.updateSubscription.mockReturnValue(of({ success: false }));

      expect(await service.setPaused(sub(), true)).toBe(false);
      expect(postsService.openSnackBar).toHaveBeenCalledWith('Couldn\'t pause Test subscription.');
      expect(postsService.reloadSubscriptions).not.toHaveBeenCalled();
    });
  });

  describe('unsubscribing', () => {
    it('says the downloaded files go too', async () => {
      confirms(true);

      await service.unsubscribe(sub());

      expect(dialogData().dialogTitle).toBe('Unsubscribe from Test subscription?');
      expect(dialogData().dialogText).toContain('4 downloaded files are deleted too');
      expect(dialogData().warnSubmitColor).toBe(true);
      expect(postsService.unsubscribe).toHaveBeenCalledWith('sub-1', true);
      expect(postsService.reloadSubscriptions).toHaveBeenCalled();
    });

    it('promises no deletion when nothing was downloaded', async () => {
      confirms(true);

      await service.unsubscribe(sub({ file_count: 0 }));

      expect(dialogData().dialogText).toBe('It stops checking for new uploads.');
    });

    it('does nothing when the confirmation is dismissed', async () => {
      confirms(false);

      expect(await service.unsubscribe(sub())).toBe(false);
      expect(postsService.unsubscribe).not.toHaveBeenCalled();
    });
  });

  describe('redownloading', () => {
    it('confirms, then starts and tells the library', async () => {
      confirms(true);

      expect(await service.redownload(sub())).toBe(true);

      expect(dialogData().submitText).toBe('Delete and redownload');
      expect(postsService.redownloadSubscription).toHaveBeenCalledWith('sub-1');
      expect(postsService.openSnackBar).toHaveBeenCalledWith('Redownload started for Test subscription');
      expect(postsService.files_changed.value).toBe(true);
    });

    it('passes on the reason it could not start', async () => {
      confirms(true);
      postsService.redownloadSubscription.mockReturnValue(of({ success: false, error: 'busy' }));

      expect(await service.redownload(sub())).toBe(false);
      expect(postsService.openSnackBar).toHaveBeenCalledWith(
        'ERROR: Failed to start redownload for Test subscription. busy', 'OK.'
      );
    });

    it('does not redownload when the confirmation is dismissed', async () => {
      confirms(false);

      expect(await service.redownload(sub())).toBe(false);
      expect(postsService.redownloadSubscription).not.toHaveBeenCalled();
    });
  });

  describe('checking', () => {
    it('starts and stops a check', async () => {
      expect(await service.check(sub())).toBe(true);
      expect(postsService.checkSubscription).toHaveBeenCalledWith('sub-1');

      expect(await service.cancelCheck(sub())).toBe(true);
      expect(postsService.cancelCheckSubscription).toHaveBeenCalledWith('sub-1');
    });

    it('reports a check that failed outright', async () => {
      postsService.checkSubscription.mockReturnValue(throwError(() => new Error('offline')));
      vi.spyOn(console, 'error').mockImplementation(() => undefined);

      expect(await service.check(sub())).toBe(false);
      expect(postsService.openSnackBar).toHaveBeenCalledWith('Couldn\'t check Test subscription.');
    });
  });
});
