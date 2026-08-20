import { Component, OnInit, ChangeDetectionStrategy } from '@angular/core';
import { PostsService } from 'app/posts.services';
import { Router } from '@angular/router';
import { MatDialogRef } from '@angular/material/dialog';
import { isoLangs } from './locales_list';

@Component({
    selector: 'app-user-profile-dialog',
    templateUrl: './user-profile-dialog.component.html',
    styleUrls: ['./user-profile-dialog.component.scss'],
    changeDetection: ChangeDetectionStrategy.Eager,
    standalone: false
})
export class UserProfileDialogComponent implements OnInit {

  all_locales = isoLangs;
  supported_locales = ['en', 'es', 'de', 'fr', 'nl', 'pt', 'it', 'ca', 'cs', 'nb', 'ru', 'zh', 'ko', 'id', 'en-GB'];
  initialLocale = localStorage.getItem('locale');
  sidepanel_mode = this.postsService.sidepanel_mode;
  card_size = this.postsService.card_size;

  // Per-user API tokens. new_token holds the one value the server will ever return in
  // plaintext, so it stays on screen until the dialog closes and is never fetched again.
  api_tokens = [];
  api_tokens_loading = false;
  new_token_label = '';
  new_token = null;
  token_error = null;

  constructor(public postsService: PostsService, private router: Router, public dialogRef: MatDialogRef<UserProfileDialogComponent>) { }

  ngOnInit(): void {
    if (this.postsService.isLoggedIn) this.loadAPITokens();

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

  localeSelectChanged(new_val: string): void {
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
