import { ComponentFixture, TestBed, waitForAsync } from '@angular/core/testing';
import { Router } from '@angular/router';
import { MatDialogRef } from '@angular/material/dialog';
import { MatSlideToggle } from '@angular/material/slide-toggle';
import { By } from '@angular/platform-browser';
import { of, throwError } from 'rxjs';

import { UserProfileDialogComponent } from './user-profile-dialog.component';
import { PostsService } from 'app/posts.services';
import { configureTestBed } from '../../../testing/test-bed';

describe('UserProfileDialogComponent', () => {
  let component: UserProfileDialogComponent;
  let fixture: ComponentFixture<UserProfileDialogComponent>;

  beforeEach(waitForAsync(() => {
    configureTestBed({
      imports: [ UserProfileDialogComponent ]
    })
    .compileComponents();
  }));

  beforeEach(() => {
    fixture = TestBed.createComponent(UserProfileDialogComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});

describe('UserProfileDialogComponent with shared libraries', () => {
  let component: UserProfileDialogComponent;
  let fixture: ComponentFixture<UserProfileDialogComponent>;
  let postsServiceStub: any;
  let routerStub: any;
  let dialogRefStub: any;

  const element = (): HTMLElement => fixture.nativeElement;

  beforeEach(waitForAsync(() => {
    postsServiceStub = {
      isLoggedIn: true,
      user: { uid: 'vocoder', name: 'vocoder', created: Date.now(), library_shared: false },
      viewed_library: null,
      viewedLibraryUid: null,
      getSharedLibraries: vi.fn().mockReturnValue(of({ libraries: [{ uid: 'bob', name: 'Bob' }] })),
      setLibrarySharing: vi.fn().mockReturnValue(of({ success: true })),
      viewLibrary: vi.fn(),
      listAPITokens: vi.fn().mockReturnValue(of({ tokens: [] })),
      getSupportedLocales: vi.fn().mockReturnValue(of({})),
      openSnackBar: vi.fn()
    };
    routerStub = { navigate: vi.fn() };
    dialogRefStub = { close: vi.fn() };

    configureTestBed({
      imports: [ UserProfileDialogComponent ],
      providers: [
        { provide: PostsService, useValue: postsServiceStub },
        { provide: Router, useValue: routerStub },
        { provide: MatDialogRef, useValue: dialogRefStub }
      ]
    })
    .compileComponents();
  }));

  beforeEach(() => {
    fixture = TestBed.createComponent(UserProfileDialogComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should turn the name into a switch once somebody shares a library', () => {
    const library_switch = element().querySelector('.account-summary h3 .library-owner-switch');

    expect(library_switch).not.toBeNull();
    expect(library_switch.textContent).toContain('vocoder');
    expect(library_switch.getAttribute('aria-label')).toBe('Library: vocoder');
  });

  it('should keep the name a plain heading while nobody shares one', () => {
    component.shared_libraries = [];
    fixture.detectChanges();

    expect(element().querySelector('.library-owner-switch')).toBeNull();
    expect(element().querySelector('.account-summary h3').textContent.trim()).toBe('vocoder');
  });

  it('should name the library being browsed, and say it is read only', () => {
    postsServiceStub.viewed_library = { uid: 'bob', name: 'Bob' };
    postsServiceStub.viewedLibraryUid = 'bob';
    fixture.detectChanges();

    expect(element().querySelector('.library-owner-switch').textContent).toContain('Bob');
    expect(element().querySelector('.library-owner-hint').textContent).toContain('Bob\'s library');
  });

  it('should switch library, close, and go to the library', () => {
    component.viewLibrary({ uid: 'bob', name: 'Bob' });

    expect(postsServiceStub.viewLibrary).toHaveBeenCalledWith({ uid: 'bob', name: 'Bob' });
    expect(dialogRefStub.close).toHaveBeenCalled();
    expect(routerStub.navigate).toHaveBeenCalledWith(['/home']);
  });

  it('should share the library from its preference', () => {
    const toggle = fixture.debugElement.query(By.directive(MatSlideToggle)).componentInstance as MatSlideToggle;

    component.librarySharingChanged({ checked: true, source: toggle } as any);

    expect(postsServiceStub.setLibrarySharing).toHaveBeenCalledWith(true);
    expect(postsServiceStub.user.library_shared).toBe(true);
    expect(component.library_sharing_saving).toBe(false);
  });

  it('should put the toggle back when sharing cannot be changed', () => {
    postsServiceStub.setLibrarySharing.mockReturnValue(throwError(() => 'offline'));
    const toggle = fixture.debugElement.query(By.directive(MatSlideToggle)).componentInstance as MatSlideToggle;
    toggle.checked = true;

    component.librarySharingChanged({ checked: true, source: toggle } as any);

    expect(toggle.checked).toBe(false);
    expect(postsServiceStub.user.library_shared).toBe(false);
    expect(postsServiceStub.openSnackBar).toHaveBeenCalled();
  });
});

describe('UserProfileDialogComponent tokens and preferences', () => {
  let component: UserProfileDialogComponent;
  let postsService: any;
  let router: any;
  let dialogRef: any;

  beforeEach(() => {
    postsService = {
      isLoggedIn: true,
      user: { uid: 'alice', name: 'Alice' },
      sidepanel_mode: 'over',
      card_size: 'medium',
      listAPITokens: vi.fn().mockReturnValue(of({ tokens: [{ id: 'token-1', label: 'Feed reader' }] })),
      getSharedLibraries: vi.fn().mockReturnValue(of({ libraries: [] })),
      getSupportedLocales: vi.fn().mockReturnValue(of({ supported_locales: ['de', 'fr'] })),
      generateAPIToken: vi.fn().mockReturnValue(of({ success: true, token: 'secret-token' })),
      revokeAPIToken: vi.fn().mockReturnValue(of({ success: true })),
      openSnackBar: vi.fn(),
      logout: vi.fn()
    };
    router = { navigate: vi.fn() };
    dialogRef = { close: vi.fn() };
    component = new UserProfileDialogComponent(postsService, router, dialogRef);
    component.ngOnInit();
  });

  afterEach(() => {
    for (const key of ['locale', 'sidepanel_mode', 'card_size']) localStorage.removeItem(key);
    vi.restoreAllMocks();
  });

  it('should offer the languages the server has, besides English', () => {
    expect(component.supported_locales).toEqual(['en', 'en-GB', 'de', 'fr']);
    expect(component.api_tokens).toEqual([{ id: 'token-1', label: 'Feed reader' }]);
  });

  it('should keep its own languages when the server cannot list them', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    postsService.getSupportedLocales.mockReturnValue(throwError(() => new Error('not built')));

    const dialog = new UserProfileDialogComponent(postsService, router, dialogRef);
    dialog.ngOnInit();

    expect(dialog.supported_locales).toContain('es');
    expect(logged).toHaveBeenCalled();
  });

  it('should show a new token once, then list it with the rest', () => {
    component.new_token_label = 'Phone';

    component.generateAPIToken();

    expect(postsService.generateAPIToken).toHaveBeenCalledWith('Phone');
    expect(component.new_token).toBe('secret-token');
    expect(component.new_token_label).toBe('');
    expect(postsService.listAPITokens).toHaveBeenCalledTimes(2);

    component.dismissNewToken();
    expect(component.new_token).toBeNull();
  });

  it('should say why a token could not be made', () => {
    postsService.generateAPIToken.mockReturnValueOnce(of({ success: false, error: 'Too many tokens' }));
    component.generateAPIToken();
    expect(component.token_error).toBe('Too many tokens');

    postsService.generateAPIToken.mockReturnValueOnce(of(null));
    component.generateAPIToken();
    expect(component.token_error).toBe('Could not generate a token.');

    postsService.generateAPIToken.mockReturnValueOnce(throwError(() => ({ error: { error: 'Sign in again' } })));
    component.generateAPIToken();
    expect(component.token_error).toBe('Sign in again');

    postsService.generateAPIToken.mockReturnValueOnce(throwError(() => new Error('offline')));
    component.generateAPIToken();
    expect(component.token_error).toBe('Could not generate a token.');
    expect(component.new_token).toBeNull();
  });

  it('should copy the new token, or say to copy it by hand', async () => {
    const writeText = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('denied'));
    const clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    component.new_token = 'secret-token';

    try {
      component.copyNewToken();
      await vi.waitFor(() => expect(postsService.openSnackBar).toHaveBeenCalledWith('Token copied to the clipboard.'));
      component.copyNewToken();
      await vi.waitFor(() => expect(postsService.openSnackBar).toHaveBeenLastCalledWith('Could not copy automatically -- select the token and copy it.'));
    } finally {
      if (clipboard) Object.defineProperty(navigator, 'clipboard', clipboard);
      else delete (navigator as any).clipboard;
    }
    expect(writeText).toHaveBeenCalledWith('secret-token');
  });

  it('should revoke a token and list what is left, or say it could not', () => {
    component.revokeAPIToken('token-1');
    expect(postsService.revokeAPIToken).toHaveBeenCalledWith('token-1');
    expect(postsService.openSnackBar).toHaveBeenCalledWith('Token revoked.');
    expect(postsService.listAPITokens).toHaveBeenCalledTimes(2);

    postsService.revokeAPIToken.mockReturnValueOnce(of({ success: false }));
    component.revokeAPIToken('token-1');
    expect(postsService.openSnackBar).toHaveBeenLastCalledWith('Could not revoke that token.');
    expect(postsService.listAPITokens).toHaveBeenCalledTimes(2);
  });

  it('should show no tokens or shared libraries when they cannot be loaded', () => {
    postsService.listAPITokens.mockReturnValueOnce(throwError(() => new Error('offline')));
    postsService.getSharedLibraries.mockReturnValueOnce(throwError(() => new Error('offline')));

    component.loadAPITokens();
    component.loadSharedLibraries();

    expect(component.api_tokens).toEqual([]);
    expect(component.api_tokens_loading).toBe(false);
    expect(component.shared_libraries).toEqual([]);
  });

  it('should sign in and out, closing as it goes', () => {
    component.loginClicked();
    component.logoutClicked();

    expect(router.navigate).toHaveBeenCalledWith(['/login']);
    expect(postsService.logout).toHaveBeenCalled();
    expect(dialogRef.close).toHaveBeenCalledTimes(2);
  });

  it('should remember the language, side panel and card size chosen', () => {
    component.localeSelectChanged('de');
    component.localeSelectChanged(7);
    component.sidePanelModeChanged('side');
    component.cardSizeOptionChanged('small');

    expect(localStorage.getItem('locale')).toBe('de');
    expect(postsService.openSnackBar).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem('sidepanel_mode')).toBe('side');
    expect(postsService.sidepanel_mode).toBe('side');
    expect(localStorage.getItem('card_size')).toBe('small');
    expect(postsService.card_size).toBe('small');
  });
});
