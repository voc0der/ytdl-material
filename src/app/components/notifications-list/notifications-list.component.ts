import { Component, EventEmitter, Input, Output, ChangeDetectionStrategy } from '@angular/core';
import { Notification } from 'api-types';
import { NotificationAction } from 'api-types/models/NotificationAction';
import { NotificationType } from 'api-types/models/NotificationType';
import { CdkVirtualScrollViewport, CdkFixedSizeVirtualScroll, CdkVirtualForOf } from '@angular/cdk/scrolling';
import { MatTooltip } from '@angular/material/tooltip';
import { MatIcon } from '@angular/material/icon';
import { DatePipe } from '@angular/common';

// Every row is this tall, because a virtualized list has to know before it renders one.
// Kept beside the styles that produce it -- and the panel sizes itself from it too.
export const NOTIFICATION_ROW_HEIGHT = 88;

@Component({
    selector: 'app-notifications-list',
    templateUrl: './notifications-list.component.html',
    styleUrls: ['./notifications-list.component.scss'],
    changeDetection: ChangeDetectionStrategy.Eager,
    imports: [CdkVirtualScrollViewport, CdkFixedSizeVirtualScroll, CdkVirtualForOf, MatTooltip, MatIcon, DatePipe]
})
export class NotificationsListComponent {
  @Input() notifications = null;

  readonly rowHeight = NOTIFICATION_ROW_HEIGHT;
  readonly removeLabel = $localize`:Remove notification button:Remove`;
  readonly unreadLabel = $localize`:Unread notification marker:Unread`;

  @Output() deleteNotification = new EventEmitter<string>();
  @Output() notificationAction = new EventEmitter<{notification: Notification, action: NotificationAction}>();

  NOTIFICATION_PREFIX: { [key in NotificationType]: string } = {
    download_complete: $localize`Finished downloading`,
    download_error: $localize`Download failed`,
    task_finished: $localize`Task finished`
  }

  // Attaches string to the end of the notification text
  NOTIFICATION_SUFFIX_KEY: { [key in NotificationType]: string } = {
    download_complete: 'file_title',
    download_error: 'download_url',
    task_finished: 'task_title'
  }

  NOTIFICATION_ACTION_TO_STRING: { [key in NotificationAction]: string } = {
    play: $localize`Play`,
    retry_download: $localize`Retry download`,
    view_download_error: $localize`View error`,
    view_tasks: $localize`View task`
  }

  NOTIFICATION_COLOR: { [key in NotificationAction]: string } = {
    play: 'primary',
    retry_download: 'primary',
    view_download_error: 'warn',
    view_tasks: 'primary'
  }

  // What kind of thing happened, next to the row rather than spelled out again in it.
  NOTIFICATION_TYPE_ICON: { [key in NotificationType]: string } = {
    download_complete: 'download_done',
    download_error: 'error_outline',
    task_finished: 'task_alt'
  }

  NOTIFICATION_ICON: { [key in NotificationAction]: string } = {
    play: 'smart_display',
    retry_download: 'restart_alt',
    view_download_error: 'warning',
    view_tasks: 'task'
  }

  emitNotificationAction(notification: Notification, action: NotificationAction): void {
    this.notificationAction.emit({notification: notification, action: action});
  }

  emitDeleteNotification(uid: string): void {
    this.deleteNotification.emit(uid);
  }
}
