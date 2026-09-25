import { Component, OnInit, ChangeDetectionStrategy } from '@angular/core';
import { PostsService } from 'app/posts.services';
import { Router } from '@angular/router';
import { MatDialogRef, MatDialogTitle, MatDialogContent, MatDialogActions, MatDialogClose } from '@angular/material/dialog';
import { isoLangs } from './locales_list';
import { CdkScrollable } from '@angular/cdk/scrolling';
import { MatTooltip } from '@angular/material/tooltip';
import { MatIcon } from '@angular/material/icon';
import { FormsModule } from '@angular/forms';
import { DatePipe } from '@angular/common';
import { PickerComponent, PickerOption } from 'app/components/picker/picker.component';
import { MatMenu, MatMenuItem, MatMenuTrigger } from '@angular/material/menu';
import { MatSlideToggle, MatSlideToggleChange } from '@angular/material/slide-toggle';
import { SharedLibrary } from 'api-types';

@Component({
    selector: 'app-user-profile-dialog',
    templateUrl: './user-profile-dialog.component.html',
    styleUrls: ['./user-profile-dialog.component.scss'],
    changeDetection: ChangeDetectionStrategy.Eager,
    host: { class: 'kit-dialog' },
    imports: [MatDialogTitle, CdkScrollable, MatDialogContent, MatTooltip, MatIcon, FormsModule, PickerComponent, MatMenu, MatMenuItem, MatMenuTrigger, MatSlideToggle, MatDialogActions, MatDialogClose, DatePipe]
})
export class UserProfileDialogComponent implements OnInit {

  all_locales = isoLangs;
  supported_locales = ['en', 'es', 'de', 'fr', 'nl', 'pt', 'it', 'ca', 'cs', 'nb', 'ru', 'zh', 'ko', 'id', 'en-GB'];
  initialLocale = localStorage.getItem('locale') || 'en';
  sidepanel_mode = this.postsService.sidepanel_mode;
  card_size = this.postsService.card_size;
  sidepanel_options: PickerOption[] = [
    { value: 'over', label: $localize`Over` },
    { value: 'side', label: $localize`Side` }
  ];
  card_size_options: PickerOption[] = [
    { value: 'large', label: $localize`Large` },
    { value: 'medium', label: $localize`Medium` },
    { value: 'small', label: $localize`Small` }
  ];

  get localeOptions(): PickerOption[] {
    return this.supported_locales.map(locale => ({
      value: locale,
      label: this.all_locales[locale]?.nativeName || locale
    }));
  }

  // Per-user API tokens. new_token holds the one value the server will ever return in
  // plaintext, so it stays on screen until the dialog closes and is never fetched again.
  api_tokens = [];
  api_tokens_loading = false;
  new_token_label = '';
  new_token = null;
  token_error = null;
  unnamedTokenLabel = $localize`Unnamed token`;

  // The other accounts sharing their library, which the name at the top switches between.
  shared_libraries: SharedLibrary[] = [];
  library_sharing_saving = false;

  constructor(public postsService: PostsService, private router: Router, public dialogRef: MatDialogRef<UserProfileDialogComponent>) { }

  ngOnInit(): void {
    if (this.postsService.isLoggedIn) {
      this.loadAPITokens();
      this.loadSharedLibraries();
    }

    this.postsService.getSupportedLocales().subscribe(res => {
      if (res && res['supported_locales']) {
        this.supported_locales = ['en', 'en-GB']; // required
        this.supported_locales = this.supported_locales.concat(res['supported_locales']);
      }
    }, err => {
      console.error(`Failed to retrieve list of supported languages! You may need to run: 'node src/postbuild.mjs'. Error below:`);
      console.error(err);
    });
  }

  get viewedLibraryName(): string {
    return this.postsService.viewed_library?.name ?? this.postsService.user?.name ?? '';
  }

  get librarySwitchLabel(): string {
    return $localize`:Library switch label:Library: ${this.viewedLibraryName}:owner name:`;
  }

  loadSharedLibraries(): void {
    this.postsService.getSharedLibraries().subscribe(res => {
      this.shared_libraries = res && Array.isArray(res.libraries) ? res.libraries : [];
    }, () => {
      this.shared_libraries = [];
    });
  }

  viewLibrary(library: SharedLibrary | null): void {
    this.postsService.viewLibrary(library);
    this.dialogRef.close();
    this.router.navigate(['/home']);
  }

  librarySharingChanged(change: MatSlideToggleChange): void {
    const enabled = change.checked;
    const failed = () => {
      change.source.checked = !enabled;
      this.postsService.openSnackBar($localize`Could not change library sharing. Please try again.`);
    };

    this.library_sharing_saving = true;
    this.postsService.setLibrarySharing(enabled).subscribe(res => {
      this.library_sharing_saving = false;
      if (!res?.success) return failed();
      this.postsService.user.library_shared = enabled;
      this.postsService.openSnackBar(enabled
        ? $localize`Your library is now shared with everyone on this server.`
        : $localize`Your library is no longer shared.`);
    }, () => {
      this.library_sharing_saving = false;
      failed();
    });
  }

  loadAPITokens(): void {
    this.api_tokens_loading = true;
    this.postsService.listAPITokens().subscribe(res => {
      this.api_tokens_loading = false;
      this.api_tokens = res && res['tokens'] ? res['tokens'] : [];
    }, () => {
      this.api_tokens_loading = false;
      this.api_tokens = [];
    });
  }

  generateAPIToken(): void {
    this.token_error = null;
    this.postsService.generateAPIToken(this.new_token_label).subscribe(res => {
      if (!res || !res['success']) {
        this.token_error = res && res['error'] ? res['error'] : $localize`Could not generate a token.`;
        return;
      }
      this.new_token = res['token'];
      this.new_token_label = '';
      this.loadAPITokens();
    }, err => {
      this.token_error = err && err.error && err.error.error ? err.error.error : $localize`Could not generate a token.`;
    });
  }

  copyNewToken(): void {
    navigator.clipboard.writeText(this.new_token).then(() => {
      this.postsService.openSnackBar($localize`Token copied to the clipboard.`);
    }, () => {
      this.postsService.openSnackBar($localize`Could not copy automatically -- select the token and copy it.`);
    });
  }

  dismissNewToken(): void {
    this.new_token = null;
  }

  revokeAPIToken(token_id: string): void {
    this.postsService.revokeAPIToken(token_id).subscribe(res => {
      if (res && res['success']) {
        this.postsService.openSnackBar($localize`Token revoked.`);
        this.loadAPITokens();
      } else {
        this.postsService.openSnackBar($localize`Could not revoke that token.`);
      }
    });
  }

  loginClicked() {
    this.router.navigate(['/login']);
    this.dialogRef.close();
  }

  logoutClicked() {
    this.postsService.logout();
    this.dialogRef.close();
  }

  localeSelectChanged(new_val: unknown): void {
    if (typeof new_val !== 'string') return;
    localStorage.setItem('locale', new_val);
    this.postsService.openSnackBar($localize`Language successfully changed! Reload to update the page.`)
  }

  sidePanelModeChanged(new_mode) {
    localStorage.setItem('sidepanel_mode', new_mode);
    this.postsService.sidepanel_mode = new_mode;
  }

  cardSizeOptionChanged(new_size) {
    localStorage.setItem('card_size', new_size);
    this.postsService.card_size = new_size;
  }

}
