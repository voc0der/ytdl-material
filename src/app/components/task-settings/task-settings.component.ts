import { ChangeDetectionStrategy, Component, EventEmitter, Input, OnChanges, Output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatSlideToggle } from '@angular/material/slide-toggle';
import { Schedule, Task, TaskType } from 'api-types';
import { PostsService } from 'app/posts.services';
import { PickerComponent, type PickerOption } from 'app/components/picker/picker.component';
import { Observable, forkJoin, of } from 'rxjs';
import { catchError } from 'rxjs/operators';

/** How often a task repeats, which is the only part of a schedule worth a choice. */
export type RepeatChoice = 'off' | 'daily' | 'weekly' | 'once';

export const REPEAT_OPTIONS: PickerOption<RepeatChoice>[] = [
  { value: 'off', label: $localize`Off` },
  { value: 'daily', label: $localize`Daily` },
  { value: 'weekly', label: $localize`Weekly` },
  { value: 'once', label: $localize`Once` }
];

// Monday first, which is what the backend's dayOfWeek 0-6 means here.
export const WEEKDAY_LABELS = [
  $localize`:Monday initial:M`,
  $localize`:Tuesday initial:T`,
  $localize`:Wednesday initial:W`,
  $localize`:Thursday initial:T`,
  $localize`:Friday initial:F`,
  $localize`:Saturday initial:S`,
  $localize`:Sunday initial:S`
];

const WEEKDAY_NAMES = [
  $localize`Monday`, $localize`Tuesday`, $localize`Wednesday`, $localize`Thursday`,
  $localize`Friday`, $localize`Saturday`, $localize`Sunday`
];

/**
 * When a task runs and how it behaves, on the task's own card rather than in a dialog. It
 * opens on what the task has now, and Save writes back only what was changed and closes.
 */
@Component({
  selector: 'app-task-settings',
  templateUrl: './task-settings.component.html',
  styleUrls: ['./task-settings.component.scss'],
  changeDetection: ChangeDetectionStrategy.Eager,
  imports: [FormsModule, MatSlideToggle, PickerComponent]
})
export class TaskSettingsComponent implements OnChanges {
  @Input() task: Task = null;
  /** Emitted once the panel is done with, whether anything was saved or not. */
  @Output() closed = new EventEmitter<void>();

  readonly repeatOptions = REPEAT_OPTIONS;
  readonly weekdayLabels = WEEKDAY_LABELS;
  readonly weekdayNames = WEEKDAY_NAMES;
  readonly repeatLabel = $localize`Repeat`;
  readonly timeLabel = $localize`Time`;
  readonly dateLabel = $localize`Date`;

  repeat: RepeatChoice = 'off';
  days_of_week: number[] = [];
  // "HH:MM", as an <input type="time"> reads and writes it.
  time = '';
  // "YYYY-MM-DD", as an <input type="date"> reads and writes it.
  date = '';
  options: Record<string, any> = {};
  saving = false;

  private saved_schedule = '';
  private saved_options = '';
  private loaded_key: TaskType = null;

  constructor(private postsService: PostsService) { }

  // The page polls, so the task object is replaced every few seconds. Re-reading on each of
  // those would wipe what is being typed, so the panel only loads when it opens on a new task.
  ngOnChanges(): void {
    if (this.task?.key === this.loaded_key) return;
    this.loaded_key = this.task?.key ?? null;
    this.readTask();
  }

