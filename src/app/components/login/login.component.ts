import { Component, OnInit, ChangeDetectionStrategy } from '@angular/core';
import { PostsService } from 'app/posts.services';
import { ActivatedRoute } from '@angular/router';
import { Router } from '@angular/router';
import { filter, take } from 'rxjs/operators';
import { MatIcon } from '@angular/material/icon';
import { MatProgressSpinner } from '@angular/material/progress-spinner';
import { MatTooltip } from '@angular/material/tooltip';
import { FormsModule } from '@angular/forms';
import { Location, NgTemplateOutlet } from '@angular/common';

type LoginMode = 'login' | 'register';

@Component({
    selector: 'app-login',
    templateUrl: './login.component.html',
    styleUrls: ['./login.component.scss'],
    changeDetection: ChangeDetectionStrategy.Eager,
    imports: [MatIcon, MatProgressSpinner, MatTooltip, FormsModule, NgTemplateOutlet]
})
export class LoginComponent implements OnInit {

  readonly showPasswordLabel = $localize`:Show password button:Show password`;
  readonly hidePasswordLabel = $localize`:Hide password button:Hide password`;

  mode: LoginMode = 'login';
  showPassword = false;
  // What went wrong with the last attempt, or what happened, said on the card itself rather
  // than in a snackbar that is gone before anybody has read it.
  error: string | null = null;
  notice: string | null = null;

  // login
  loginUsernameInput = '';
  loginPasswordInput = '';
  loggingIn = false;

  // registration
  registrationEnabled = false;
  registrationUsernameInput = '';
  registrationPasswordInput = '';
  registrationPasswordConfirmationInput = '';
  registering = false;
  oidcEnabled = false;
  oidcRedirecting = false;
  headerAuthEnabled = false;
  headerSigningIn = false;
  returnTo = '/';

  constructor(public postsService: PostsService, private router: Router, private route: ActivatedRoute,
    private location: Location) { }

  private getErrorCode(err: any): number | null {
    return err && typeof err === 'object' && typeof err.status === 'number' ? err.status : null;
  }

  private getErrorMessage(err: any): string {
    if (typeof err === 'string') {
      return err;
    }
    return err?.error?.message || err?.error?.error || err?.statusText || '';
  }

  get appTitle(): string {
    return this.postsService.getBaseTitle();
  }

  ngOnInit(): void {
    const routeReturnTo = this.route.snapshot.queryParamMap.get('returnTo');
    this.returnTo = routeReturnTo && routeReturnTo.startsWith('/') ? routeReturnTo : '/';

    // The sign-in token stays in a fragment so it is not sent in a page request or referrer.
    // This is a one-time credential handoff, not a client-side routing path.
    const handoff = new URLSearchParams(this.route.snapshot.fragment ?? '');
    const oidcToken = handoff.get('oidc_token');
    const oidcRedirectPath = handoff.get('redirect');
    let oidcHandoffRefused = false;
    if (oidcToken) {
      // Nor is it left in the address bar, or in history for the back button to find again.
      this.location.replaceState(this.location.path(false));
      // Only the answer to a sign-in this tab started. Anybody can write a token into a link,
      // or start a sign-in at the provider and send the callback on: either would sign this
      // browser in as them.
      if (this.postsService.takeOIDCHandoff(handoff.get('handoff'))) {
        const redirectPath = oidcRedirectPath && oidcRedirectPath.startsWith('/') ? oidcRedirectPath : this.returnTo;
        this.postsService.completeOIDCLogin(oidcToken, redirectPath);
        return;
      }
      console.warn('Ignored a sign-in token that this tab did not ask for.');
      oidcHandoffRefused = true;
    }

    if (this.postsService.isLoggedIn && localStorage.getItem('jwt_token') !== 'null') {
      this.router.navigate(['/']);
    }
    this.postsService.service_initialized
      .pipe(filter(Boolean), take(1))
      .subscribe(() => {
        if (!this.postsService.config['Advanced']['multi_user_mode']) {
          this.router.navigate(['/']);
          return;
        }
        this.oidcEnabled = this.postsService.isOIDCEnabled();
        if (this.oidcEnabled) {
          // Going straight back to the provider would answer a refused token with another
          // one, and a tab that cannot keep its handoff value would go round for ever.
          if (oidcHandoffRefused) {
            this.error = $localize`:OIDC sign-in refused:That sign-in did not start in this tab, so it was not used.`;
            return;
          }
          this.redirectToOIDC();
          return;
        }
        this.headerAuthEnabled = this.postsService.isHeaderAuthEnabled();
        if (this.headerAuthEnabled) {
          this.signInWithHeader();
          return;
        }
        this.registrationEnabled = this.postsService.config['Users'] && this.postsService.config['Users']['allow_registration'];
      });
  }

