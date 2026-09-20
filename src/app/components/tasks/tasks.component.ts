import { ChangeDetectionStrategy, Component, EventEmitter, OnDestroy, OnInit } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import { openConfirmDialog } from 'app/dialogs/confirm-dialog/confirm-dialog.component';
import { RestoreDbDialogComponent } from 'app/dialogs/restore-db-dialog/restore-db-dialog.component';
import { PostsService } from 'app/posts.services';
import { Task, TaskType } from 'api-types';
import { TaskSettingsComponent } from '../task-settings/task-settings.component';
import { Clipboard } from '@angular/cdk/clipboard';
import { Subscription } from 'rxjs';
import { filter, take } from 'rxjs/operators';
import { MatProgressSpinner } from '@angular/material/progress-spinner';
import { MatIcon } from '@angular/material/icon';
import { MatTooltip } from '@angular/material/tooltip';
import { formatRelativeTime } from 'app/utils/relative-time';
import { TaskState, confirmLabel, hasPendingWork, pendingCount, taskDescription, taskIcon, taskState } from './task-info';
import { AppDatePipe } from 'app/pipes/app-date.pipe';

// Tasks sit still most of the time; only a run is worth watching closely.
const BUSY_POLL_INTERVAL_MS = 1500;
const IDLE_POLL_INTERVAL_MS = 15000;

@Component({
    selector: 'app-tasks',
    templateUrl: './tasks.component.html',
    styleUrls: ['./tasks.component.scss'],
    changeDetection: ChangeDetectionStrategy.Eager,
    imports: [MatProgressSpinner, MatIcon, MatTooltip, TaskSettingsComponent, AppDatePipe]
})
export class TasksComponent implements OnInit, OnDestroy {

  tasks: Task[] = null;
  tasks_retrieved = false;
  load_failed = false;
  open_settings_key: TaskType = null;

  private poll_timer: number = null;
  private tasks_request: Subscription = null;
  private service_initialized_subscription: Subscription = null;
  private destroyed = false;

  TASKS_TO_REQUIRE_DIALOG: { [key in TaskType]? : {dialogTitle: string, dialogText: string, submitText: string, warnSubmitColor: boolean}} = {
    [TaskType.REBUILD_DATABASE]: {
      dialogTitle: $localize`Rebuild database`,
      dialogText: $localize`Are you sure you want to rebuild the database? All missing users, subscriptions, and files will be reimported. Note that if missing users are detected, they will be created with the password: 'password'. A backup of your current database will be created.`,
      submitText: $localize`Rebuild database`,
      warnSubmitColor: false
    }
  }

  constructor(private postsService: PostsService, private dialog: MatDialog, private clipboard: Clipboard) { }

  ngOnInit(): void {
    if (this.postsService.initialized) {
      this.getTasks();
    } else {
      this.service_initialized_subscription = this.postsService.service_initialized
        .pipe(filter(Boolean), take(1))
        .subscribe(() => {
          if (!this.destroyed) this.getTasks();
        });
    }
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    if (this.poll_timer !== null) {
      window.clearTimeout(this.poll_timer);
      this.poll_timer = null;
    }
    if (this.tasks_request) {
      this.tasks_request.unsubscribe();
      this.tasks_request = null;
    }
    if (this.service_initialized_subscription) {
      this.service_initialized_subscription.unsubscribe();
      this.service_initialized_subscription = null;
    }
  }

  getTasks(): void {
    if (this.destroyed) return;
    if (this.poll_timer !== null) {
      window.clearTimeout(this.poll_timer);
      this.poll_timer = null;
    }
    if (this.tasks_request && !this.tasks_request.closed) return;

    this.tasks_request = this.postsService.getTasks().subscribe({
      next: res => {
        this.tasks = (res['tasks'] ?? []).map(task => this.withDownloaderName(task));
        this.load_failed = false;
        this.tasks_retrieved = true;
        this.scheduleNextPoll();
      },
      error: err => {
        console.error(err);
        this.load_failed = true;
        this.tasks_retrieved = true;
        this.scheduleNextPoll();
      }
    });
  }

  private scheduleNextPoll(): void {
    this.tasks_request = null;
    if (this.destroyed) return;
    const delay = this.anyTaskBusy ? BUSY_POLL_INTERVAL_MS : IDLE_POLL_INTERVAL_MS;
    this.poll_timer = window.setTimeout(() => {
      this.poll_timer = null;
      this.getTasks();
    }, delay);
  }

  private refreshNow(): void {
    if (this.tasks_request) {
      this.tasks_request.unsubscribe();
      this.tasks_request = null;
    }
    this.getTasks();
  }

  // The backend titles the update task after the default downloader; show the one selected.
  private withDownloaderName(task: Task): Task {
    const downloader = this.postsService.config?.Advanced?.default_downloader;
    if (!downloader || !task?.title?.includes('yt-dlp')) return task;
    return {...task, title: task.title.replace('yt-dlp', downloader)};
  }

  get anyTaskBusy(): boolean {
    return !!this.tasks?.some(task => task.running || task.confirming);
  }

  // What a card says about itself.

  state(task: Task): TaskState {
    return taskState(task);
  }

