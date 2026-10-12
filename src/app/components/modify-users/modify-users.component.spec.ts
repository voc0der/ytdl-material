import { ComponentFixture, TestBed, waitForAsync } from '@angular/core/testing';
import { of, Subject, throwError } from 'rxjs';

import { ModifyUsersComponent } from './modify-users.component';
import { AddUserDialogComponent } from 'app/dialogs/add-user-dialog/add-user-dialog.component';
import { ManageUserComponent } from '../manage-user/manage-user.component';
import { ManageRoleComponent } from '../manage-role/manage-role.component';
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

describe('ModifyUsersComponent actions', () => {
  let component: ModifyUsersComponent;
  let postsService: any;
  let snackBar: any;
  let dialog: any;
  let dialogRef: any;
  // The dialog most recently opened closes when this emits.
  let closed: Subject<any>;

  const users = () => [{ uid: 'zed', name: 'zed', role: 'user' }, { uid: 'amy', name: 'amy', role: 'admin' }];

  beforeEach(() => {
    postsService = {
      getUsers: vi.fn(() => of({ users: users() })),
      getRoles: vi.fn().mockReturnValue(of({ roles: { admin: { permissions: [] }, user: { permissions: [] } } })),
      changeUser: vi.fn().mockReturnValue(of({ success: true })),
      deleteUser: vi.fn().mockReturnValue(of({ success: true })),
      isOIDCEnabled: vi.fn().mockReturnValue(false),
      isHeaderAuthEnabled: vi.fn().mockReturnValue(false)
    };
    snackBar = { open: vi.fn() };
    dialog = { open: vi.fn(() => {
      closed = new Subject();
      return { afterClosed: () => closed };
    }) };
    dialogRef = { close: vi.fn() };
    component = new ModifyUsersComponent(postsService, snackBar, dialog, dialogRef);
    component.ngOnInit();
  });

  it('loads the users, sorted by name, and the roles', () => {
    expect(component.users.map(user => user.name)).toEqual(['amy', 'zed']);
    expect(Object.keys(component.roles)).toEqual(['admin', 'user']);
  });

  it('adds a user from its dialog, and says whether that worked', () => {
    component.openAddUserDialog();
    expect(dialog.open).toHaveBeenCalledWith(AddUserDialogComponent, expect.objectContaining({ panelClass: 'kit-dialog-panel' }));
    closed.next({ uid: 'bea', name: 'bea' });
    expect(snackBar.open).toHaveBeenCalledWith('Successfully added user bea', '', { duration: 2000 });
    expect(postsService.getUsers).toHaveBeenCalledTimes(2);

    component.openAddUserDialog();
    closed.next({ error: 'That name is taken' });
    expect(snackBar.open).toHaveBeenLastCalledWith('Failed to add user', '', { duration: 2000 });

    component.openAddUserDialog();
    closed.next(undefined);
    expect(snackBar.open).toHaveBeenCalledTimes(2);
    expect(postsService.getUsers).toHaveBeenCalledTimes(2);
  });

  it('leaves adding users to the sign-in provider when there is one', () => {
    postsService.isOIDCEnabled.mockReturnValue(true);
    component.openAddUserDialog();
    postsService.isOIDCEnabled.mockReturnValue(false);
    postsService.isHeaderAuthEnabled.mockReturnValue(true);
    component.openAddUserDialog();

    expect(dialog.open).not.toHaveBeenCalled();
  });

  it('renames a user and changes their role, and saves that', () => {
    component.enableEditMode('zed');
    expect(component.editObject.name).toBe('zed');

    component.constructedObject['name'] = 'zara';
    component.constructedObject['role'] = 'admin';
    component.finishEditing('zed');

    expect(postsService.changeUser).toHaveBeenCalledWith({ name: 'zara', uid: 'zed', role: 'admin' });
    expect(component.editObject).toBeNull();
    expect(component.constructedObject).toEqual({});
    expect(postsService.getUsers).toHaveBeenCalledTimes(2);
  });

  it('saves nothing when the new name is blank, and edits only users it has', () => {
    component.enableEditMode('zed');
    component.constructedObject['name'] = '   ';
    component.finishEditing('zed');
    expect(postsService.changeUser).not.toHaveBeenCalled();

    component.disableEditMode();
    expect(component.editObject).toBeNull();
    component.enableEditMode('nobody');
    expect(component.editObject).toBeNull();
  });

  it('opens a user\'s permissions, and a role\'s, reloading the roles after', () => {
    component.manageUser('zed');
    expect(dialog.open).toHaveBeenCalledWith(ManageUserComponent, expect.objectContaining({ data: { user: { uid: 'zed', name: 'zed', role: 'user' } } }));

    component.openModifyRole({ key: 'user' });
    expect(dialog.open).toHaveBeenLastCalledWith(ManageRoleComponent, expect.objectContaining({ data: { role: { key: 'user' } } }));
    closed.next(undefined);
    expect(postsService.getRoles).toHaveBeenCalledTimes(2);
  });

  it('removes a user, and reloads the list whether or not that worked', () => {
    component.removeUser('zed');
    postsService.deleteUser.mockReturnValueOnce(throwError(() => new Error('offline')));
    component.removeUser('amy');

    expect(postsService.deleteUser.mock.calls).toEqual([['zed'], ['amy']]);
    expect(postsService.getUsers).toHaveBeenCalledTimes(3);
  });

  it('closes', () => {
    component.closeDialog();

    expect(dialogRef.close).toHaveBeenCalled();
  });
});
