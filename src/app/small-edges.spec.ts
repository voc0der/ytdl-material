import { of, Subject, throwError } from 'rxjs';
import { FormControl } from '@angular/forms';

import { appConfig } from './app.config';
import { PostsService } from './posts.services';
import { environment as production } from '../environments/environment.prod';
import { environment as codespaces } from '../environments/environment.codespaces';
import { formatRelativeDate, formatRelativeTime } from './utils/relative-time';
import { takePlayerTabQueue } from './utils/player-link';
import { MediaLibraryNavigationStateService } from './media-library-navigation-state.service';
import { ModifyUsersComponent } from './components/modify-users/modify-users.component';
import { UpdaterComponent } from './updater/updater.component';
import { NotificationsComponent } from './components/notifications/notifications.component';
import { DuplicatesComponent } from './components/duplicates/duplicates.component';
import { LoginComponent } from './components/login/login.component';
import { SortPropertyComponent } from './components/sort-property/sort-property.component';
import { SubscriptionComponent } from './subscription/subscription/subscription.component';
import { UnifiedFileCardComponent } from './components/unified-file-card/unified-file-card.component';
import { ArgModifierDialogComponent } from './dialogs/arg-modifier-dialog/arg-modifier-dialog.component';

// Small turns in small pieces of the app, built without a template.
describe('Small edges', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    sessionStorage.clear();
  });

  it('builds the app with its own services, and each build with its own settings', () => {
    expect(appConfig.providers).toContain(PostsService);
    expect(production).toEqual({ production: true, codespaces: false });
    expect(codespaces).toEqual({ production: false, codespaces: true });
  });

  it('formats a relative time even for a locale it does not know', () => {
    const now = Date.UTC(2026, 0, 2);
    expect(formatRelativeTime(now - 60_000, now, 'not a locale!')).toMatch(/minute/);
    expect(formatRelativeDate(now - 86_400_000, now, 'not a locale!')).toMatch(/yesterday|day/);
  });

  it('ignores a queue handed over from another tab that it cannot read', () => {
    sessionStorage.setItem('playerQueueForNewTab', '{not json');
    expect(takePlayerTabQueue()).toBeUndefined();
  });

  it('keeps an empty list for files or playlists it was not given', () => {
    const posts: any = { files_changed: new Subject(), playlists_changed: new Subject(), library_changed: new Subject() };
    const navigation = new MediaLibraryNavigationStateService(posts);
    navigation.savePendingRestoreState({ snapshot: { routeKey: '/', subId: null, selectedFilters: [] } as any, files: null,
      playlistLibraryItems: null, playlistLibraryReceived: false });
    const restored = navigation.consumePendingRestoreState('/', null);
    expect([restored.files, restored.playlistLibraryItems]).toEqual([[], []]);
  });

  it('says when a user could not be saved, and has no place for one it does not list', () => {
    const posts: any = { changeUser: () => of({ success: false }) };
    const users = new ModifyUsersComponent(posts, {} as any, {} as any, {} as any);
    users.users = [{ uid: 'alice' }] as any;
    expect(users.indexOfUser('bob')).toBe(-1);
    users.setUser({ uid: 'alice', name: 'Alice' });
    expect(users.editError).toBe('Could not save this user.');
    expect(users.saving).toBe(false);
  });

  it('orders the nightly build last and a release after its own prerelease, and lists versions without version info', () => {
    const posts: any = { version_info: null, getVersionInfo: () => throwError(() => new Error('offline')) };
    const updater = new UpdaterComponent(posts, {} as any);
    expect(updater.compareReleaseVersions('nightly', 'v1.3.4')).toBe(1);
    expect(updater.compareReleaseVersions('v1.3.4', 'v1.3.4-rc1')).toBe(1);
    const list = vi.spyOn(updater, 'getAvailableVersions').mockImplementation(() => {});
    updater.loadCurrentVersionAndAvailableVersions();
    expect(list).toHaveBeenCalled();
  });

  it('logs a notification action it does not know', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    new NotificationsComponent({} as any, { navigate: vi.fn() } as any, {} as any)
      .notificationAction({ notification: { uid: 'note' } as any, action: 'unknown' as any });
    expect(error).toHaveBeenCalledWith('Notification action unknown does not exist!');
  });

  it('checks for duplicates again on its interval', () => {
    vi.useFakeTimers();
    const posts: any = { config: { Extra: { file_manager_enabled: true } }, hasPermission: () => true };
    const duplicates = new DuplicatesComponent(posts, { navigate: vi.fn() } as any, {} as any);
    const check = vi.spyOn(duplicates, 'getDuplicates').mockImplementation(() => {});
    (duplicates as any).startRefreshing();
    vi.advanceTimersByTime(duplicates.duplicates_check_interval);
    expect(check).toHaveBeenCalledTimes(2);
    duplicates.ngOnDestroy();
  });

  it('asks the server once while a header sign-in is under way', () => {
    const posts: any = { headerLogin: vi.fn() };
    const login = new LoginComponent(posts, {} as any, {} as any, {} as any);
    login.headerSigningIn = true;
    login.signInWithHeader();
    expect(posts.headerLogin).not.toHaveBeenCalled();
  });

  it('passes on no change to a sort it does not offer', () => {
    const sort = new SortPropertyComponent();
    const changes: unknown[] = [];
    sort.sortOptionChanged.subscribe(change => changes.push(change));
    sort.emitSortOptionChanged('nonsense');
    expect(changes).toEqual([]);
  });

  describe('a subscription page', () => {
    const page = (subscription: any) => {
      const component = new SubscriptionComponent({} as any, {} as any, {} as any, {} as any, {} as any);
      component.subscription = subscription;
      return component;
    };

    it('shows a question mark for a subscription it has not loaded', () => {
      expect(page(null).initial).toBe('?');
    });

    it('logs a failure to load the subscription', () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const component = new SubscriptionComponent({ getSubscription: () => throwError(() => new Error('gone')) } as any, {} as any, {} as any,
        {} as any, {} as any);
      component.id = 'sub';
      component.getSubscription();
      expect(error).toHaveBeenCalledWith(expect.any(Error));
    });

    it('mentions skipped uploads while others are still downloading or the check is still going', () => {
      const queued = page({ refresh_status: { phase: 'queued', pending_download_count: 0, running_download_count: 1, skipped_count: 2 } });
      const complete = page({ refresh_status: { phase: 'complete', active: true, skipped_count: 1 } });
      for (const component of [queued, complete]) {
        expect(component.getRefreshDescription()).toBe((component as any).getSkippedRefreshDescription(component.getRefreshStatus()));
      }
    });
  });

  describe('a file card', () => {
    it('has no date without a file, and shows a duration already written out as it is', () => {
      const card = new UnifiedFileCardComponent({} as any, { activate: vi.fn() } as any);
      card.file_obj = null;
      expect(card.displayedDateValue).toBeNull();
      card.file_obj = { uid: 'clip', duration: '1:23' } as any;
      card.loading = false;
      vi.spyOn(card as any, 'updateThumbnailURL').mockImplementation(() => {});
      card.ngOnInit();
      expect(card.file_length).toBe('1:23');
    });

    it('starts the preview delay over when the pointer comes back', () => {
      vi.useFakeTimers();
      const card = new UnifiedFileCardComponent({} as any, { activate: vi.fn(), release: vi.fn() } as any);
      card.file_obj = { uid: 'clip', isAudio: false } as any;
      card.loading = false;
      card.onMouseOver();
      const first = card.previewHoverTimeout;
      card.onMouseOver();
      expect(card.previewHoverTimeout).not.toBe(first);
      card.ngOnDestroy();
    });
  });

  it('fills the argument field with the suggestion highlighted when the list closes', () => {
    expect(ArgModifierDialogComponent.forRoot().ngModule).toBe(ArgModifierDialogComponent);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const closing = new Subject<void>();
    const dialog = new ArgModifierDialogComponent(null, {} as any, {} as any);
    dialog.chipCtrl = new FormControl('');
    dialog.autoTrigger = { panelClosingActions: closing, activeOption: { value: '--embed-subs' } } as any;
    dialog.ngAfterViewInit();
    closing.next();
    expect(dialog.chipCtrl.value).toBe('--embed-subs');
  });
});
