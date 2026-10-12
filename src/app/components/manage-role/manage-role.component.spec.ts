import { ComponentFixture, TestBed, waitForAsync } from '@angular/core/testing';
import { of, throwError } from 'rxjs';

import { UserPermission, YesNo } from 'api-types';
import { ManageRoleComponent } from './manage-role.component';
import { configureTestBed } from '../../../testing/test-bed';

describe('ManageRoleComponent', () => {
  let component: ManageRoleComponent;
  let fixture: ComponentFixture<ManageRoleComponent>;

  beforeEach(waitForAsync(() => {
    configureTestBed({
      imports: [ ManageRoleComponent ]
    })
    .compileComponents();
  }));

  beforeEach(() => {
    fixture = TestBed.createComponent(ManageRoleComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});

describe('ManageRoleComponent permissions', () => {
  let component: ManageRoleComponent;
  let postsService: any;

  const create = (role: object) => new ManageRoleComponent(postsService, {} as any, { role } as any);

  beforeEach(() => {
    postsService = {
      available_permissions: ['filemanager', 'settings', 'sharing'],
      setRolePermission: vi.fn().mockReturnValue(of({ success: true }))
    };
    component = create({ key: 'user', permissions: ['filemanager'] });
  });

  it('shows what the role grants', () => {
    expect(component.permissions).toEqual({ filemanager: 'yes', settings: 'no', sharing: 'no' });
  });

  it('saves a change, and only a change', () => {
    component.setPermission('sharing' as UserPermission, YesNo.YES);
    component.setPermission('sharing' as UserPermission, YesNo.YES);

    expect(postsService.setRolePermission).toHaveBeenCalledTimes(1);
    expect(postsService.setRolePermission).toHaveBeenCalledWith('user', 'sharing', 'yes');
    expect(component.permissions.sharing).toBe('yes');
  });

  it('puts a permission back when the server refuses it or cannot be reached', () => {
    postsService.setRolePermission.mockReturnValueOnce(of({ success: false }));
    component.setPermission('sharing' as UserPermission, YesNo.YES);
    expect(component.permissions.sharing).toBe('no');

    postsService.setRolePermission.mockReturnValueOnce(throwError(() => new Error('offline')));
    component.setPermission('filemanager' as UserPermission, YesNo.NO);
    expect(component.permissions.filemanager).toBe('yes');
  });

  it('will not take settings access from the admin role', () => {
    component = create({ key: 'admin', permissions: ['settings'] });

    component.setPermission('settings' as UserPermission, YesNo.NO);

    expect(component.permissionLocked('settings')).toBe(true);
    expect(postsService.setRolePermission).not.toHaveBeenCalled();
    expect(component.permissions.settings).toBe('yes');
  });
});