  get timeZone(): string | null {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone ?? null;
    } catch {
      return null;
    }
  }

  get today(): string {
    return toDateInput(new Date());
  }

  get hasOwnOptions(): boolean {
    return this.task?.key === TaskType.DELETE_OLD_FILES;
  }

  get hasCodecOptions(): boolean {
    return this.task?.key === TaskType.CODEC_DISCOVERY;
  }

  /** Blank reads as no limit, the same as 0. */
  setMaxConversions(value: unknown): void {
    const parsed = Math.floor(Number(value));
    this.setOption('max_conversions', Number.isFinite(parsed) && parsed > 0 ? parsed : 0);
  }

  get changed(): boolean {
    return JSON.stringify(this.buildSchedule()) !== this.saved_schedule
      || JSON.stringify(this.options) !== this.saved_options;
  }

  /** A schedule is only complete once it has a time, and a date too when it runs once. */
  get incomplete(): boolean {
    if (this.repeat === 'off') return false;
    if (!this.time) return true;
    if (this.repeat === 'once' && !this.date) return true;
    return this.repeat === 'weekly' && this.days_of_week.length === 0;
  }

  chooseRepeat(repeat: RepeatChoice): void {
    this.repeat = repeat;
    // Something to start from, so a schedule is never saved half-filled.
    if (repeat !== 'off' && !this.time) this.time = '03:00';
    if (repeat === 'once' && !this.date) this.date = this.today;
    if (repeat === 'weekly' && this.days_of_week.length === 0) this.days_of_week = [0];
  }

  toggleDay(day: number): void {
    this.days_of_week = this.days_of_week.includes(day)
      ? this.days_of_week.filter(selected_day => selected_day !== day)
      : [...this.days_of_week, day].sort((day1, day2) => day1 - day2);
  }

  isDaySelected(day: number): boolean {
    return this.days_of_week.includes(day);
  }

  setOption(key: string, value: unknown): void {
    this.options = {...this.options, [key]: value};
    // Blacklisting everything already covers subscription files.
    if (key === 'blacklist_files' && value) this.options['blacklist_subscription_files'] = false;
  }

  save(): void {
    if (this.saving || !this.task || this.incomplete) return;

    const schedule = this.buildSchedule();
    const schedule_changed = JSON.stringify(schedule) !== this.saved_schedule;
    const options_changed = JSON.stringify(this.options) !== this.saved_options;
    if (!schedule_changed && !options_changed) {
      this.closed.emit();
      return;
    }

    this.saving = true;
    const requests: Observable<unknown>[] = [];
    if (schedule_changed) {
      requests.push(this.postsService.updateTaskSchedule(this.task.key, schedule).pipe(catchError(() => of({success: false}))));
    }
    if (options_changed) {
      requests.push(this.postsService.updateTaskOptions(this.task.key, this.options).pipe(catchError(() => of({success: false}))));
    }

    forkJoin(requests).subscribe(results => {
      this.saving = false;
      if (results.some(result => !result || !result['success'])) {
        this.postsService.openSnackBar($localize`Couldn't save the task settings.`);
        return;
      }
      this.closed.emit();
    });
  }

  cancel(): void {
    this.readTask();
    this.closed.emit();
  }

  private readTask(): void {
    this.options = JSON.parse(JSON.stringify(this.task?.options ?? {}));
    this.readSchedule(this.task?.schedule);
    this.saved_schedule = JSON.stringify(this.buildSchedule());
    this.saved_options = JSON.stringify(this.options);
  }

  private readSchedule(schedule: Schedule): void {
    if (!schedule) {
      this.repeat = 'off';
      this.days_of_week = [];
      this.time = '';
      this.date = '';
      return;
    }

    if (schedule.type === Schedule.type.RECURRING) {
      this.time = toTimeInput(schedule.data?.hour ?? 0, schedule.data?.minute ?? 0);
      this.days_of_week = Array.isArray(schedule.data?.dayOfWeek) ? [...schedule.data.dayOfWeek] : [];
      this.repeat = this.days_of_week.length > 0 ? 'weekly' : 'daily';
      this.date = '';
      return;
    }

    const scheduled_at = new Date(schedule.data?.timestamp);
    this.repeat = 'once';
    this.days_of_week = [];
    this.time = toTimeInput(scheduled_at.getHours(), scheduled_at.getMinutes());
    this.date = toDateInput(scheduled_at);
  }

  private buildSchedule(): Schedule | null {
    if (this.repeat === 'off' || this.incomplete) return null;

    const [hours, minutes] = this.time.split(':').map(part => parseInt(part, 10));
    const time_zone = this.timeZone;

    if (this.repeat === 'once') {
      const [year, month, day] = this.date.split('-').map(part => parseInt(part, 10));
      const scheduled_at = new Date(year, month - 1, day, hours, minutes, 0, 0);
      return {type: Schedule.type.TIMESTAMP, data: {timestamp: scheduled_at.getTime(), tz: time_zone}};
    }

    const data: Schedule['data'] = {hour: hours, minute: minutes, tz: time_zone};
    if (this.repeat === 'weekly') data.dayOfWeek = [...this.days_of_week];
    return {type: Schedule.type.RECURRING, data: data};
  }
}

function toTimeInput(hours: number, minutes: number): string {
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function toDateInput(date: Date): string {
  if (!date || Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
