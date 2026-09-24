import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
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

  it('drops the subscription-only blacklist once everything is blacklisted', () => {
    openOn(task({ key: TaskType.DELETE_OLD_FILES, options: { blacklist_subscription_files: true } }));

    component.setOption('blacklist_files', true);

    expect(component.options['blacklist_subscription_files']).toBe(false);
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
