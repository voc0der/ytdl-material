import { ComponentFixture, TestBed, waitForAsync } from '@angular/core/testing';
import { of, throwError } from 'rxjs';

import { UserPermission, YesNo } from 'api-types';
import { ManageUserComponent } from './manage-user.component';
import { configureTestBed } from '../../../testing/test-bed';

describe('ManageUserComponent', () => {
  let component: ManageUserComponent;
  let fixture: ComponentFixture<ManageUserComponent>;

  beforeEach(waitForAsync(() => {
    configureTestBed({
      imports: [ ManageUserComponent ]
    })
    .compileComponents();
  }));

  beforeEach(() => {
    fixture = TestBed.createComponent(ManageUserComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});

describe('ManageUserComponent permissions', () => {
  let component: ManageUserComponent;
  let postsService: any;

  beforeEach(() => {
    postsService = {
      user: { uid: 'admin' },
      available_permissions: ['filemanager', 'subscriptions', 'sharing', 'settings'],
      setUserPermission: vi.fn().mockReturnValue(of({ success: true })),
      changeUserPassword: vi.fn().mockReturnValue(of({ success: true }))
    };
    const user = { uid: 'alice', name: 'Alice', permissions: ['filemanager', 'sharing'], permission_overrides: ['filemanager', 'subscriptions'] };
    component = new ManageUserComponent(postsService, { user } as any);
  });

  it('shows each permission as granted, refused, or left to the role', () => {
    expect(component.permissions).toEqual({ filemanager: 'yes', subscriptions: 'no', sharing: 'default', settings: 'default' });
  });

  it('saves a change, and only a change', () => {
    component.setPermission('subscriptions' as UserPermission, YesNo.YES);
    component.setPermission('subscriptions' as UserPermission, YesNo.YES);

    expect(postsService.setUserPermission).toHaveBeenCalledTimes(1);
    expect(postsService.setUserPermission).toHaveBeenCalledWith('alice', 'subscriptions', 'yes');
    expect(component.permissions.subscriptions).toBe('yes');
  });

  it('will not take settings access from the administrator using the dialog', () => {
    postsService.user = { uid: 'alice' };

    component.setPermission('settings' as UserPermission, YesNo.NO);

    expect(component.permissionLocked('settings')).toBe(true);
    expect(component.permissionLocked('sharing')).toBe(false);
    expect(postsService.setUserPermission).not.toHaveBeenCalled();
    expect(component.permissions.settings).toBe('default');
  });

  it('sets a new password, then clears the field', () => {
    component.newPasswordInput = 'new-password';

    component.setNewPassword();

    expect(postsService.changeUserPassword).toHaveBeenCalledWith('alice', 'new-password', null);
    expect(component.newPasswordInput).toBe('');
    expect(component.settingNewPassword).toBe(false);
  });
});

describe('ManageUserComponent, your own password', () => {
  let component: ManageUserComponent;
  let postsService: any;

  beforeEach(() => {
    postsService = {
      user: { uid: 'admin' },
      available_permissions: [],
      changeUserPassword: vi.fn().mockReturnValue(of({ success: true, token: 'reissued' })),
      replaceSessionToken: vi.fn()
    };
    const user = { uid: 'admin', name: 'admin', permissions: [], permission_overrides: [] };
    component = new ManageUserComponent(postsService, { user } as any);
  });

  it('asks for the current password, administrators included', () => {
    expect(component.editingSelf).toBe(true);
    component.newPasswordInput = 'new-password';
    expect(component.canSetNewPassword).toBe(false);
    component.setNewPassword();
    expect(postsService.changeUserPassword).not.toHaveBeenCalled();

    component.currentPasswordInput = 'old-password';
    expect(component.canSetNewPassword).toBe(true);
    component.setNewPassword();
    expect(postsService.changeUserPassword).toHaveBeenCalledWith('admin', 'new-password', 'old-password');
  });

  it('carries on with the token the server reissued, since the new password ended the old one', () => {
    component.currentPasswordInput = 'old-password';
    component.newPasswordInput = 'new-password';

    component.setNewPassword();

    expect(postsService.replaceSessionToken).toHaveBeenCalledWith('reissued');
    expect(component.currentPasswordInput).toBe('');
    expect(component.newPasswordInput).toBe('');
    expect(component.passwordError).toBeNull();
  });

  it('says a wrong current password was wrong, and clears it to be typed again', () => {
    postsService.changeUserPassword.mockReturnValue(throwError(() => 'The current password is incorrect'));
    component.currentPasswordInput = 'wrong';
    component.newPasswordInput = 'new-password';

    component.setNewPassword();

    expect(component.passwordError).toBe('The current password is incorrect.');
    expect(component.currentPasswordInput).toBe('');
    expect(component.newPasswordInput).toBe('new-password');
    expect(component.settingNewPassword).toBe(false);
    expect(postsService.replaceSessionToken).not.toHaveBeenCalled();
  });

  it('says to wait once too many were wrong, and that anything else could not be saved', () => {
    component.currentPasswordInput = 'old-password';
    component.newPasswordInput = 'new-password';
    postsService.changeUserPassword.mockReturnValue(throwError(() => 'Too many wrong current passwords. Please wait and try again.'));
    component.setNewPassword();
    expect(component.passwordError).toBe('Too many authentication requests. Please wait and try again.');

    postsService.changeUserPassword.mockReturnValue(of({ success: false }));
    component.setNewPassword();
    expect(component.passwordError).toBe('Could not save changes. Please try again.');
    expect(component.currentPasswordInput).toBe('old-password');
  });
});
