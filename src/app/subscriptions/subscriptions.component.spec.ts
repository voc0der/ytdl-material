import { BehaviorSubject, of } from 'rxjs';

import { SubscriptionsComponent } from './subscriptions.component';

describe('SubscriptionsComponent', () => {
  let component: SubscriptionsComponent;
  let dialog: any;
  let postsService: any;
  let router: any;
  let snackBar: any;

  beforeEach(() => {
    dialog = {
      open: vi.fn().mockName('open')
    };
    postsService = {
      initialized: false,
      service_initialized: new BehaviorSubject<boolean>(false),
      files_changed: new BehaviorSubject<boolean>(false),
      getAllSubscriptions: vi.fn().mockName('getAllSubscriptions').mockReturnValue(of({ subscriptions: [] })),
      getSubscriptionByID: vi.fn().mockName('getSubscriptionByID'),
      redownloadSubscription: vi.fn().mockName('redownloadSubscription'),
      reloadSubscriptions: vi.fn().mockName('reloadSubscriptions')
    };
    router = {
      navigate: vi.fn().mockName('navigate')
    };
    snackBar = {
      open: vi.fn().mockName('open')
    };

    component = new SubscriptionsComponent(dialog, postsService, router, snackBar);
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('confirms before redownloading subscription files', () => {
    const sub = { id: 'sub-1', name: 'Test subscription' } as any;
    dialog.open.mockReturnValue({ afterClosed: () => of(true) });
    postsService.redownloadSubscription.mockReturnValue(of({ success: true }));
    vi.spyOn(postsService.files_changed, 'next').mockReturnValue(undefined);

    component.confirmRedownloadSubscription(sub);

    expect(dialog.open).toHaveBeenCalled();
    expect(postsService.redownloadSubscription).toHaveBeenCalledWith('sub-1');
    expect(postsService.getAllSubscriptions).toHaveBeenCalled();
    expect(postsService.reloadSubscriptions).toHaveBeenCalled();
    expect(postsService.files_changed.next).toHaveBeenCalledWith(true);
    expect(snackBar.open).toHaveBeenCalledWith('Redownload started for Test subscription', '', { duration: 2000 });
  });

  it('does not redownload when the confirmation is dismissed', () => {
    const sub = { id: 'sub-1', name: 'Test subscription' } as any;
    dialog.open.mockReturnValue({ afterClosed: () => of(false) });

    component.confirmRedownloadSubscription(sub);

    expect(postsService.redownloadSubscription).not.toHaveBeenCalled();
  });

  it('keeps redownload available for active subscriptions', () => {
    expect(component.isRedownloadDisabled({ id: 'sub-1', name: 'Test subscription', downloading: true } as any)).toBe(false);
  });

  it('disables redownload until a subscription has a name', () => {
    expect(component.isRedownloadDisabled({ id: 'sub-1', name: null } as any)).toBe(true);
  });
});
