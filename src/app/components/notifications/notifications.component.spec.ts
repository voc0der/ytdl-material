import { waitForAsync, ComponentFixture, TestBed } from '@angular/core/testing';
import { of, Subject } from 'rxjs';

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
