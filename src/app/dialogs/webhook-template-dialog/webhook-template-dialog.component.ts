import { Component, Inject } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';

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
    standalone: false
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
