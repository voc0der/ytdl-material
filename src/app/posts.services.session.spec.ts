import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { MatSnackBar } from '@angular/material/snack-bar';
import { Title } from '@angular/platform-browser';
import { ActivatedRouteSnapshot, Router } from '@angular/router';
import { filter } from 'rxjs';

import { PostsService } from './posts.services';
import { h401InterceptorFn } from './http.interceptor';

describe('PostsService session lifecycle', () => {
  const API = 'http://localhost/api/';
  const SESSION = {
    user: { uid: 'alice', name: 'Alice' }, token: 'renewed-token',
    permissions: ['settings'], available_permissions: ['settings', 'subscriptions']
  };
  const originalURL = window.location.href;
  let service: PostsService;
  let http: HttpTestingController;
  let router: { url: string; navigate: ReturnType<typeof vi.fn>; navigateByUrl: ReturnType<typeof vi.fn> };
  let snackBar: { open: ReturnType<typeof vi.fn> };

  function configuration(multiUser = true, oidc = false) {
    return {
      Advanced: { multi_user_mode: multiUser }, Users: { oidc: { enabled: oidc } },
      Extra: { title_top: 'Media library' }
    };
  }

  beforeEach(() => {
    // Exercise deployed /api/config requests instead of the development-only asset.
    // Restore Angular's mode after each test, along with the other global state.
    vi.stubGlobal('ngDevMode', false);
    http = null;
    localStorage.clear();
    router = { url: '/home', navigate: vi.fn().mockResolvedValue(true), navigateByUrl: vi.fn().mockResolvedValue(true) };
    snackBar = { open: vi.fn() };
    TestBed.configureTestingModule({
      providers: [
        PostsService, provideHttpClient(), provideHttpClientTesting(),
        { provide: Router, useValue: router },
        { provide: MatSnackBar, useValue: snackBar },
        { provide: Title, useValue: { setTitle: vi.fn() } }
      ]
    });
  });

  afterEach(() => {
    try {
      http?.verify();
    } finally {
      localStorage.clear();
      window.history.replaceState(null, '', originalURL);
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
  });

  function start({ token = null, route = '/home' }: { token?: string; route?: string } = {}) {
    if (token !== null) localStorage.setItem('jwt_token', token);
    router.url = route;
    window.history.replaceState(null, '', '/#' + route);
    http = TestBed.inject(HttpTestingController);
    service = TestBed.inject(PostsService);
    const request = http.expectOne(API + 'config');
    expect(request.request.method).toBe('GET');
    expect(request.request.params.has('jwt')).toBe(false);
    return request;
  }

  function expectAuthRequest(token: string) {
    const request = http.expectOne(req => req.url === API + 'auth/jwtAuth');
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual({});
    expect(request.request.params.get('jwt')).toBe(token);
    return request;
  }

  function expectConfigRequest(token: string) {
    const request = http.expectOne(req => req.url === API + 'config');
    expect(request.request.method).toBe('GET');
    expect(request.request.params.get('jwt')).toBe(token);
    return request;
  }

  function expectAdminCheck(exists = true) {
    const request = http.expectOne(req => req.url === API + 'auth/adminExists');
    expect(request.request.method).toBe('POST');
    expect(request.request.params.has('jwt')).toBe(false);
    request.flush({ exists });
  }

  it('initializes single-user mode without authenticating a leftover token', () => {
    start({ token: 'old-token' }).flush({ config_file: { YtdlMaterial: configuration(false) } });

    expect(service.initialized).toBe(true);
    expect(service.hasSession()).toBe(true);
    expect(service.isLoggedIn).toBe(false);
    expect(service.hasPermission('settings')).toBe(true);
    expect(router.navigate).not.toHaveBeenCalled();
    http.expectNone(req => req.url.includes('/auth/'));
  });

  it('restores a saved session and waits for authenticated config before releasing a route guard', async () => {
    const bootstrap = start({ token: 'saved-token' });
    const readyConfigs: unknown[] = [];
    service.service_initialized.pipe(filter(Boolean)).subscribe(() => readyConfigs.push(service.config));
    let routeSettled = false;
    const route = service.canActivate({ routeConfig: { path: 'settings' } } as ActivatedRouteSnapshot, null);
    void route.then(() => { routeSettled = true; });
    bootstrap.flush({ config_file: { YtdlMaterial: configuration() } });

    expect(service.hasSession()).toBe(false);
    expect(service.hasPermission('settings')).toBe(false);
    expectAuthRequest('saved-token').flush(SESSION);
    const refresh = expectConfigRequest(SESSION.token);
    await Promise.resolve();
    expect(service.initialized).toBe(false);
    expect(routeSettled).toBe(false);
    expect(readyConfigs).toEqual([]);
    expect(localStorage.getItem('jwt_token')).toBe(SESSION.token);

    const authenticatedConfig = { ...configuration(), Downloader: { custom_args: '--verbose' } };
    refresh.flush({ config_file: { YtdlMaterial: authenticatedConfig } });

    expect(await route).toBe(true);
    expect(readyConfigs).toEqual([authenticatedConfig]);
    expect(service.user).toEqual(SESSION.user);
    expect(service.permissions).toEqual(SESSION.permissions);
    expect(service.available_permissions).toEqual(SESSION.available_permissions);
    expect(service.hasSession()).toBe(true);
    expect(service.hasPermission('subscriptions')).toBe(false);
    expect(router.navigate).not.toHaveBeenCalled();
    expect(router.navigateByUrl).not.toHaveBeenCalled();
  });

  it.each([null, '', 'null'])('treats a stored token of %j as an anonymous session', token => {
    start({ token, route: '/settings?tab=users' }).flush({ config_file: { YtdlMaterial: configuration() } });
    expectAdminCheck();

    http.expectNone(API + 'auth/jwtAuth');
    expect(service.initialized).toBe(true);
    expect(service.hasSession()).toBe(false);
    expect(service.token).toBeNull();
    expect(service.httpOptions.params.has('jwt')).toBe(false);
    expect(service.hasPermission('settings')).toBe(false);
    expect(router.navigate).toHaveBeenCalledExactlyOnceWith(['/login'], { queryParams: { returnTo: '/settings?tab=users' } });
    expect(snackBar.open).toHaveBeenCalledExactlyOnceWith('You must log in to access this page!', '', { duration: 2000 });
  });

  it.each(['/login?returnTo=%2Fsettings', '/player;uid=file-1'])('allows anonymous bootstrap on %s without redirecting', route => {
    start({ route }).flush({ config_file: { YtdlMaterial: configuration(true, true) } });

    expect(service.initialized).toBe(true);
    expect(service.hasSession()).toBe(false);
    expect(router.navigate).not.toHaveBeenCalled();
    expect(snackBar.open).not.toHaveBeenCalled();
    http.expectNone(req => req.url.includes('/auth/'));
  });

  it('redirects an anonymous OIDC session without offering local administrator setup or a password-login warning', () => {
    start({ route: '/tasks' }).flush({ config_file: { YtdlMaterial: configuration(true, true) } });

    expect(service.initialized).toBe(true);
    expect(service.open_create_default_admin_dialog.value).toBe(false);
    expect(router.navigate).toHaveBeenCalledExactlyOnceWith(['/login'], { queryParams: { returnTo: '/tasks' } });
    expect(snackBar.open).not.toHaveBeenCalled();
    http.expectNone(req => req.url.includes('/auth/'));
  });

  it.each([true, false])('offers local administrator setup only when the account is missing (exists=%s)', exists => {
    start({ route: '/login' }).flush({ config_file: { YtdlMaterial: configuration() } });
    expectAdminCheck(exists);

    expect(service.open_create_default_admin_dialog.value).toBe(!exists);
    expect(service.initialized).toBe(true);
    expect(service.isLoggedIn).toBe(false);
  });

  it('logs in with a password, resets the selected library, and redirects only after loading authenticated config', () => {
    start({ route: '/login?returnTo=%2Fsettings' }).flush({ config_file: { YtdlMaterial: configuration() } });
    expectAdminCheck();
    service.viewLibrary({ uid: 'bob', name: 'Bob' });
    const libraryChanged = vi.fn();
    service.library_changed.subscribe(libraryChanged);
    const ready = vi.fn();
    service.service_initialized.pipe(filter(Boolean)).subscribe(ready);
    const reloadedConfigs: unknown[] = [];
    service.config_reloaded.pipe(filter(Boolean)).subscribe(() => reloadedConfigs.push(service.config));
    reloadedConfigs.length = 0;

    service.login('alice', 'test-password').subscribe(session => {
      service.afterLogin(session.user, session.token, session.permissions, session.available_permissions, '/settings?tab=users');
    });
    const login = http.expectOne(API + 'auth/login');
    expect(login.request.method).toBe('POST');
    expect(login.request.body).toEqual({ username: 'alice', password: 'test-password' });
    expect(service.isLoggedIn).toBe(false);
    login.flush(SESSION);

    expect(service.isLoggedIn).toBe(true);
    expect(service.user).toEqual(SESSION.user);
    expect(service.token).toBe(SESSION.token);
    expect(localStorage.getItem('jwt_token')).toBe(SESSION.token);
    expect(service.viewedLibraryUid).toBeNull();
    expect(libraryChanged).toHaveBeenCalledExactlyOnceWith(null);
    expect(router.navigateByUrl).not.toHaveBeenCalled();
    expect(reloadedConfigs).toEqual([]);

    const authenticatedConfig = { ...configuration(), Downloader: { custom_args: '--verbose' } };
    expectConfigRequest(SESSION.token).flush({ config_file: { YtdlMaterial: authenticatedConfig } });
    expect(reloadedConfigs).toEqual([authenticatedConfig]);
    expect(ready).toHaveBeenCalledTimes(1); // The login page already initialized the service.
    expect(router.navigateByUrl).toHaveBeenCalledExactlyOnceWith('/settings?tab=users');
  });

  it('falls back to home when login supplies an empty return path', () => {
    start({ route: '/login' }).flush({ config_file: { YtdlMaterial: configuration(true, true) } });
    service.afterLogin(SESSION.user, SESSION.token, SESSION.permissions, SESSION.available_permissions, '');
    expectConfigRequest(SESSION.token).flush({ config_file: { YtdlMaterial: configuration(true, true) } });

    expect(router.navigateByUrl).toHaveBeenCalledExactlyOnceWith('/home');
  });

  it('releases waiting routes when the authenticated config refresh fails', async () => {
    start({ token: 'saved-token', route: '/login' }).flush({ config_file: { YtdlMaterial: configuration() } });
    const route = service.canActivate({ routeConfig: { path: 'settings' } } as ActivatedRouteSnapshot, null);
    expectAuthRequest('saved-token').flush(SESSION);
    expectConfigRequest(SESSION.token).flush({}, { status: 503, statusText: 'Service Unavailable' });

    expect(await route).toBe(true);
    expect(service.initialized).toBe(true);
    expect(service.hasSession()).toBe(true);
    expect(router.navigateByUrl).toHaveBeenCalledExactlyOnceWith('/home');
  });

  it('exchanges the OIDC callback token and waits for authenticated config before returning to the requested page', () => {
    start({ route: '/login' }).flush({ config_file: { YtdlMaterial: configuration(true, true) } });
    service.completeOIDCLogin('callback-token', '/tasks');
    expectAuthRequest('callback-token').flush(SESSION);

    expect(service.token).toBe(SESSION.token);
    expect(localStorage.getItem('jwt_token')).toBe(SESSION.token);
    expect(service.user).toEqual(SESSION.user);
    expect(router.navigateByUrl).not.toHaveBeenCalled();
    expectConfigRequest(SESSION.token).flush({ config_file: { YtdlMaterial: configuration(true, true) } });

    expect(service.hasSession()).toBe(true);
    expect(router.navigateByUrl).toHaveBeenCalledExactlyOnceWith('/tasks');
    http.expectNone(API + 'auth/adminExists');
  });

  it.each([401, 503])('discards a failed OIDC callback credential after HTTP %s', status => {
    start({ route: '/player;uid=file-1' }).flush({ config_file: { YtdlMaterial: configuration(true, true) } });
    service.completeOIDCLogin('rejected-callback');
    expectAuthRequest('rejected-callback').flush({}, { status, statusText: 'Rejected' });

    expect(service.token).toBeNull();
    expect(service.httpOptions.params.has('jwt')).toBe(false);
    expect(localStorage.getItem('jwt_token')).toBeNull();
    expect(service.isLoggedIn).toBe(false);
    expect(service.user).toBeNull();
    expect(service.hasSession()).toBe(false);
    expect(router.navigate).toHaveBeenCalledExactlyOnceWith(['/login'], { queryParams: { returnTo: '/player;uid=file-1' } });
    http.expectNone(API + 'config');
  });

  it('removes an expired saved credential before checking for a local administrator', () => {
    start({ token: 'expired-token', route: '/settings' }).flush({ config_file: { YtdlMaterial: configuration() } });
    expectAuthRequest('expired-token').flush({}, { status: 401, statusText: 'Unauthorized' });
    expectAdminCheck();

    expect(service.token).toBeNull();
    expect(service.httpOptions.params.has('jwt')).toBe(false);
    expect(localStorage.getItem('jwt_token')).not.toBe('expired-token');
    expect(service.initialized).toBe(true);
    expect(service.hasSession()).toBe(false);
    expect(router.navigate).toHaveBeenCalledExactlyOnceWith(['/login'], { queryParams: { returnTo: '/settings' } });
    expect(snackBar.open).not.toHaveBeenCalled();
    http.expectNone(API + 'config');
  });

  it.each([
    { status: 429, body: {}, statusText: 'Too Many Requests', message: 'Too many authentication requests. Please wait and try again.' },
    { status: 503, body: { message: 'Authentication is temporarily unavailable' }, statusText: 'Service Unavailable', message: 'Authentication is temporarily unavailable' },
    { status: 500, body: { error: 'Cannot reach account store' }, statusText: 'Server Error', message: 'Cannot reach account store' }
  ])('retains the saved credential after a temporary HTTP $status failure', ({ status, body, statusText, message }) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    start({ token: 'saved-token', route: '/subscriptions' }).flush({ config_file: { YtdlMaterial: configuration() } });
    expectAuthRequest('saved-token').flush(body, { status, statusText });

    expect(localStorage.getItem('jwt_token')).toBe('saved-token');
    expect(service.token).toBe('saved-token');
    expect(service.httpOptions.params.get('jwt')).toBe('saved-token');
    expect(service.initialized).toBe(true);
    expect(service.isLoggedIn).toBe(false);
    expect(service.hasSession()).toBe(false);
    expect(service.hasPermission('settings')).toBe(false);
    expect(snackBar.open).toHaveBeenCalledExactlyOnceWith(message, '', { duration: 2000 });
    expect(router.navigate).toHaveBeenCalledExactlyOnceWith(['/login'], { queryParams: { returnTo: '/subscriptions' } });
    http.expectNone(req => req.url === API + 'auth/adminExists' || req.url === API + 'config');
  });

  it.each(['/home', '/login?returnTo=%2Ftasks'])('clears session and library state on logout from %s', route => {
    start({ token: 'saved-token' }).flush({ config_file: { YtdlMaterial: configuration() } });
    expectAuthRequest('saved-token').flush(SESSION);
    expectConfigRequest(SESSION.token).flush({ config_file: { YtdlMaterial: configuration() } });
    service.viewLibrary({ uid: 'bob', name: 'Bob' });
    const libraryChanged = vi.fn();
    service.library_changed.subscribe(libraryChanged);
    router.url = route;

    service.logout();

    expect(service.user).toBeNull();
    expect(service.permissions).toBeNull();
    expect(service.token).toBeNull();
    expect(service.isLoggedIn).toBe(false);
    expect(service.hasSession()).toBe(false);
    expect(service.hasPermission('settings')).toBe(false);
    expect(service.viewedLibraryUid).toBeNull();
    expect(libraryChanged).toHaveBeenCalledExactlyOnceWith(null);
    expect(localStorage.getItem('jwt_token')).not.toBe(SESSION.token);
    if (route.startsWith('/login')) {
      expect(router.navigate).not.toHaveBeenCalled();
    } else {
      expect(router.navigate).toHaveBeenCalledExactlyOnceWith(['/login']);
    }

    service.getNotifications().subscribe();
    const request = http.expectOne(API + 'getNotifications');
    expect(request.request.params.keys()).toEqual([]);
    request.flush({ notifications: [] });
  });

  describe('with the application HTTP interceptor', () => {
    beforeEach(() => {
      TestBed.configureTestingModule({
        providers: [provideHttpClient(withInterceptors([h401InterceptorFn])), provideHttpClientTesting()]
      });
    });

    it.each([
      { status: 401, statusText: 'Unauthorized', cleared: true, message: null },
      { status: 429, statusText: 'Too Many Requests', cleared: false, message: 'Too many authentication requests. Please wait and try again.' },
      { status: 503, statusText: 'Service Unavailable', cleared: false, message: 'Service Unavailable' }
    ])('handles the interceptor-normalized HTTP $status failure', ({ status, statusText, cleared, message }) => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      start({ token: 'saved-token', route: '/login?returnTo=%2Fsettings' }).flush({ config_file: { YtdlMaterial: configuration() } });
      expectAuthRequest('saved-token').flush({}, { status, statusText });
      if (cleared) expectAdminCheck();

      expect(service.token).toBe(cleared ? null : 'saved-token');
      expect(service.httpOptions.params.get('jwt')).toBe(cleared ? null : 'saved-token');
      expect(localStorage.getItem('jwt_token') === 'saved-token').toBe(!cleared);
      expect(service.initialized).toBe(true);
      expect(service.hasSession()).toBe(false);
      expect(router.navigate).not.toHaveBeenCalled();
      if (message) {
        expect(snackBar.open).toHaveBeenCalledExactlyOnceWith(message, '', { duration: 2000 });
      } else {
        expect(snackBar.open).not.toHaveBeenCalled();
      }
    });
  });
});
