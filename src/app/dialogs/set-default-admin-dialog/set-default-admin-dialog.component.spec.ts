import { ComponentFixture, TestBed, waitForAsync } from '@angular/core/testing';
import { HttpErrorResponse } from '@angular/common/http';
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

  it('says why beside the password when the account could not be made', () => {
    expect(fixture.nativeElement.querySelector('[role="alert"]')).toBeNull();

    component.failed = true;
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[role="alert"]').textContent.trim())
      .toBe('error_outlineCould not create the admin account. Check the server logs and try again.');
  });
});

describe('SetDefaultAdminDialogComponent creating the account', () => {
  let component: SetDefaultAdminDialogComponent;
  let postsService: any;
  let dialogRef: any;

  // What the server sends back: the account it made. A refusal is an error status.
  beforeEach(() => {
    postsService = { createAdminAccount: vi.fn().mockReturnValue(of({ user: { uid: 'admin', name: 'admin' } })) };
    dialogRef = { close: vi.fn() };
    component = new SetDefaultAdminDialogComponent(postsService, dialogRef);
  });

  // It looked for a success flag the server never sends, so it closed saying it failed.
  it('creates it with the password given, and closes saying it worked', () => {
    component.input = 'admin-password';

    component.create();

    expect(postsService.createAdminAccount).toHaveBeenCalledWith('admin-password');
    expect(component.creating).toBe(false);
    expect(component.failed).toBe(false);
    expect(dialogRef.close).toHaveBeenCalledWith(true);
  });

  // It used to close, which took the app to the login page with no account to sign in to.
  it('stays open and says so when the server refuses, cannot be reached, or makes no account', () => {
    component.input = 'admin-password';
    for (const answer of [
      throwError(() => new HttpErrorResponse({ status: 409 })),
      throwError(() => new HttpErrorResponse({ status: 0 })),
      of({})
    ]) {
      postsService.createAdminAccount.mockReturnValueOnce(answer);
      component.create();

      expect(component.failed).toBe(true);
      expect(component.creating).toBe(false);
    }

    expect(dialogRef.close).not.toHaveBeenCalled();
    expect(component.input).toBe('admin-password');
  });

  it('clears what went wrong when it tries again', () => {
    component.input = 'admin-password';
    postsService.createAdminAccount.mockReturnValueOnce(throwError(() => new HttpErrorResponse({ status: 500 })));
    component.create();
    expect(component.failed).toBe(true);

    component.create();

    expect(component.failed).toBe(false);
    expect(dialogRef.close).toHaveBeenCalledWith(true);
  });

  it('does nothing without a password, or while it is already creating one', () => {
    component.create();
    component.input = 'admin-password';
    component.creating = true;
    component.create();

    expect(postsService.createAdminAccount).not.toHaveBeenCalled();
  });
});
