import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { inject, NgZone } from '@angular/core';
import { MatSnackBar } from '@angular/material/snack-bar';
import { Router } from '@angular/router';
import { Observable, throwError } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { compactPlayerPath } from './utils/player-link';

function runInAngularZone<T>(source$: Observable<T>, ngZone: NgZone): Observable<T> {
    return new Observable<T>((subscriber) => {
        const subscription = source$.subscribe({
            next: (value) => ngZone.run(() => subscriber.next(value)),
            error: (error) => ngZone.run(() => subscriber.error(error)),
            complete: () => ngZone.run(() => subscriber.complete())
        });

        return () => subscription.unsubscribe();
    });
}

export const h401InterceptorFn: HttpInterceptorFn = (request, next) => {
    const router = inject(Router);
    const snackBar = inject(MatSnackBar);
    const ngZone = inject(NgZone);

    return runInAngularZone(next(request), ngZone).pipe(
        catchError((err: HttpErrorResponse) => {
            if (err.status === 401) {
                localStorage.setItem('jwt_token', null);
                // The login page's own URL usually carries ?returnTo=, and a wrong password is a
                // 401 too. Neither is a session expiring, and sending the page to itself would
                // lose where to go after logging in.
                if (!router.url.startsWith('/login') && !router.url.includes('player')) {
                    const compact_player = /^\/(video|audio|playlist)(\?|$)/.test(router.url) ? router.url
                        : router.url === '/' ? compactPlayerPath(window.location.pathname, window.location.search) : null;
                    const login = compact_player
                        ? router.navigate(['/login'], {queryParams: {returnTo: compact_player}})
                        : router.navigate(['/login']);
                    login.then(() => {
                        snackBar.open('Login expired, please login again.', '', { duration: 2000 });
                    });
                }
            }

            const error = err?.error?.message || err?.error?.error || err?.statusText || 'Request failed';
            return throwError(error);
        })
    );
};
