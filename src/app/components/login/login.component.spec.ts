import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { of, throwError } from 'rxjs';

import { LoginComponent } from './login.component';
import { PostsService } from 'app/posts.services';
import { configureTestBed } from '../../../testing/test-bed';

describe('LoginComponent', () => {
  let component: LoginComponent;
  let fixture: ComponentFixture<LoginComponent>;
  let postsServiceStub: any;
  let routerStub: any;

  async function create(allow_registration = true) {
    postsServiceStub.config.Users.allow_registration = allow_registration;
    configureTestBed({
      imports: [LoginComponent],
      providers: [
        { provide: PostsService, useValue: postsServiceStub },
        { provide: Router, useValue: routerStub }
      ]
    });
    await TestBed.compileComponents();
    fixture = TestBed.createComponent(LoginComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
    await fixture.whenStable();
  }

  const element = (): HTMLElement => fixture.nativeElement;
  const submitButton = () => element().querySelector<HTMLButtonElement>('.login-submit');

  function type(input: HTMLInputElement, value: string) {
    input.value = value;
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
  }

  beforeEach(() => {
    postsServiceStub = {
      isLoggedIn: false,
      service_initialized: of(true),
      config: { Advanced: { multi_user_mode: true }, Users: { allow_registration: true } },
      isOIDCEnabled: () => false,
      getBaseTitle: () => 'ytdl-material',
      login: vi.fn().mockName('login').mockReturnValue(of({ token: 'token', user: { uid: 'u' }, permissions: [], available_permissions: [] })),
      register: vi.fn().mockName('register').mockReturnValue(of({ user: { name: 'newcomer' } })),
      afterLogin: vi.fn().mockName('afterLogin')
    };
    routerStub = { navigate: vi.fn().mockName('navigate') };
  });

  it('asks for a user name and password, and cannot be submitted without both', async () => {
    await create();
    const inputs = element().querySelectorAll<HTMLInputElement>('.login-form input');
    expect(inputs.length).toBe(2);
    expect(submitButton().disabled).toBe(true);

    type(inputs[0], 'admin');
    expect(submitButton().disabled).toBe(true);
    type(inputs[1], 'secret');
    expect(submitButton().disabled).toBe(false);
  });

  it('logs in and hands the session to the service', async () => {
    await create();
    component.loginUsernameInput = 'admin';
    component.loginPasswordInput = 'secret';

    component.submit();

    expect(postsServiceStub.login).toHaveBeenCalledWith('admin', 'secret');
    expect(postsServiceStub.afterLogin).toHaveBeenCalledWith({ uid: 'u' }, 'token', [], [], '/home');
  });

  it('says on the card when the password is wrong', async () => {
    await create();
    postsServiceStub.login.mockReturnValue(throwError(() => ({ status: 401 })));
    component.loginUsernameInput = 'admin';
    component.loginPasswordInput = 'wrong';

    component.submit();
    fixture.detectChanges();

    const alert = element().querySelector('[role="alert"]');
    expect(alert.textContent).toContain('User name or password is incorrect!');
    expect(component.loggingIn).toBe(false);
  });

  it('only offers registering when the server allows it', async () => {
    await create(false);
    expect(element().querySelector('.login-modes')).toBeNull();
  });

  // It used to, on a click into either password field. Empty fields only failed validation, so
  // they are filled in first.
  it('does not register just because a password field was clicked', async () => {
    await create();
    component.setMode('register');
    fixture.detectChanges();
    // A form registers the fields it has just grown a tick later; typing before then goes nowhere.
    await fixture.whenStable();

    const inputs = element().querySelectorAll<HTMLInputElement>('.login-form input');
    expect(inputs.length).toBe(3);
    type(inputs[0], 'newcomer');
    type(inputs[1], 'secret');
    type(inputs[2], 'secret');
    expect(component.canRegister).toBe(true);
    inputs[1].click();
    inputs[2].click();

    expect(postsServiceStub.register).not.toHaveBeenCalled();
  });

  it('will not register passwords that differ', async () => {
    await create();
    component.setMode('register');
    component.registrationUsernameInput = 'newcomer';
    component.registrationPasswordInput = 'one';
    component.registrationPasswordConfirmationInput = 'two';

    component.submit();
    fixture.detectChanges();

    expect(postsServiceStub.register).not.toHaveBeenCalled();
    expect(element().querySelector('[role="alert"]').textContent).toContain('The passwords do not match.');
  });

  it('goes back to logging in with the new name filled in once registered', async () => {
    await create();
    component.setMode('register');
    component.registrationUsernameInput = 'newcomer';
    component.registrationPasswordInput = 'secret';
    component.registrationPasswordConfirmationInput = 'secret';

    component.submit();
    fixture.detectChanges();

    expect(postsServiceStub.register).toHaveBeenCalledWith('newcomer', 'secret');
    expect(component.mode).toBe('login');
    expect(component.loginUsernameInput).toBe('newcomer');
    expect(element().querySelector('[role="status"]').textContent).toContain('Registered newcomer');
  });

  it('shows the password on request', async () => {
    await create();
    const reveal = element().querySelector<HTMLButtonElement>('.login-field .kit-icon-button');
    const password = element().querySelectorAll<HTMLInputElement>('.login-form input')[1];
    expect(password.type).toBe('password');

    reveal.click();
    fixture.detectChanges();

    expect(password.type).toBe('text');
    expect(reveal.getAttribute('aria-pressed')).toBe('true');
  });

  it('sends anyone who does not need to log in back home', async () => {
    postsServiceStub.config.Advanced.multi_user_mode = false;
    await create();
    expect(routerStub.navigate).toHaveBeenCalledWith(['/home']);
  });
});
