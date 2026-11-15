import { HttpErrorResponse } from '@angular/common/http';
import { of, throwError } from 'rxjs';

import { PostsService } from './posts.services';
import { THEMES_CONFIG } from '../themes';

// The service's own checks, called on a stand-in for the service, as the route guard's are.
describe('PostsService first-run checks', () => {
  function service(overrides: Record<string, unknown> = {}): any {
    return {
      isOIDCEnabled: () => false,
      isHeaderAuthEnabled: () => false,
      config: { Advanced: { multi_user_mode: true } },
      adminExists: vi.fn(() => of({ exists: false })),
      open_create_default_admin_dialog: { next: vi.fn() },
      openSnackBar: vi.fn(),
      isTooManyRequestsError: (PostsService.prototype as any).isTooManyRequestsError,
      getErrorMessage: (PostsService.prototype as any).getErrorMessage,
      ...overrides
    };
  }
  const check = (fake: any, force_show = false) => PostsService.prototype.checkAdminCreationStatus.call(fake, force_show);

  it('asks for an admin account only where there are accounts, unless asked to', () => {
    const single_user = service({ config: { Advanced: { multi_user_mode: false } } });
    check(single_user);
    expect(single_user.adminExists).not.toHaveBeenCalled();

    check(single_user, true);
    expect(single_user.open_create_default_admin_dialog.next).toHaveBeenCalledWith(true);
  });

  it('never asks while single sign-on or header sign-in makes the accounts', () => {
    for (const fake of [service({ isOIDCEnabled: () => true }), service({ isHeaderAuthEnabled: () => true })]) {
      check(fake, true);
      expect(fake.adminExists).not.toHaveBeenCalled();
    }
  });

  it('leaves the dialog shut once there is an admin', () => {
    const fake = service({ adminExists: vi.fn(() => of({ exists: true })) });
    check(fake);
    expect(fake.open_create_default_admin_dialog.next).not.toHaveBeenCalled();
  });

  it('says why it could not check, but only when it was asked to', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const failing = (status: number) => service({ adminExists: vi.fn(() => throwError(() => new HttpErrorResponse({ status }))) });

    const quiet = failing(500);
    check(quiet);
    expect(quiet.openSnackBar).not.toHaveBeenCalled();

    const limited = failing(429);
    check(limited, true);
    expect(limited.openSnackBar).toHaveBeenCalledWith('Too many authentication requests. Please wait and try again.');

    const broken = failing(500);
    check(broken, true);
    expect(broken.openSnackBar).toHaveBeenCalledWith('Failed to check whether a default admin account exists.');
    vi.restoreAllMocks();
  });

  it('keeps the theme picked, and lets a started app straight through the route guard', async () => {
    const fake: any = { THEMES_CONFIG, initialized: true, _canActivate: vi.fn().mockResolvedValue(true) };
    PostsService.prototype.setTheme.call(fake, 'dark');
    expect(fake.theme).toBe(THEMES_CONFIG['dark']);

    expect(await PostsService.prototype.canActivate.call(fake, { routeConfig: { path: 'settings' } } as any, null)).toBe(true);
    expect(fake._canActivate).toHaveBeenCalledOnce();
  });
});
