import { ComponentFixture, TestBed, waitForAsync } from '@angular/core/testing';
import { of } from 'rxjs';

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

    expect(postsService.changeUserPassword).toHaveBeenCalledWith('alice', 'new-password');
    expect(component.newPasswordInput).toBe('');
    expect(component.settingNewPassword).toBe(false);
  });
});
