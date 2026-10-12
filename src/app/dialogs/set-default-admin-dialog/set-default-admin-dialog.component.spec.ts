import { ComponentFixture, TestBed, waitForAsync } from '@angular/core/testing';
import { of, throwError } from 'rxjs';

import { SetDefaultAdminDialogComponent } from './set-default-admin-dialog.component';
import { configureTestBed } from '../../../testing/test-bed';

describe('SetDefaultAdminDialogComponent', () => {
  let component: SetDefaultAdminDialogComponent;
  let fixture: ComponentFixture<SetDefaultAdminDialogComponent>;

  beforeEach(waitForAsync(() => {
    configureTestBed({
      imports: [ SetDefaultAdminDialogComponent ]
    })
    .compileComponents();
  }));

  beforeEach(() => {
    fixture = TestBed.createComponent(SetDefaultAdminDialogComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});

describe('SetDefaultAdminDialogComponent creating the account', () => {
  let component: SetDefaultAdminDialogComponent;
  let postsService: any;
  let dialogRef: any;

  beforeEach(() => {
    postsService = { createAdminAccount: vi.fn().mockReturnValue(of({ success: true })) };
    dialogRef = { close: vi.fn() };
    component = new SetDefaultAdminDialogComponent(postsService, dialogRef);
  });

  it('creates it with the password given, and closes saying it worked', () => {
    component.input = 'admin-password';

    component.create();

    expect(postsService.createAdminAccount).toHaveBeenCalledWith('admin-password');
    expect(component.creating).toBe(false);
    expect(dialogRef.close).toHaveBeenCalledWith(true);
  });

  it('closes saying it failed when the server refuses or cannot be reached', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    component.input = 'admin-password';

    postsService.createAdminAccount.mockReturnValueOnce(of({ success: false }));
    component.create();
    postsService.createAdminAccount.mockReturnValueOnce(throwError(() => new Error('offline')));
    component.create();

    expect(dialogRef.close.mock.calls).toEqual([[false], [false]]);
  });

  it('does nothing without a password, or while it is already creating one', () => {
    component.create();
    component.input = 'admin-password';
    component.creating = true;
    component.create();

    expect(postsService.createAdminAccount).not.toHaveBeenCalled();
  });
});
