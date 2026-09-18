import { HttpErrorResponse, HttpRequest } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { MatSnackBar } from '@angular/material/snack-bar';
import { Router } from '@angular/router';
import { firstValueFrom, throwError } from 'rxjs';

import { h401InterceptorFn } from './http.interceptor';

describe('h401InterceptorFn', () => {
  let router: any;
  let snackBar: any;

  function unauthorizedOn(url: string) {
    router.url = url;
    const request = new HttpRequest('POST', '/api/auth/login', {});
    const next = () => throwError(() => new HttpErrorResponse({ status: 401, statusText: 'Unauthorized' }));
    return TestBed.runInInjectionContext(() => firstValueFrom(h401InterceptorFn(request, next)).catch(error => error));
  }

  beforeEach(() => {
    router = { url: '/home', navigate: vi.fn().mockName('navigate').mockResolvedValue(true) };
    snackBar = { open: vi.fn().mockName('open') };
    TestBed.configureTestingModule({
      providers: [
        { provide: Router, useValue: router },
        { provide: MatSnackBar, useValue: snackBar }
      ]
    });
  });

  it('sends a page whose session expired to log in again', async () => {
    const error = await unauthorizedOn('/home');
    await Promise.resolve();

    expect(error).toBe('Unauthorized');
    expect(router.navigate).toHaveBeenCalledWith(['/login']);
    expect(snackBar.open).toHaveBeenCalledWith('Login expired, please login again.', '', { duration: 2000 });
  });

  // A wrong password is a 401 as well. On the login page -- whose URL usually says where to go
  // afterwards -- it is the page's own error to show, not an expired session.
  it('leaves the login page alone, whatever its query says', async () => {
    const error = await unauthorizedOn('/login?returnTo=%2Fsubscriptions');
    await Promise.resolve();

    expect(error).toBe('Unauthorized');
    expect(router.navigate).not.toHaveBeenCalled();
    expect(snackBar.open).not.toHaveBeenCalled();
  });
});
