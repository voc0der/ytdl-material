import { waitForAsync, ComponentFixture, TestBed } from '@angular/core/testing';
import { of } from 'rxjs';

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
