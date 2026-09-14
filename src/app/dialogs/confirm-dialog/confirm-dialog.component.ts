import { Component, OnInit, Inject, EventEmitter, ChangeDetectionStrategy } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialogRef, MatDialogTitle, MatDialogContent, MatDialogActions, MatDialogClose } from '@angular/material/dialog';
import { CdkScrollable } from '@angular/cdk/scrolling';
import { MatSelectionList, MatListOption } from '@angular/material/list';
import { FormsModule } from '@angular/forms';
import { MatButton } from '@angular/material/button';
import { MatProgressSpinner } from '@angular/material/progress-spinner';

interface ConfirmDialogAction {
  text: string;
  value: boolean | string;
  warnSubmitColor?: boolean;
}

@Component({
    selector: 'app-confirm-dialog',
    templateUrl: './confirm-dialog.component.html',
    styleUrls: ['./confirm-dialog.component.scss'],
    changeDetection: ChangeDetectionStrategy.Eager,
    imports: [MatDialogTitle, CdkScrollable, MatDialogContent, MatSelectionList, FormsModule, MatListOption, MatDialogActions, MatButton, MatProgressSpinner, MatDialogClose]
})
export class ConfirmDialogComponent implements OnInit {

  dialogType = 'text';
  dialogTitle = 'Confirm';
  dialogText = 'Would you like to confirm?';
  submitText = 'Yes'
  cancelText = $localize`Cancel`;
  submitActions: ConfirmDialogAction[] = [];
  list: { key: string, title: string }[] = [];
  selected_items = [];
  submitClicked = false;
  closeOnSubmit = true;

  doneEmitter: EventEmitter<boolean | string> = null;
  onlyEmitOnDone = false;

  warnSubmitColor = false;

  constructor(@Inject(MAT_DIALOG_DATA) public data: any, public dialogRef: MatDialogRef<ConfirmDialogComponent>) {
    if (this.data.dialogTitle     !== undefined) { this.dialogTitle     = this.data.dialogTitle }
    if (this.data.dialogType      !== undefined) { this.dialogType      = this.data.dialogType  }
    if (this.data.dialogText      !== undefined) { this.dialogText      = this.data.dialogText }
    if (this.data.list            !== undefined) { this.list            = this.data.list }
    if (this.data.submitText      !== undefined) { this.submitText      = this.data.submitText }
    if (this.data.submitActions   !== undefined) { this.submitActions   = this.data.submitActions }
    if (this.data.cancelText      !== undefined) { this.cancelText      = this.data.cancelText }
    if (this.data.warnSubmitColor !== undefined) { this.warnSubmitColor = this.data.warnSubmitColor }
    if (this.data.warnSubmitColor !== undefined) { this.warnSubmitColor = this.data.warnSubmitColor }
    if (this.data.closeOnSubmit   !== undefined) { this.closeOnSubmit   = this.data.closeOnSubmit }

    // checks if emitter exists, if so don't autoclose as it should be handled by caller
    if (this.data.doneEmitter) {
      this.doneEmitter = this.data.doneEmitter;
      this.onlyEmitOnDone = true;
    }
  }

  confirmClicked(value: boolean | string = true): void {
    if (this.onlyEmitOnDone) {
      this.doneEmitter.emit(value);
      if (this.closeOnSubmit) this.submitClicked = true;
    } else {
      if (this.closeOnSubmit) this.dialogRef.close(value);
    }
  }

  ngOnInit(): void {
  }

}
