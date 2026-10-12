import { ComponentFixture, TestBed, waitForAsync } from '@angular/core/testing';
import { of, throwError } from 'rxjs';

import { AddUserDialogComponent } from './add-user-dialog.component';
import { configureTestBed } from '../../../testing/test-bed';

describe('AddUserDialogComponent', () => {
  let component: AddUserDialogComponent;
  let fixture: ComponentFixture<AddUserDialogComponent>;

  beforeEach(waitForAsync(() => {
    configureTestBed({
      imports: [ AddUserDialogComponent ]
    })
    .compileComponents();
  }));

  beforeEach(() => {
    fixture = TestBed.createComponent(AddUserDialogComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});

describe('AddUserDialogComponent creating a user', () => {
  let component: AddUserDialogComponent;
  let postsService: any;
  let dialogRef: any;

  beforeEach(() => {
    postsService = { register: vi.fn().mockReturnValue(of({ user: { uid: 'bea', name: 'bea' } })) };
    dialogRef = { close: vi.fn() };
    component = new AddUserDialogComponent(postsService, dialogRef);
    component.usernameInput = 'bea';
    component.passwordInput = 'bea-password';
  });

  it('registers the user and closes with them', () => {
    component.createUser();

    expect(postsService.register).toHaveBeenCalledWith('bea', 'bea-password');
    expect(dialogRef.close).toHaveBeenCalledWith({ uid: 'bea', name: 'bea' });
  });

  it('closes with an error when no user comes back or the request fails', () => {
    postsService.register.mockReturnValueOnce(of({}));
    component.createUser();
    postsService.register.mockReturnValueOnce(throwError(() => 'That name is taken'));
    component.createUser();

    expect(dialogRef.close.mock.calls).toEqual([[{ error: 'Unknown error' }], [{ error: 'That name is taken' }]]);
  });

  it('needs both a name and a password', () => {
    component.passwordInput = '';
    component.createUser();
    component.usernameInput = '';
    component.passwordInput = 'bea-password';
    component.createUser();

    expect(postsService.register).not.toHaveBeenCalled();
  });
});
