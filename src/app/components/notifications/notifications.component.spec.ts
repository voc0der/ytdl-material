import { waitForAsync, ComponentFixture, TestBed } from '@angular/core/testing';
import { of, Subject } from 'rxjs';
import { Notification, NotificationAction, NotificationType } from 'api-types';

import { NOTIFICATION_ROW_HEIGHT } from '../notifications-list/notifications-list.component';

import { NotificationsComponent } from './notifications.component';
import { configureTestBed } from '../../../testing/test-bed';

describe('NotificationsComponent', () => {
  let component: NotificationsComponent;
  let fixture: ComponentFixture<NotificationsComponent>;

  beforeEach(waitForAsync(() => {
    configureTestBed({
      imports: [ NotificationsComponent ]
    })
    .compileComponents();
  }));

  beforeEach(() => {
    fixture = TestBed.createComponent(NotificationsComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});

describe('NotificationsComponent filtering', () => {
  let component: NotificationsComponent;

  const notification = (type: string, uid: string) => ({ type, uid, read: false, timestamp: 1, actions: [], data: {} }) as any;

  beforeEach(() => {
    const posts_service: any = {
      initialized: true,
      service_initialized: of(true),
      hasSession: () => true,
      getNotifications: vi.fn().mockName('getNotifications').mockReturnValue(of({
        notifications: [notification('download_complete', 'a'), notification('download_error', 'b'), notification('task_finished', 'c')]
      }))
    };
    component = new NotificationsComponent(posts_service, {} as any, {} as any);
    component.getNotifications();
  });

  it('shows everything until a kind is picked', () => {
    expect(component.filtered_notifications.length).toBe(3);
  });

  it('adds and removes a kind as it is pressed', () => {
    component.toggleFilter('download_error');
    expect(component.filtered_notifications.map(entry => entry.uid)).toEqual(['b']);

    component.toggleFilter('task_finished');
    expect(component.filtered_notifications.map(entry => entry.uid)).toEqual(['b', 'c']);

    component.toggleFilter('download_error');
    expect(component.filtered_notifications.map(entry => entry.uid)).toEqual(['c']);

    component.toggleFilter('task_finished');
    expect(component.filtered_notifications.length).toBe(3);
  });

  it('sizes the list from the rows it will hold', () => {
    component.toggleFilter('download_error');
    expect(component.list_height).toBe(`${NOTIFICATION_ROW_HEIGHT}px`);
  });
});

describe('NotificationsComponent before anybody logs in', () => {
  it('asks for nothing, since there is nobody to have any', () => {
    const posts_service: any = {
      initialized: true,
      service_initialized: of(true),
      hasSession: () => false,
      notifications_changed: new Subject<void>(),
      getNotifications: vi.fn().mockName('getNotifications').mockReturnValue(of({ notifications: [] }))
    };
    const component = new NotificationsComponent(posts_service, {} as any, {} as any);

    component.ngOnInit();

    expect(posts_service.getNotifications).not.toHaveBeenCalled();
  });
});

describe('NotificationsComponent after playback', () => {
  it('refreshes the list and unread count without opening the bell, and stops on destroy', () => {
    const notifications_changed = new Subject<void>();
    const note = {uid: 'played', type: 'download_complete', read: false, timestamp: 1, data: {file_uid: 'file-1'}};
    const posts_service: any = {
      initialized: true,
      hasSession: () => true,
      notifications_changed,
      getNotifications: vi.fn().mockReturnValueOnce(of({notifications: [note]})).mockReturnValue(of({notifications: []}))
    };
    const component = new NotificationsComponent(posts_service, {} as any, {} as any);
    const count = vi.fn();
    component.notificationCount.subscribe(count);
    component.ngOnInit();
    expect(count).toHaveBeenLastCalledWith(1);

    notifications_changed.next();
    expect(component.notifications).toEqual([]);
    expect(component.filtered_notifications).toEqual([]);
    expect(count).toHaveBeenLastCalledWith(0);

    component.ngOnDestroy();
    notifications_changed.next();
    expect(posts_service.getNotifications).toHaveBeenCalledTimes(2);
  });
});

describe('NotificationsComponent actions', () => {
  let component: NotificationsComponent;
  let posts: any;
  let router: any;
  let count: ReturnType<typeof vi.fn>;
  const notification = (uid: string, type: NotificationType, timestamp: number, read = false): Notification => ({
    uid, type, timestamp, read, data: {file_uid: 'file-1', download_uid: 'download-1'}
  });
  const notes = () => [
    notification('old', NotificationType.DOWNLOAD_COMPLETE, 1),
    notification('read', NotificationType.TASK_FINISHED, 3, true),
    notification('retry', NotificationType.DOWNLOAD_ERROR, 2)
  ];

  beforeEach(() => {
    posts = {
      initialized: true,
      hasSession: () => true,
      notifications_changed: new Subject<void>(),
      getNotifications: vi.fn().mockImplementation(() => of({notifications: notes()})),
      restartDownload: vi.fn().mockReturnValue(of({success: true})),
      deleteNotification: vi.fn().mockReturnValue(of({success: true})),
      deleteAllNotifications: vi.fn().mockReturnValue(of({success: true})),
      setNotificationsToRead: vi.fn().mockReturnValue(of({success: true})),
      openSnackBar: vi.fn()
    };
    router = {navigate: vi.fn()};
    component = new NotificationsComponent(posts, router, {} as any);
    count = vi.fn();
    component.notificationCount.subscribe(count);
  });

  afterEach(() => component.ngOnDestroy());

  it('waits for initialization, then sorts newest first and counts unread items across filters', () => {
    const initialized = new Subject<boolean>();
    posts.initialized = false;
    posts.service_initialized = initialized;
    component.selectedFilters = ['download_error'];
    component.ngOnInit();
    initialized.next(false);
    expect(posts.getNotifications).not.toHaveBeenCalled();
    initialized.next(true);
    initialized.next(true);
    initialized.complete();
    expect(posts.getNotifications).toHaveBeenCalledTimes(1);
    expect(component.notifications.map(note => note.uid)).toEqual(['read', 'retry', 'old']);
    expect(component.filtered_notifications.map(note => note.uid)).toEqual(['retry']);
    expect(count).toHaveBeenCalledWith(2);
  });

  it.each([
    [NotificationAction.PLAY, ['/'], {queryParams: {uid: 'file-1'}}],
    [NotificationAction.VIEW_DOWNLOAD_ERROR, ['downloads'], undefined],
    [NotificationAction.VIEW_TASKS, ['tasks'], undefined]
  ])('navigates to the destination for %s', (action, commands, extras) => {
    component.notificationAction({notification: notes()[0], action});
    expect(router.navigate.mock.calls).toEqual([extras ? [commands, extras] : [commands]]);
  });

  it('retries a download before deleting its error notification and updates the unread count', () => {
    const restarted = new Subject<any>();
    posts.restartDownload.mockReturnValue(restarted);
    component.getNotifications();
    component.toggleFilter('download_error');
    component.notificationAction({notification: notes()[2], action: NotificationAction.RETRY_DOWNLOAD});
    expect(posts.restartDownload).toHaveBeenCalledWith('download-1');
    expect(posts.deleteNotification).not.toHaveBeenCalled();

    restarted.next({success: true});
    restarted.complete();
    expect(posts.openSnackBar).toHaveBeenCalledWith('Download restarted!');
    expect(posts.deleteNotification).toHaveBeenCalledWith('retry');
    expect(component.notifications.map(note => note.uid)).toEqual(['read', 'old']);
    expect(component.filtered_notifications).toEqual([]);
    expect(count).toHaveBeenLastCalledWith(1);
  });

  it('waits for deletion to finish before removing a notification locally', () => {
    const deleted = new Subject<any>();
    posts.deleteNotification.mockReturnValue(deleted);
    component.getNotifications();
    component.deleteNotification('old');
    expect(component.notifications).toHaveLength(3);
    expect(count).toHaveBeenLastCalledWith(2);
    deleted.next({success: true});
    deleted.complete();
    expect(component.notifications.map(note => note.uid)).toEqual(['read', 'retry']);
    expect(count).toHaveBeenLastCalledWith(1);
  });

  it('can finish deleting a notification before the first list arrives', () => {
    component.deleteNotification('old');
    expect(posts.deleteNotification).toHaveBeenCalledWith('old');
    expect(component.notifications).toBeNull();
    expect(count).not.toHaveBeenCalled();
  });

  it('clears the list and refreshes it after deleting all notifications', () => {
    component.getNotifications();
    const refresh = new Subject<any>();
    posts.getNotifications.mockReturnValue(refresh);
    component.deleteAllNotifications();
    expect(posts.deleteAllNotifications).toHaveBeenCalledTimes(1);
    expect(component.notifications).toEqual([]);
    expect(component.filtered_notifications).toEqual([]);
    expect(count).toHaveBeenLastCalledWith(0);
    expect(posts.getNotifications).toHaveBeenCalledTimes(2);
    refresh.next({notifications: []});
    refresh.complete();
  });

  it('marks every loaded notification as read even when only one type is visible', () => {
    component.getNotifications();
    component.toggleFilter('download_error');
    posts.getNotifications.mockReturnValue(of({notifications: notes().map(note => ({...note, read: true}))}));
    component.setNotificationsToRead();
    expect(posts.setNotificationsToRead).toHaveBeenCalledWith(['read', 'retry', 'old']);
    expect(posts.getNotifications).toHaveBeenCalledTimes(2);
    expect(component.notifications.every(note => note.read)).toBe(true);
    expect(component.filtered_notifications.map(note => note.uid)).toEqual(['retry']);
    expect(count).toHaveBeenLastCalledWith(0);
  });
});
