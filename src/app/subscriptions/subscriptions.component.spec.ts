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
      open: jasmine.createSpy('open')
    };
    postsService = {
      initialized: false,
      service_initialized: new BehaviorSubject<boolean>(false),
      files_changed: new BehaviorSubject<boolean>(false),
      getAllSubscriptions: jasmine.createSpy('getAllSubscriptions').and.returnValue(of({subscriptions: []})),
      getSubscriptionByID: jasmine.createSpy('getSubscriptionByID'),
      redownloadSubscription: jasmine.createSpy('redownloadSubscription'),
      reloadSubscriptions: jasmine.createSpy('reloadSubscriptions')
    };
    router = {
      navigate: jasmine.createSpy('navigate')
    };
    snackBar = {
      open: jasmine.createSpy('open')
    };

    component = new SubscriptionsComponent(dialog, postsService, router, snackBar);
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('confirms before redownloading subscription files', () => {
    const sub = {id: 'sub-1', name: 'Test subscription'} as any;
    dialog.open.and.returnValue({afterClosed: () => of(true)});
    postsService.redownloadSubscription.and.returnValue(of({success: true}));
    spyOn(postsService.files_changed, 'next');

    component.confirmRedownloadSubscription(sub);

    expect(dialog.open).toHaveBeenCalled();
    expect(postsService.redownloadSubscription).toHaveBeenCalledWith('sub-1');
    expect(postsService.getAllSubscriptions).toHaveBeenCalled();
    expect(postsService.reloadSubscriptions).toHaveBeenCalled();
    expect(postsService.files_changed.next).toHaveBeenCalledWith(true);
    expect(snackBar.open).toHaveBeenCalledWith('Redownload started for Test subscription', '', {duration: 2000});
  });

  it('does not redownload when the confirmation is dismissed', () => {
    const sub = {id: 'sub-1', name: 'Test subscription'} as any;
    dialog.open.and.returnValue({afterClosed: () => of(false)});

    component.confirmRedownloadSubscription(sub);

    expect(postsService.redownloadSubscription).not.toHaveBeenCalled();
  });

  it('keeps redownload available for active subscriptions', () => {
    expect(component.isRedownloadDisabled({id: 'sub-1', name: 'Test subscription', downloading: true} as any)).toBeFalse();
  });

  it('disables redownload until a subscription has a name', () => {
    expect(component.isRedownloadDisabled({id: 'sub-1', name: null} as any)).toBeTrue();
  });
});
