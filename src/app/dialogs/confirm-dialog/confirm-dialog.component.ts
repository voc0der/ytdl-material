import { Component, Inject, EventEmitter, ChangeDetectionStrategy } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialog, MatDialogRef, MatDialogTitle, MatDialogContent, MatDialogActions, MatDialogClose } from '@angular/material/dialog';
import { CdkScrollable } from '@angular/cdk/scrolling';
import { MatIcon } from '@angular/material/icon';
import { MatProgressSpinner } from '@angular/material/progress-spinner';

export interface ConfirmDialogAction {
  text: string;
  value: boolean | string;
  warnSubmitColor?: boolean;
}

export interface ConfirmDialogData {
  dialogType?: 'text' | 'selection_list';
  dialogTitle?: string;
  dialogText?: string;
  // Overrides the icon the question is headed with, which otherwise follows warnSubmitColor.
  dialogIcon?: string;
  submitText?: string;
  submitActions?: ConfirmDialogAction[];
  cancelText?: string;
  warnSubmitColor?: boolean;
  closeOnSubmit?: boolean;
  list?: { key: string, title: string }[];
  doneEmitter?: EventEmitter<boolean | string>;
}

/**
 * Opens the confirmation with the surface and size every dialog in the app shares. Callers go
 * through this rather than MatDialog.open so that a new confirmation cannot be the one that
 * looks different.
 */
export function openConfirmDialog(dialog: MatDialog, data: ConfirmDialogData): MatDialogRef<ConfirmDialogComponent, boolean | string> {
  return dialog.open(ConfirmDialogComponent, {
    data,
    panelClass: 'kit-dialog-panel',
    width: '480px',
    maxWidth: 'calc(100vw - 32px)',
    maxHeight: 'calc(100dvh - 32px)',
    autoFocus: 'dialog'
  });
}

@Component({
    selector: 'app-confirm-dialog',
    templateUrl: './confirm-dialog.component.html',
    styleUrls: ['./confirm-dialog.component.scss'],
    changeDetection: ChangeDetectionStrategy.Eager,
    host: { class: 'kit-dialog' },
    imports: [MatDialogTitle, CdkScrollable, MatDialogContent, MatIcon, MatDialogActions, MatProgressSpinner, MatDialogClose]
})
export class ConfirmDialogComponent {

  dialogType = 'text';
  dialogTitle = 'Confirm';
  dialogText = 'Would you like to confirm?';
  submitText = 'Yes'
  cancelText = $localize`Cancel`;
  submitActions: ConfirmDialogAction[] = [];
  list: { key: string, title: string }[] = [];
  selected_items: string[] = [];
  submitClicked = false;
  closeOnSubmit = true;

  doneEmitter: EventEmitter<boolean | string> = null;
  onlyEmitOnDone = false;

  warnSubmitColor = false;
  dialogIcon: string;

  constructor(@Inject(MAT_DIALOG_DATA) public data: ConfirmDialogData, public dialogRef: MatDialogRef<ConfirmDialogComponent>) {
    if (this.data.dialogTitle     !== undefined) { this.dialogTitle     = this.data.dialogTitle }
    if (this.data.dialogType      !== undefined) { this.dialogType      = this.data.dialogType  }
    if (this.data.dialogText      !== undefined) { this.dialogText      = this.data.dialogText }
    if (this.data.list            !== undefined) { this.list            = this.data.list }
    if (this.data.submitText      !== undefined) { this.submitText      = this.data.submitText }
    if (this.data.submitActions   !== undefined) { this.submitActions   = this.data.submitActions }
    if (this.data.cancelText      !== undefined) { this.cancelText      = this.data.cancelText }
    if (this.data.warnSubmitColor !== undefined) { this.warnSubmitColor = this.data.warnSubmitColor }
    if (this.data.closeOnSubmit   !== undefined) { this.closeOnSubmit   = this.data.closeOnSubmit }

    this.dialogIcon = this.data.dialogIcon ?? (this.destructive ? 'warning' : 'help_outline');

    // checks if emitter exists, if so don't autoclose as it should be handled by caller
    if (this.data.doneEmitter) {
      this.doneEmitter = this.data.doneEmitter;
      this.onlyEmitOnDone = true;
    }
  }

  /** Whether what is being confirmed deletes or discards something, in any of its answers. */
  get destructive(): boolean {
    return this.warnSubmitColor || this.submitActions.some(action => action.warnSubmitColor);
  }

  /** A list has to have something picked in it before it can be submitted. */
  get submitDisabled(): boolean {
    return this.dialogType === 'selection_list' && this.selected_items.length === 0;
  }

  isSelected(key: string): boolean {
    return this.selected_items.includes(key);
  }

  toggleItem(key: string): void {
    this.selected_items = this.isSelected(key)
      ? this.selected_items.filter(selected => selected !== key)
      : [...this.selected_items, key];
  }

  confirmClicked(value: boolean | string = true): void {
    if (this.onlyEmitOnDone) {
      this.doneEmitter.emit(value);
      if (this.closeOnSubmit) this.submitClicked = true;
    } else {
      if (this.closeOnSubmit) this.dialogRef.close(value);
    }
  }

}
