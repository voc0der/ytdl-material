import { Component, OnInit, Inject, ChangeDetectionStrategy } from '@angular/core';
import { PostsService } from 'app/posts.services';
import { MAT_DIALOG_DATA, MatDialogTitle, MatDialogContent, MatDialogActions, MatDialogClose } from '@angular/material/dialog';
import { User, UserPermission, YesNo } from 'api-types';
import { CdkScrollable } from '@angular/cdk/scrolling';
import { FormsModule } from '@angular/forms';
import { MatIcon } from '@angular/material/icon';
import { MatProgressSpinner } from '@angular/material/progress-spinner';

// What a refused password change says, from the server's answer: the interceptor hands on its
// message, not its status.
function passwordChangeError(message: string | null): string {
  if (message === 'The current password is incorrect') return $localize`The current password is incorrect.`;
  if (typeof message === 'string' && message.startsWith('Too many')) {
    return $localize`Too many authentication requests. Please wait and try again.`;
  }
  return $localize`Could not save changes. Please try again.`;
}

@Component({
    selector: 'app-manage-user',
    templateUrl: './manage-user.component.html',
    styleUrls: ['./manage-user.component.scss'],
    changeDetection: ChangeDetectionStrategy.Eager,
    host: { class: 'kit-dialog' },
    imports: [MatDialogTitle, CdkScrollable, MatDialogContent, MatIcon, FormsModule, MatProgressSpinner, MatDialogActions, MatDialogClose]
})
export class ManageUserComponent implements OnInit {

  user = null;
  newPasswordInput = '';
  currentPasswordInput = '';
  passwordError: string | null = null;
  available_permissions = null;
  permissions = null;

  permissionToLabel = {
    'filemanager': $localize`File manager`,
    'settings': $localize`Settings access`,
    'subscriptions': $localize`Subscriptions`,
    'sharing': $localize`Share files`,
    'advanced_download': $localize`Use advanced download mode`,
    'downloads_manager': $localize`Use downloads manager`,
    'tasks_manager': $localize`Use tasks manager`,
  }

  settingNewPassword = false;

  readonly newPasswordLabel = $localize`New password`;
  readonly currentPasswordLabel = $localize`Current password`;
  readonly permissionChoices: { value: YesNo | 'default', label: string }[] = [
    { value: 'default', label: $localize`Use role default` },
    { value: YesNo.YES, label: $localize`Yes` },
    { value: YesNo.NO, label: $localize`No` }
  ];

  constructor(public postsService: PostsService, @Inject(MAT_DIALOG_DATA) public data: {user: User}) {
    if (this.data) {
      this.user = this.data.user;
      this.available_permissions = this.postsService.available_permissions;
      this.parsePermissions();
    }
  }

  ngOnInit(): void {
  }

  parsePermissions() {
    this.permissions = {};
    for (let i = 0; i < this.available_permissions.length; i++) {
      const permission = this.available_permissions[i];
      if (this.user.permission_overrides.includes(permission)) {
        if (this.user.permissions.includes(permission)) {
          this.permissions[permission] = 'yes';
        } else {
        this.permissions[permission] = 'no';
        }
      } else {
        this.permissions[permission] = 'default';
      }
    }
  }

  /** Settings access is what this dialog is opened through, so it cannot be taken away here. */
  permissionLocked(permission: string): boolean {
    return permission === 'settings' && this.postsService.user?.uid === this.user?.uid;
  }

  setPermission(permission: UserPermission, value: YesNo | 'default') {
    if (this.permissionLocked(permission) || this.permissions[permission] === value) return;
    this.permissions[permission] = value;
    this.postsService.setUserPermission(this.user.uid, permission, value).subscribe(() => {
      // console.log(res);
    });
  }

  /**
   * Your own account. Its password takes the current one, as anybody's own does: a browser
   * left signed in is not proof of who is at it. Anybody else's an administrator sets without.
   */
  get editingSelf(): boolean {
    return !!this.user && this.postsService.user?.uid === this.user.uid;
  }

  get canSetNewPassword(): boolean {
    return !this.settingNewPassword && this.newPasswordInput.length > 0
      && (!this.editingSelf || this.currentPasswordInput.length > 0);
  }

  setNewPassword() {
    if (!this.canSetNewPassword) return;
    this.settingNewPassword = true;
    this.passwordError = null;
    const currentPassword = this.editingSelf ? this.currentPasswordInput : null;
    this.postsService.changeUserPassword(this.user.uid, this.newPasswordInput, currentPassword).subscribe({
      next: res => {
        this.settingNewPassword = false;
        if (!res?.success) {
          this.passwordError = passwordChangeError(null);
          return;
        }
        // The new password ended every session on the account; this one carries on with this token.
        if (res.token) this.postsService.replaceSessionToken(res.token);
        this.newPasswordInput = '';
        this.currentPasswordInput = '';
      },
      error: message => {
        this.settingNewPassword = false;
        this.passwordError = passwordChangeError(message);
        // A wrong one is typed again, not edited: what was typed is not shown.
        if (message === 'The current password is incorrect') this.currentPasswordInput = '';
      }
    });
  }

}
