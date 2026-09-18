import { ComponentFixture, TestBed, waitForAsync } from '@angular/core/testing';

import { ModifyUsersComponent } from './modify-users.component';
import { configureTestBed } from '../../../testing/test-bed';

describe('ModifyUsersComponent', () => {
  let component: ModifyUsersComponent;
  let fixture: ComponentFixture<ModifyUsersComponent>;

  beforeEach(waitForAsync(() => {
    configureTestBed({
      imports: [ ModifyUsersComponent ]
    })
    .compileComponents();
  }));

  beforeEach(() => {
    fixture = TestBed.createComponent(ModifyUsersComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});

describe('ModifyUsersComponent list', () => {
  let component: ModifyUsersComponent;

  const user = (name: string, role = 'user') => ({ uid: `uid-${name}`, name, role }) as any;

  beforeEach(() => {
    const posts_service: any = {};
    component = new ModifyUsersComponent(posts_service, {} as any, {} as any, {} as any);
    component.pageSize = 2;
    component.users = [user('ada'), user('brian', 'admin'), user('carol'), user('dave'), user('erin')];
  });

  it('shows a page at a time', () => {
    expect(component.pageCount).toBe(3);
    expect(component.pageUsers.map(entry => entry.name)).toEqual(['ada', 'brian']);
    expect(component.rangeStart).toBe(1);
    expect(component.rangeEnd).toBe(2);

    component.goToPage(2);

    expect(component.pageUsers.map(entry => entry.name)).toEqual(['erin']);
    expect(component.rangeEnd).toBe(5);
  });

  it('will not page past either end', () => {
    component.goToPage(9);
    expect(component.pageIndex).toBe(2);

    component.goToPage(-1);
    expect(component.pageIndex).toBe(0);
  });

  it('searches the name and the role', () => {
    component.filterChanged('car');
    expect(component.visibleUsers.map(entry => entry.name)).toEqual(['carol']);

    component.filterChanged('admin');
    expect(component.visibleUsers.map(entry => entry.name)).toEqual(['brian']);

    component.filterChanged('');
    expect(component.visibleUsers.length).toBe(5);
  });

  it('goes back to the first page when the search changes', () => {
    component.goToPage(2);

    component.filterChanged('a');

    expect(component.pageIndex).toBe(0);
  });

  it('leaves no one on a page that no longer exists', () => {
    component.goToPage(2);
    component.users = [user('ada')];

    component.createAndSortData();

    expect(component.pageIndex).toBe(0);
    expect(component.pageUsers.map(entry => entry.name)).toEqual(['ada']);
  });

  it('sorts by name', () => {
    component.users = [user('zoe'), user('ada'), user('mike')];

    component.createAndSortData();

    expect(component.users.map(entry => entry.name)).toEqual(['ada', 'mike', 'zoe']);
  });

  it('has nothing to show before the users arrive', () => {
    component.users = undefined;

    expect(component.visibleUsers).toEqual([]);
    expect(component.pageUsers).toEqual([]);
    expect(component.rangeStart).toBe(0);
  });
});