  icon(task: Task): string {
    return taskIcon(task);
  }

  description(task: Task): string {
    return taskDescription(task);
  }

  hasPendingWork(task: Task): boolean {
    return hasPendingWork(task);
  }

  pendingCount(task: Task): number | null {
    return pendingCount(task);
  }

  confirmLabel(task: Task): string {
    return confirmLabel(task);
  }

  statusText(task: Task): string {
    if (task.confirming) return $localize`Applying…`;
    if (task.running) return $localize`Running…`;
    if (task.error) return $localize`Last run failed`;
    if (task.last_ran) return $localize`Ran ${formatRelativeTime(task.last_ran * 1000)}:relative time:`;
    return $localize`Never run`;
  }

  nextRunText(task: Task): string {
    if (!task.schedule) return $localize`Runs only when you run it`;
    const next_invocation = Number(task.next_invocation);
    if (!Number.isFinite(next_invocation) || next_invocation <= 0) return $localize`Scheduled`;
    return $localize`Next ${formatRelativeTime(next_invocation)}:relative time:`;
  }

  nextRunAt(task: Task): number | null {
    const next_invocation = Number(task.next_invocation);
    return Number.isFinite(next_invocation) && next_invocation > 0 ? next_invocation : null;
  }

  isRepeating(task: Task): boolean {
    return task?.schedule?.type === 'recurring';
  }

  errorSummary(task: Task): string {
    const error = typeof task?.error === 'string' ? task.error.trim() : '';
    if (!error) return $localize`Something went wrong.`;
    return error.split('\n').map(line => line.trim()).find(line => line !== '') ?? error;
  }

  // Acting on a task.

  toggleSettings(task: Task): void {
    this.open_settings_key = this.open_settings_key === task.key ? null : task.key;
  }

  closeSettings(): void {
    this.open_settings_key = null;
    this.refreshNow();
  }

  runTask(task_key: TaskType): void {
    const taskToRequireDialog = this.TASKS_TO_REQUIRE_DIALOG[task_key];
    if (taskToRequireDialog) {
      const dialogRef = openConfirmDialog(this.dialog, {
        dialogTitle: taskToRequireDialog['dialogTitle'],
        dialogText: taskToRequireDialog['dialogText'],
        submitText: taskToRequireDialog['submitText'],
        warnSubmitColor: taskToRequireDialog['warnSubmitColor']
      });
      dialogRef.afterClosed().subscribe(confirmed => {
        if (confirmed) {
          this._runTask(task_key);
        }
      });
      return;
    }

    this._runTask(task_key);
  }

  _runTask(task_key: TaskType): void {
    this.postsService.runTask(task_key).subscribe(res => {
      this.refreshNow();
      if (!res['success']) this.postsService.openSnackBar($localize`Failed to run task!`);
    }, err => {
      this.postsService.openSnackBar($localize`Failed to run task!`);
      console.error(err);
    });
  }

  confirmTask(task_key: TaskType): void {
    this.postsService.confirmTask(task_key).subscribe(res => {
      this.refreshNow();
      if (!res['success']) this.postsService.openSnackBar($localize`Failed to confirm task!`);
    }, err => {
      this.postsService.openSnackBar($localize`Failed to confirm task!`);
      console.error(err);
    });
  }

  openRestoreDBBackupDialog(): void {
    this.dialog.open(RestoreDbDialogComponent, {
      panelClass: 'kit-dialog-panel',
      width: '520px',
      maxWidth: 'calc(100vw - 32px)',
      maxHeight: 'calc(100dvh - 32px)',
      autoFocus: 'dialog'
    });
  }

  resetTasks(): void {
    const dialogRef = openConfirmDialog(this.dialog, {
      dialogTitle: $localize`Reset tasks`,
      dialogText: $localize`Would you like to reset your tasks? All your schedules will be removed as well.`,
      submitText: $localize`Reset`,
      warnSubmitColor: true
    });
    dialogRef.afterClosed().subscribe(confirmed => {
      if (confirmed) {
        this.postsService.resetTasks().subscribe(res => {
          if (res['success']) {
            this.postsService.openSnackBar($localize`Tasks successfully reset!`);
            this.open_settings_key = null;
            this.refreshNow();
          } else {
            this.postsService.openSnackBar($localize`Failed to reset tasks!`);
          }
        }, err => {
          this.postsService.openSnackBar($localize`Failed to reset tasks!`);
          console.error(err);
        });
      }
    });
  }

  showError(task: Task): void {
    const copyToClipboardEmitter = new EventEmitter<boolean>();
    openConfirmDialog(this.dialog, {
      dialogTitle: $localize`Error for: ${task['title']}`,
      dialogIcon: 'error_outline',
      dialogText: task['error'],
      submitText: $localize`Copy to clipboard`,
      cancelText: $localize`Close`,
      closeOnSubmit: false,
      doneEmitter: copyToClipboardEmitter
    });
    copyToClipboardEmitter.subscribe((done: boolean) => {
      if (done) {
        this.postsService.openSnackBar($localize`Copied to clipboard!`);
        this.clipboard.copy(task['error']);
      }
    });
  }
}
