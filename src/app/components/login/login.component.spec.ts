import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Location } from '@angular/common';
import { ActivatedRoute, Router, convertToParamMap } from '@angular/router';
import { of, throwError } from 'rxjs';

import { LoginComponent } from './login.component';
import { PostsService } from 'app/posts.services';
import { configureTestBed } from '../../../testing/test-bed';

describe('LoginComponent', () => {
  let component: LoginComponent;
  let fixture: ComponentFixture<LoginComponent>;
  let postsServiceStub: any;
  let routerStub: any;

  // fragment: the address's #fragment as the page first sees it, as after an OIDC callback.
  async function create(allow_registration = true, fragment: string | null = null) {
    postsServiceStub.config.Users.allow_registration = allow_registration;
    const route = fragment === null ? [] : [{ provide: ActivatedRoute, useValue: { snapshot: {
      fragment, params: {}, queryParams: {}, paramMap: convertToParamMap({}), queryParamMap: convertToParamMap({})
    } } }];
    configureTestBed({
      imports: [LoginComponent],
      providers: [
        { provide: PostsService, useValue: postsServiceStub },
        { provide: Router, useValue: routerStub },
        ...route
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
      isHeaderAuthEnabled: () => false,
      headerLogin: vi.fn().mockName('headerLogin'),
      getBaseTitle: () => 'ytdl-material',
      login: vi.fn().mockName('login').mockReturnValue(of({ token: 'token', user: { uid: 'u' }, permissions: [], available_permissions: [] })),
      register: vi.fn().mockName('register').mockReturnValue(of({ user: { name: 'newcomer' } })),
      afterLogin: vi.fn().mockName('afterLogin'),
      completeOIDCLogin: vi.fn().mockName('completeOIDCLogin'),
      beginOIDCHandoff: vi.fn().mockName('beginOIDCHandoff').mockReturnValue('tab-kept-value'),
      takeOIDCHandoff: vi.fn().mockName('takeOIDCHandoff').mockImplementation(handoff => handoff === 'tab-kept-value')
    };
    routerStub = { navigate: vi.fn().mockName('navigate') };
  });

  it('signs in through the reverse proxy without asking for a password', async () => {
    postsServiceStub.isHeaderAuthEnabled = () => true;
    await create();

    expect(postsServiceStub.headerLogin).toHaveBeenCalledExactlyOnceWith('/', expect.any(Function));
    expect(element().querySelector('.login-form')).toBeNull();
    expect(element().querySelector('.login-title').textContent).toContain('Signing you in');
    expect(element().textContent).toContain('Signing in through your reverse proxy');
  });

  it('accepts the OIDC token from a fragment and preserves the video return query', async () => {
    await create();
    const replaceState = vi.spyOn(TestBed.inject(Location), 'replaceState');
    Object.assign(TestBed.inject(ActivatedRoute).snapshot, {
      fragment: 'oidc_token=test-token&redirect=%2F%3Fv%3DFileLink123&handoff=tab-kept-value'
    });
    component.ngOnInit();
    expect(postsServiceStub.takeOIDCHandoff).toHaveBeenCalledWith('tab-kept-value');
    expect(postsServiceStub.completeOIDCLogin).toHaveBeenCalledWith('test-token', '/?v=FileLink123');
    // The token does not stay in the address, or in history.
    expect(replaceState).toHaveBeenCalledOnce();
    expect(replaceState.mock.calls[0][0]).not.toContain('test-token');
  });

  it.each([
    ['without a handoff value', 'oidc_token=planted-token&redirect=%2F'],
    ['with another tab\'s or browser\'s value', 'oidc_token=planted-token&redirect=%2F&handoff=someone-elses-value']
  ])('refuses an OIDC token %s, and does not go straight back to the provider', async (_case, fragment) => {
    postsServiceStub.isOIDCEnabled = () => true;
    postsServiceStub.getOIDCLoginURL = vi.fn(() => '#provider');
    const original = window.location.href;
    try {
      await create(true, fragment);
      fixture.detectChanges();

      expect(postsServiceStub.completeOIDCLogin).not.toHaveBeenCalled();
      expect(postsServiceStub.getOIDCLoginURL).not.toHaveBeenCalled();
      expect(component.oidcRedirecting).toBe(false);
      expect(element().textContent).toContain('That sign-in did not start in this tab, so it was not used.');
      expect(element().textContent).not.toContain('Redirecting to your identity provider');

      // Continue starts a sign-in of this tab's own.
      submitButton().click();
      expect(postsServiceStub.beginOIDCHandoff).toHaveBeenCalledOnce();
      expect(postsServiceStub.getOIDCLoginURL).toHaveBeenCalledWith('/', 'tab-kept-value');
    } finally {
      window.history.replaceState(null, '', original);
    }
  });

  it('ignores a planted OIDC token quietly when OIDC is off', async () => {
    await create(true, 'oidc_token=planted-token');
    fixture.detectChanges();

    expect(postsServiceStub.completeOIDCLogin).not.toHaveBeenCalled();
    expect(component.error).toBeNull();
    expect(element().querySelector('.login-form')).not.toBeNull();
  });

  it('says why signing in through the proxy failed, and tries again when asked', async () => {
    postsServiceStub.isHeaderAuthEnabled = () => true;
    postsServiceStub.headerLogin.mockImplementation((_path, onFailure) => onFailure('Your reverse proxy did not sign you in. The server log says why.'));
    await create();
    fixture.detectChanges();

    expect(element().querySelector('.login-message.is-error').textContent).toContain('Your reverse proxy did not sign you in');
    submitButton().click();
    expect(postsServiceStub.headerLogin).toHaveBeenCalledTimes(2);
    expect(element().querySelector('.login-form')).toBeNull();
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
    expect(postsServiceStub.afterLogin).toHaveBeenCalledWith({ uid: 'u' }, 'token', [], [], '/');
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
    expect(routerStub.navigate).toHaveBeenCalledWith(['/']);
  });

  it('sends someone who is already logged in back home', async () => {
    postsServiceStub.isLoggedIn = true;
    localStorage.setItem('jwt_token', 'token');
    try {
      await create();
      expect(routerStub.navigate).toHaveBeenCalledWith(['/']);
    } finally {
      localStorage.removeItem('jwt_token');
    }
  });

  it.each([
    ['the server cannot be reached', { status: 404 }, 'Login failed, cannot connect to the server.'],
    ['too many attempts were made', { status: 429 }, 'Too many authentication requests. Please wait and try again.'],
    ['a proxy says there were too many attempts', { status: 0, statusText: 'Too Many Requests' }, 'Too many authentication requests. Please wait and try again.'],
    ['the server gives a reason', { status: 500, error: { message: 'The user database is unavailable.' } }, 'The user database is unavailable.'],
    ['the failure says nothing', {}, 'Login failed, unknown error.'],
    ['the failure is only text', 'Account locked', 'Account locked']
  ])('says so on the card when %s', async (_case, failure, message) => {
    await create();
    postsServiceStub.login.mockReturnValue(throwError(() => failure));
    component.loginUsernameInput = 'admin';
    component.loginPasswordInput = 'secret';

    component.submit();
    fixture.detectChanges();

    expect(element().querySelector('[role="alert"]').textContent).toContain(message);
    expect(component.loggingIn).toBe(false);
  });

  it('does not hand over a session the server did not issue', async () => {
    await create();
    postsServiceStub.login.mockReturnValue(of({ user: { uid: 'u' } }));
    component.loginUsernameInput = 'admin';
    component.loginPasswordInput = 'secret';

    component.login();
    component.loginPasswordInput = '';
    component.login();

    expect(postsServiceStub.login).toHaveBeenCalledOnce();
    expect(postsServiceStub.afterLogin).not.toHaveBeenCalled();
    expect(component.error).toBe('Login failed, unknown error.');
  });

  it('asks for each registration field in turn before sending anything', async () => {
    await create();
    component.setMode('register');

    component.submit();
    expect(component.error).toBe('User name is required!');
    component.registrationUsernameInput = 'newcomer';
    component.submit();
    expect(component.error).toBe('Password is required!');
    component.registrationPasswordInput = 'secret';
    component.submit();
    expect(component.error).toBe('Password confirmation is required!');

    expect(postsServiceStub.register).not.toHaveBeenCalled();
  });

  it.each([
    ['the server refuses with a reason', throwError(() => ({ error: 'User name is already taken!' })), 'User name is already taken!'],
    ['the server fails with a message', throwError(() => ({ error: { message: 'Registration is closed.' } })), 'Registration is closed.'],
    ['the failure says nothing', throwError(() => ({})), 'Failed to register user, unknown error.'],
    ['the server answers without a user', of({ success: false }), 'Failed to register user, unknown error.']
  ])('says why registering failed when %s', async (_case, response, message) => {
    await create();
    postsServiceStub.register.mockReturnValue(response);
    component.setMode('register');
    component.registrationUsernameInput = 'newcomer';
    component.registrationPasswordInput = 'secret';
    component.registrationPasswordConfirmationInput = 'secret';

    component.submit();

    expect(component.error).toBe(message);
    expect(component.registering).toBe(false);
    expect(component.mode).toBe('register');
  });

  it('sends the browser to the identity provider once when OIDC is on', async () => {
    const original = window.location.href;
    postsServiceStub.isOIDCEnabled = () => true;
    postsServiceStub.getOIDCLoginURL = vi.fn((returnTo: string) => `#provider?returnTo=${encodeURIComponent(returnTo)}`);
    try {
      await create();

      expect(window.location.hash).toBe('#provider?returnTo=%2F');
      expect(component.oidcRedirecting).toBe(true);
      component.redirectToOIDC();
      expect(postsServiceStub.getOIDCLoginURL).toHaveBeenCalledOnce();
      // With the value this tab keeps, for the login page to know the answer is its own.
      expect(postsServiceStub.getOIDCLoginURL).toHaveBeenCalledWith('/', 'tab-kept-value');
      expect(element().querySelector('.login-form')).toBeNull();
    } finally {
      window.history.replaceState(null, '', original);
    }
  });
});
