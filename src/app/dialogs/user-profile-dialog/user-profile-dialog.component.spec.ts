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