  setMode(mode: LoginMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.error = null;
    this.notice = null;
    this.showPassword = false;
  }

  get busy(): boolean {
    return this.loggingIn || this.registering;
  }

  get canLogin(): boolean {
    return !this.loggingIn && !!this.loginUsernameInput && !!this.loginPasswordInput;
  }

  get canRegister(): boolean {
    return !this.registering && !!this.registrationUsernameInput && !!this.registrationPasswordInput
      && !!this.registrationPasswordConfirmationInput;
  }

  submit(): void {
    if (this.mode === 'register') {
      this.register();
    } else {
      this.login();
    }
  }

  login() {
    if (!this.canLogin) {
      return;
    }
    this.loggingIn = true;
    this.error = null;
    this.notice = null;
    this.postsService.login(this.loginUsernameInput, this.loginPasswordInput).subscribe(res => {
      this.loggingIn = false;
      if (res['token']) {
        this.postsService.afterLogin(res['user'], res['token'], res['permissions'], res['available_permissions'], this.returnTo);
      } else {
        this.error = $localize`:Login failed unknown error:Login failed, unknown error.`;
      }
    }, err => {
      this.loggingIn = false;
      const error_code = this.getErrorCode(err);
      const error_message = this.getErrorMessage(err);
      if (error_code === 401 || error_message === 'Unauthorized') {
        this.error = $localize`:Login wrong credentials:User name or password is incorrect!`;
      } else if (error_code === 404) {
        this.error = $localize`:Login server unreachable:Login failed, cannot connect to the server.`;
      } else if (error_code === 429 || error_message === 'Too Many Requests' || error_message === 'Too many authentication requests. Please wait and try again.') {
        this.error = $localize`:Login rate limited:Too many authentication requests. Please wait and try again.`;
      } else {
        this.error = error_message || $localize`:Login failed unknown error:Login failed, unknown error.`;
      }
    });
  }

  register() {
    this.error = null;
    this.notice = null;
    if (!this.registrationUsernameInput) {
      this.error = $localize`:Registration user name required:User name is required!`;
      return;
    }

    if (!this.registrationPasswordInput) {
      this.error = $localize`:Registration password required:Password is required!`;
      return;
    }

    if (!this.registrationPasswordConfirmationInput) {
      this.error = $localize`:Registration confirmation required:Password confirmation is required!`;
      return;
    }

    if (this.registrationPasswordInput !== this.registrationPasswordConfirmationInput) {
      this.error = $localize`:Registration passwords differ:The passwords do not match.`;
      return;
    }

    this.registering = true;
    this.postsService.register(this.registrationUsernameInput, this.registrationPasswordInput).subscribe(res => {
      this.registering = false;
      if (res && res['user']) {
        const name = res['user']['name'];
        this.loginUsernameInput = name;
        this.loginPasswordInput = '';
        this.registrationPasswordInput = '';
        this.registrationPasswordConfirmationInput = '';
        this.setMode('login');
        this.notice = $localize`:Registration succeeded:Registered ${name}:user name:. Log in to continue.`;
      } else {
        this.error = $localize`:Registration failed unknown error:Failed to register user, unknown error.`;
      }
    }, err => {
      this.registering = false;
      if (err && err.error && typeof err.error === 'string') {
        this.error = err.error;
      } else {
        this.error = this.getErrorMessage(err) || $localize`:Registration failed unknown error:Failed to register user, unknown error.`;
      }
    });
  }

  // The reverse proxy in front of the server has already signed the visitor in; this asks the
  // server to accept that, and says why it did not.
  signInWithHeader() {
    if (this.headerSigningIn) {
      return;
    }
    this.headerSigningIn = true;
    this.error = null;
    this.postsService.headerLogin(this.returnTo || '/', error => {
      this.headerSigningIn = false;
      this.error = error || $localize`:Header login failed unknown error:Signing in through the reverse proxy failed.`;
    });
  }

  redirectToOIDC() {
    if (this.oidcRedirecting) {
      return;
    }
    this.oidcRedirecting = true;
    this.error = null;
    const handoff = this.postsService.beginOIDCHandoff();
    window.location.href = this.postsService.getOIDCLoginURL(this.returnTo || '/', handoff);
  }

}
