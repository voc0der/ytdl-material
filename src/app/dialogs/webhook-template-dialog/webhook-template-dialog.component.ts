import { Component, Inject, ChangeDetectionStrategy } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialogRef, MatDialogTitle, MatDialogContent, MatDialogActions, MatDialogClose } from '@angular/material/dialog';
import { CdkScrollable } from '@angular/cdk/scrolling';
import { MatCheckbox } from '@angular/material/checkbox';
import { FormsModule } from '@angular/forms';
import { MatFormField, MatLabel, MatInput, MatHint } from '@angular/material/input';
import { MatButton } from '@angular/material/button';

export type WebhookTemplateDialogData = {
  customEnabled: boolean;
  titleTemplate: string;
  bodyTemplate: string;
};

export type WebhookTemplateDialogResult = {
  customEnabled: boolean;
  titleTemplate: string;
  bodyTemplate: string;
};

@Component({
    selector: 'app-webhook-template-dialog',
    templateUrl: './webhook-template-dialog.component.html',
    styleUrls: ['./webhook-template-dialog.component.scss'],
    changeDetection: ChangeDetectionStrategy.Eager,
    imports: [MatDialogTitle, CdkScrollable, MatDialogContent, MatCheckbox, FormsModule, MatFormField, MatLabel, MatInput, MatHint, MatDialogActions, MatButton, MatDialogClose]
})
export class WebhookTemplateDialogComponent {
  customEnabled = false;
  titleTemplate = '{{event_name}}';
  bodyTemplate = '{{event_body}}';

  readonly availableVariables = [
    '{{event_name}}',
    '{{event_type}}',
    '{{event_body}}',
    '{{video_name}}',
    '{{video_original_url}}',
    '{{task_name}}',
    '{{error_message}}',
    '{{error_type}}',
    '{{notification_url}}',
    '{{notification_thumbnail}}',
    '{{notification_uid}}',
    '{{timestamp}}'
  ];

  constructor(
    @Inject(MAT_DIALOG_DATA) public data: WebhookTemplateDialogData,
    private dialogRef: MatDialogRef<WebhookTemplateDialogComponent>
  ) {
    if (data) {
      this.customEnabled = !!data.customEnabled;
      this.titleTemplate = typeof data.titleTemplate === 'string' ? data.titleTemplate : this.titleTemplate;
      this.bodyTemplate = typeof data.bodyTemplate === 'string' ? data.bodyTemplate : this.bodyTemplate;
    }
  }

  save(): void {
    const result: WebhookTemplateDialogResult = {
      customEnabled: !!this.customEnabled,
      titleTemplate: typeof this.titleTemplate === 'string' ? this.titleTemplate : '',
      bodyTemplate: typeof this.bodyTemplate === 'string' ? this.bodyTemplate : ''
    };
    this.dialogRef.close(result);
  }
}
