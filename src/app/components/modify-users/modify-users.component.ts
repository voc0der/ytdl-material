import { Component, OnInit, Input, ChangeDetectionStrategy } from '@angular/core';
import { PostsService } from 'app/posts.services';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatDialog, MatDialogRef } from '@angular/material/dialog';
import { AddUserDialogComponent } from 'app/dialogs/add-user-dialog/add-user-dialog.component';
import { ManageUserComponent } from '../manage-user/manage-user.component';
import { ManageRoleComponent } from '../manage-role/manage-role.component';
import { User } from 'api-types';
import { FormsModule } from '@angular/forms';
import { MatTooltip } from '@angular/material/tooltip';
import { MatIcon } from '@angular/material/icon';
import { MatMenuTrigger, MatMenu, MatMenuItem } from '@angular/material/menu';
import { MatProgressSpinner } from '@angular/material/progress-spinner';
import { PickerComponent, PickerOption } from 'app/components/picker/picker.component';

@Component({
    selector: 'app-modify-users',
    templateUrl: './modify-users.component.html',
    styleUrls: ['./modify-users.component.scss'],
    changeDetection: ChangeDetectionStrategy.Eager,
    imports: [FormsModule, MatTooltip, MatIcon, MatMenuTrigger, MatMenu, MatMenuItem, MatProgressSpinner, PickerComponent]
})
export class ModifyUsersComponent implements OnInit {

  deleteDialogContentSubstring = 'Are you sure you want delete user ';

  @Input() pageSize = 5;
  users: User[];
  editObject = null;
  constructedObject = {};
  roles = null;

  filter = '';
  pageIndex = 0;

  readonly searchLabel = $localize`Search`;
  readonly userNameLabel = $localize`User name`;
  readonly roleLabel = $localize`Role`;
  readonly previousPageLabel = $localize`Previous page`;
  readonly nextPageLabel = $localize`Next page`;

  readonly roleOptions: PickerOption[] = [
    { value: 'admin', label: 'Admin' },
    { value: 'user', label: 'User' }
  ];

  constructor(public postsService: PostsService, public snackBar: MatSnackBar, public dialog: MatDialog,
    private dialogRef: MatDialogRef<ModifyUsersComponent>) { }

  ngOnInit() {
    this.getArray();
    this.getRoles();
  }

  /** The users the search leaves, which is what the pages are over. */
  get visibleUsers(): User[] {
    const text = this.filter.trim().toLowerCase();
    const users = this.users ?? [];
    if (!text) return users;
    return users.filter(user => [user.name, user.role]
      .some(field => typeof field === 'string' && field.toLowerCase().includes(text)));
  }

  get pageUsers(): User[] {
    const start = this.pageIndex * this.pageSize;
    return this.visibleUsers.slice(start, start + this.pageSize);
  }

  get pageCount(): number {
    return Math.max(1, Math.ceil(this.visibleUsers.length / this.pageSize));
  }

  get rangeStart(): number {
    return this.visibleUsers.length === 0 ? 0 : this.pageIndex * this.pageSize + 1;
  }

  get rangeEnd(): number {
    return Math.min(this.visibleUsers.length, (this.pageIndex + 1) * this.pageSize);
  }

  filterChanged(text: string): void {
    this.filter = text;
    this.pageIndex = 0;
  }

  goToPage(page_index: number): void {
    this.pageIndex = Math.min(Math.max(0, page_index), this.pageCount - 1);
  }

  private getArray() {
    this.postsService.getUsers().subscribe(res => {
      this.users = res['users'];
      this.createAndSortData();
    });
  }

  getRoles() {
    this.postsService.getRoles().subscribe(res => {
      this.roles = res['roles'];
    });
  }

  openAddUserDialog() {
    const dialogRef = this.dialog.open(AddUserDialogComponent, {
      panelClass: 'kit-dialog-panel',
      width: '440px',
      maxWidth: 'calc(100vw - 32px)',
      autoFocus: 'dialog'
    });
    dialogRef.afterClosed().subscribe(user => {
      if (user && !user.error) {
        this.openSnackBar('Successfully added user ' + user.name);
        this.getArray();
      } else if (user && user.error) {
        this.openSnackBar('Failed to add user');
      }
    });
  }

  finishEditing(user_uid: string) {
    if (this.constructedObject && this.constructedObject['name'] && this.constructedObject['role']) {
      if (!isEmptyOrSpaces(this.constructedObject['name']) && !isEmptyOrSpaces(this.constructedObject['role'])) {
        const index_of_object = this.indexOfUser(user_uid);
        this.users[index_of_object] = this.constructedObject;
        this.constructedObject = {};
        this.editObject = null;
        this.setUser(this.users[index_of_object]);
        this.createAndSortData();
      }
    }
  }

  enableEditMode(user_uid: string) {
    if (this.uidInUserList(user_uid) && this.indexOfUser(user_uid) > -1) {
      const users_index = this.indexOfUser(user_uid);
      this.editObject = this.users[users_index];
      this.constructedObject['name'] = this.users[users_index].name;
      this.constructedObject['uid'] = this.users[users_index].uid;
      this.constructedObject['role'] = this.users[users_index].role;
    }
  }

  disableEditMode() {
    this.editObject = null;
  }

  // checks if user is in users array by name
  uidInUserList(user_uid: string) {
    for (let i = 0; i < this.users.length; i++) {
      if (this.users[i].uid === user_uid) {
        return true;
      }
    }
    return false;
  }

  // gets index of user in users array by name
  indexOfUser(user_uid: string) {
    for (let i = 0; i < this.users.length; i++) {
      if (this.users[i].uid === user_uid) {
        return i;
      }
    }
    return -1;
  }

  setUser(change_obj) {
    this.postsService.changeUser(change_obj).subscribe(() => {
      this.getArray();
    });
  }

  manageUser(user_uid: string) {
    const index_of_object = this.indexOfUser(user_uid);
    const user_obj = this.users[index_of_object];
    this.dialog.open(ManageUserComponent, {
      data: {
        user: user_obj
      },
      panelClass: 'kit-dialog-panel',
      width: '520px',
      maxWidth: 'calc(100vw - 32px)',
      maxHeight: 'calc(100dvh - 32px)',
      autoFocus: 'dialog'
    });
  }

  removeUser(user_uid: string) {
    this.postsService.deleteUser(user_uid).subscribe(() => {
      this.getArray();
    }, () => {
      this.getArray();
    });
  }

  createAndSortData() {
    this.users.sort((a, b) => a.name.localeCompare(b.name));
    // A page that no longer exists after a change would otherwise show nothing at all.
    this.pageIndex = Math.min(this.pageIndex, this.pageCount - 1);
  }

  openModifyRole(role) {
    const dialogRef = this.dialog.open(ManageRoleComponent, {
      data: {
        role: role
      },
      panelClass: 'kit-dialog-panel',
      width: '480px',
      maxWidth: 'calc(100vw - 32px)',
      maxHeight: 'calc(100dvh - 32px)',
      autoFocus: 'dialog'
    });

    dialogRef.afterClosed().subscribe(() => {
      this.getRoles();
    });
  }

  closeDialog() {
    this.dialogRef.close();
  }

  public openSnackBar(message: string, action = '') {
    this.snackBar.open(message, action, {
      duration: 2000,
    });
  }

}

function isEmptyOrSpaces(str){
  return str === null || str.match(/^ *$/) !== null;
}
