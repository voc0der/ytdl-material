import { Component, OnInit, Inject, ChangeDetectionStrategy } from '@angular/core';
import { MatDialogRef, MAT_DIALOG_DATA, MatDialogTitle, MatDialogContent, MatDialogActions, MatDialogClose } from '@angular/material/dialog';
import { PostsService } from 'app/posts.services';
import { UserPermission, YesNo } from 'api-types';
import { CdkScrollable } from '@angular/cdk/scrolling';
import { MatIcon } from '@angular/material/icon';

@Component({
    selector: 'app-manage-role',
    templateUrl: './manage-role.component.html',
    styleUrls: ['./manage-role.component.scss'],
    changeDetection: ChangeDetectionStrategy.Eager,
    host: { class: 'kit-dialog' },
    imports: [MatDialogTitle, CdkScrollable, MatDialogContent, MatIcon, MatDialogActions, MatDialogClose]
})
export class ManageRoleComponent implements OnInit {

  role = null;
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

  readonly permissionChoices: { value: YesNo, label: string }[] = [
    { value: YesNo.YES, label: $localize`Yes` },
    { value: YesNo.NO, label: $localize`No` }
  ];

  constructor(public postsService: PostsService, private dialogRef: MatDialogRef<ManageRoleComponent>,
              @Inject(MAT_DIALOG_DATA) public data: {role: string}) {
    if (this.data) {
      this.role = this.data.role;
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
      if (this.role.permissions.includes(permission)) {
        this.permissions[permission] = 'yes';
      } else {
      this.permissions[permission] = 'no';
      }
    }
  }

  /** The admin role is what settings access exists for, so it cannot be taken away here. */
  permissionLocked(permission: string): boolean {
    return permission === 'settings' && this.role?.key === 'admin';
  }

  setPermission(permission: UserPermission, value: YesNo) {
    if (this.permissionLocked(permission) || this.permissions[permission] === value) return;
    const previous = this.permissions[permission];
    this.permissions[permission] = value;
    this.postsService.setRolePermission(this.role.key, permission, value).subscribe(res => {
      if (!res['success']) {
        this.permissions[permission] = previous;
      }
    }, err => {
      this.permissions[permission] = previous;
    });
  }

}
