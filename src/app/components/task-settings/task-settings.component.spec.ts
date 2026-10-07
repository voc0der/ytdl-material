import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { Schedule, Task, TaskType } from 'api-types';

import { TaskSettingsComponent } from './task-settings.component';
import { PostsService } from 'app/posts.services';
import { configureTestBed } from '../../../testing/test-bed';

describe('TaskSettingsComponent', () => {
  let component: TaskSettingsComponent;
  let fixture: ComponentFixture<TaskSettingsComponent>;
  let postsService: any;

  const task = (overrides: Partial<Task> = {}): Task => ({
    key: TaskType.BACKUP_LOCAL_DB,
    title: 'Backup DB',
    last_ran: 0,
    last_confirmed: 0,
    running: false,
    confirming: false,
    data: null,
    error: null,
    schedule: null,
    ...overrides
  });

  // The panel lives inside an @if, so opening it on a task builds a new one every time.
  const openOn = (value: Task) => {
    fixture = TestBed.createComponent(TaskSettingsComponent);
    component = fixture.componentInstance;
    component.task = value;
    component.ngOnChanges();
    fixture.detectChanges();
  };

  const saveButton = (): HTMLButtonElement => [...fixture.nativeElement.querySelectorAll('button')]
    .find((button: HTMLButtonElement) => button.textContent.trim() === 'Save');

  beforeEach(async () => {
    postsService = {
      updateTaskSchedule: vi.fn().mockName('updateTaskSchedule').mockReturnValue(of({ success: true })),
      updateTaskOptions: vi.fn().mockName('updateTaskOptions').mockReturnValue(of({ success: true })),
      openSnackBar: vi.fn().mockName('openSnackBar')
    };

    await configureTestBed({
      imports: [TaskSettingsComponent],
      providers: [{ provide: PostsService, useValue: postsService }]
    }).compileComponents();

    fixture = TestBed.createComponent(TaskSettingsComponent);
    component = fixture.componentInstance;
    openOn(task());
  });

  it('opens on a task that has no schedule with nothing to save', () => {
    expect(component.repeat).toBe('off');
    expect(component.changed).toBe(false);
  });

  it('reads a daily schedule, padding the time out for the field', () => {
    openOn(task({ schedule: { type: Schedule.type.RECURRING, data: { hour: 3, minute: 5 } } }));

    expect(component.repeat).toBe('daily');
    expect(component.time).toBe('03:05');
    expect(component.changed).toBe(false);
  });

  it('reads a weekly schedule as its days', () => {
    openOn(task({ schedule: { type: Schedule.type.RECURRING, data: { hour: 12, minute: 0, dayOfWeek: [0, 4] } } }));

    expect(component.repeat).toBe('weekly');
    expect(component.days_of_week).toEqual([0, 4]);
    expect(component.isDaySelected(4)).toBe(true);
  });

  it('will not save a schedule that has no day picked yet', () => {
    component.chooseRepeat('weekly');
    component.days_of_week = [];

    expect(component.incomplete).toBe(true);

    component.save();

    expect(postsService.updateTaskSchedule).not.toHaveBeenCalled();
  });

  it('starts a new schedule off with a time so it can be saved straight away', () => {
    component.chooseRepeat('daily');

    expect(component.time).toBe('03:00');
    expect(component.incomplete).toBe(false);
    expect(component.changed).toBe(true);
  });

  it('saves the schedule and closes', () => {
    const closed = vi.fn();
    component.closed.subscribe(closed);

    component.chooseRepeat('daily');
    component.time = '07:30';
    component.save();

    expect(postsService.updateTaskSchedule).toHaveBeenCalledTimes(1);
    const [key, schedule] = postsService.updateTaskSchedule.mock.lastCall;
    expect(key).toBe(TaskType.BACKUP_LOCAL_DB);
    expect(schedule.type).toBe(Schedule.type.RECURRING);
    expect(schedule.data.hour).toBe(7);
    expect(schedule.data.minute).toBe(30);
    expect(closed).toHaveBeenCalled();
  });

  describe('a single run', () => {
    // Only the clock, so the change detection the panel runs on keeps its real timers.
    const at = (hours: number, minutes = 0) => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(2026, 9, 3, hours, minutes));
    };

    afterEach(() => {
      vi.useRealTimers();
    });

    it("starts on tomorrow's 03:00 once today's has gone by", () => {
      // It started on today's, which for most of the day was already past and never ran.
      at(10);

      component.chooseRepeat('once');

      expect(component.time).toBe('03:00');
      expect(component.date).toBe('2026-10-04');
      expect(component.alreadyPassed).toBe(false);
    });

    it("starts on today's 03:00 while that is still to come", () => {
      at(1, 30);

      component.chooseRepeat('once');

      expect(component.date).toBe('2026-10-03');
    });

    it('will not save a time that has already gone by', () => {
      at(10);
      component.chooseRepeat('once');
      component.date = '2026-10-03';
      component.time = '09:00';
      fixture.detectChanges();

      expect(component.alreadyPassed).toBe(true);
      expect(saveButton().disabled).toBe(true);
      expect(fixture.nativeElement.querySelector('.hint-invalid').textContent).toContain('already gone by');
      component.save();
      expect(postsService.updateTaskSchedule).not.toHaveBeenCalled();

      component.time = '11:00';
      component.save();

      expect(postsService.updateTaskSchedule).toHaveBeenCalledWith(TaskType.BACKUP_LOCAL_DB, {
        type: Schedule.type.TIMESTAMP,
        data: { timestamp: new Date(2026, 9, 3, 11, 0).getTime(), tz: component.timeZone }
      });
    });

    it('reads a single run back as its date and time', () => {
      at(10);

      openOn(task({ schedule: { type: Schedule.type.TIMESTAMP, data: { timestamp: new Date(2026, 9, 5, 6, 45).getTime() } } }));

      expect(component.repeat).toBe('once');
      expect(component.date).toBe('2026-10-05');
      expect(component.time).toBe('06:45');
      expect(component.changed).toBe(false);
    });
  });

  it('turns a schedule off by saving none at all', () => {
    openOn(task({ schedule: { type: Schedule.type.RECURRING, data: { hour: 3, minute: 0 } } }));

    component.chooseRepeat('off');
    component.save();

    expect(postsService.updateTaskSchedule).toHaveBeenCalledWith(TaskType.BACKUP_LOCAL_DB, null);
  });

  it('sends only the options when only they changed', () => {
    component.setOption('auto_confirm', true);
    component.save();

    expect(postsService.updateTaskOptions).toHaveBeenCalledWith(TaskType.BACKUP_LOCAL_DB, { auto_confirm: true });
    expect(postsService.updateTaskSchedule).not.toHaveBeenCalled();
  });

  it('stays on subscription files only when everything it deletes is blacklisted', () => {
    // Blacklisting everything used to switch this off, and with it the task went back to
    // deleting old files from the whole library.
    openOn(task({ key: TaskType.DELETE_OLD_FILES, options: { blacklist_subscription_files: true } }));

    component.setOption('blacklist_files', true);
    fixture.detectChanges();

    expect(component.options['blacklist_subscription_files']).toBe(true);
    const toggle: HTMLButtonElement = fixture.nativeElement.querySelector('button[role="switch"][name="subscriptionFilesOnly"]');
    expect(toggle.disabled).toBe(false);
  });

  it('will not save an age to delete files after that is not more than zero days', () => {
    // A negative age put the cutoff in the future, and every file in the library is older.
    openOn(task({ key: TaskType.DELETE_OLD_FILES, options: { threshold_days: '' } }));
    expect(component.thresholdInvalid).toBe(false);

    component.setOption('threshold_days', -30);
    fixture.detectChanges();

    expect(component.thresholdInvalid).toBe(true);
    expect(saveButton().disabled).toBe(true);
    expect(fixture.nativeElement.querySelector('.hint-invalid').textContent).toContain('more than zero days');
    component.save();
    expect(postsService.updateTaskOptions).not.toHaveBeenCalled();

    component.setOption('threshold_days', 0);
    expect(component.thresholdInvalid).toBe(true);

    component.setOption('threshold_days', 30);
    fixture.detectChanges();
    expect(saveButton().disabled).toBe(false);
    component.save();
    expect(postsService.updateTaskOptions).toHaveBeenCalledWith(TaskType.DELETE_OLD_FILES, { threshold_days: 30 });
  });

  it('offers its own options only to the task that has them', () => {
    expect(component.hasOwnOptions).toBe(false);

    openOn(task({ key: TaskType.DELETE_OLD_FILES }));

    expect(component.hasOwnOptions).toBe(true);
  });

  it('offers the conversion options only to codec discovery, and saves a blank limit as none', () => {
    expect(component.hasCodecOptions).toBe(false);

    openOn(task({ key: TaskType.CODEC_DISCOVERY, options: { auto_confirm: false, convert_to_preferred: true, max_conversions: 0 } }));
    expect(component.hasCodecOptions).toBe(true);
    expect(component.hasOwnOptions).toBe(false);

    component.setMaxConversions('');
    expect(component.changed).toBe(false);

    component.setMaxConversions('5');
    component.setOption('convert_to_preferred', false);
    component.save();

    expect(postsService.updateTaskOptions).toHaveBeenCalledWith(TaskType.CODEC_DISCOVERY, {
      auto_confirm: false, convert_to_preferred: false, max_conversions: 5
    });
  });

  it('keeps what is being typed while the page polls', () => {
    component.chooseRepeat('daily');
    component.time = '09:15';

    // The same task arrives again from the next poll.
    component.task = task({ last_ran: 1 });
    component.ngOnChanges();

    expect(component.time).toBe('09:15');
    expect(component.repeat).toBe('daily');
  });

  it('picks days for a weekly schedule in order, and lets go of one picked again', () => {
    component.chooseRepeat('weekly');
    expect(component.days_of_week).toEqual([0]);

    component.toggleDay(4);
    component.toggleDay(2);
    expect(component.days_of_week).toEqual([0, 2, 4]);

    component.toggleDay(0);
    expect(component.days_of_week).toEqual([2, 4]);
    expect(component.isDaySelected(0)).toBe(false);
  });

  it('just closes when saved with nothing changed', () => {
    const closed = vi.fn();
    component.closed.subscribe(closed);

    component.save();

    expect(postsService.updateTaskSchedule).not.toHaveBeenCalled();
    expect(postsService.updateTaskOptions).not.toHaveBeenCalled();
    expect(closed).toHaveBeenCalled();
  });

  it('stays open and says so when the settings could not be saved', () => {
    // The server turns down a schedule that could never run.
    const closed = vi.fn();
    component.closed.subscribe(closed);
    postsService.updateTaskSchedule.mockReturnValue(of({ success: false }));

    component.chooseRepeat('daily');
    component.save();

    expect(component.saving).toBe(false);
    expect(postsService.openSnackBar).toHaveBeenCalledWith("Couldn't save the task settings.");
    expect(closed).not.toHaveBeenCalled();

    postsService.openSnackBar.mockClear();
    postsService.updateTaskSchedule.mockReturnValue(throwError(() => new Error('offline')));
    component.save();

    expect(postsService.openSnackBar).toHaveBeenCalledWith("Couldn't save the task settings.");
    expect(closed).not.toHaveBeenCalled();
  });

  it('saves a schedule without a timezone when the browser cannot name its own', () => {
    vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(() => { throw new RangeError('no timezone data'); });

    try {
      expect(component.timeZone).toBeNull();
      component.chooseRepeat('daily');
      component.save();

      expect(postsService.updateTaskSchedule.mock.lastCall[1].data.tz).toBeNull();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('closes without saving when cancelled', () => {
    const closed = vi.fn();
    component.closed.subscribe(closed);

    component.chooseRepeat('daily');
    component.cancel();

    expect(postsService.updateTaskSchedule).not.toHaveBeenCalled();
    expect(component.repeat).toBe('off');
    expect(closed).toHaveBeenCalled();
  });
});
