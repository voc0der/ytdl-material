import { fakeAsync, tick } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { Schedule, Task, TaskType } from 'api-types';

import { TasksComponent } from './tasks.component';

describe('TasksComponent', () => {
  let component: TasksComponent;
  let postsService: any;
  let dialog: any;

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

  const listReturns = (...tasks: Task[]) => {
    postsService.getTasks.mockReturnValue(of({ tasks }));
  };

  beforeEach(() => {
    vi.useFakeTimers();
    postsService = {
      initialized: true,
      service_initialized: of(true),
      config: { Advanced: { default_downloader: 'yt-dlp' } },
      getTasks: vi.fn().mockName('getTasks').mockReturnValue(of({ tasks: [] })),
      runTask: vi.fn().mockName('runTask').mockReturnValue(of({ success: true })),
      confirmTask: vi.fn().mockName('confirmTask').mockReturnValue(of({ success: true })),
      resetTasks: vi.fn().mockName('resetTasks').mockReturnValue(of({ success: true })),
      openSnackBar: vi.fn().mockName('openSnackBar')
    };
    dialog = { open: vi.fn().mockName('open').mockReturnValue({ afterClosed: () => of(true) }) };

    component = new TasksComponent(postsService, dialog, { copy: () => true } as any);
  });

  afterEach(() => {
    component.ngOnDestroy();
    vi.useRealTimers();
  });

  it('says so when the list could not be loaded', () => {
    postsService.getTasks.mockReturnValue(throwError(() => new Error('offline')));

    component.ngOnInit();

    expect(component.tasks_retrieved).toBe(true);
    expect(component.load_failed).toBe(true);
  });

  it('watches a running task closely and an idle one from a distance', fakeAsync(() => {
    listReturns(task());
    component.ngOnInit();
    expect(postsService.getTasks).toHaveBeenCalledTimes(1);

    tick(2000);
    expect(postsService.getTasks).toHaveBeenCalledTimes(1);

    tick(13000);
    expect(postsService.getTasks).toHaveBeenCalledTimes(2);

    listReturns(task({ running: true }));
    tick(15000);
    expect(postsService.getTasks).toHaveBeenCalledTimes(3);

    tick(1500);
    expect(postsService.getTasks).toHaveBeenCalledTimes(4);
  }));

  it('stops polling once it is gone', fakeAsync(() => {
    listReturns(task());
    component.ngOnInit();

    component.ngOnDestroy();
    tick(60000);

    expect(postsService.getTasks).toHaveBeenCalledTimes(1);
  }));

  it('names the downloader the app actually uses', () => {
    postsService.config.Advanced.default_downloader = 'youtube-dl';
    listReturns(task({ key: TaskType.YOUTUBEDL_UPDATE_CHECK, title: 'Update yt-dlp' }));

    component.ngOnInit();

    expect(component.tasks[0].title).toBe('Update youtube-dl');
  });

  it('puts what a task is doing ahead of when it last ran', () => {
    expect(component.statusText(task({ running: true, last_ran: 1 }))).toBe('Running…');
    expect(component.statusText(task({ confirming: true }))).toBe('Applying…');
    expect(component.statusText(task({ error: 'boom', last_ran: 1 }))).toBe('Last run failed');
    expect(component.statusText(task())).toBe('Never run');
  });

  it('says a task without a schedule only runs by hand', () => {
    expect(component.nextRunText(task())).toBe('Runs only when you run it');
    expect(component.nextRunAt(task())).toBeNull();

    const scheduled = task({
      schedule: { type: Schedule.type.RECURRING, data: { hour: 3, minute: 0 } },
      next_invocation: Date.now() + 3600_000
    });

    expect(component.isRepeating(scheduled)).toBe(true);
    expect(component.nextRunText(scheduled)).toContain('Next');
  });

  it('offers to act only on a run that actually found something', () => {
    expect(component.hasPendingWork(task({ key: TaskType.MISSING_FILES_CHECK, data: { uids: [] } }))).toBe(false);

    const found = task({ key: TaskType.MISSING_FILES_CHECK, data: { uids: ['a', 'b'] } });

    expect(component.hasPendingWork(found)).toBe(true);
    expect(component.state(found)).toBe('pending');
    expect(component.confirmLabel(found)).toBe('Remove 2 from the database');
  });

  it('confirms before rebuilding the database, and runs everything else straight away', () => {
    component.runTask(TaskType.BACKUP_LOCAL_DB);
    expect(dialog.open).not.toHaveBeenCalled();
    expect(postsService.runTask).toHaveBeenCalledWith(TaskType.BACKUP_LOCAL_DB);

    component.runTask(TaskType.REBUILD_DATABASE);
    expect(dialog.open).toHaveBeenCalledTimes(1);
    expect(postsService.runTask).toHaveBeenCalledWith(TaskType.REBUILD_DATABASE);
  });

  it('opens the settings of one task at a time, and closes them on save', () => {
    const first = task();
    const second = task({ key: TaskType.DELETE_OLD_FILES });

    component.toggleSettings(first);
    expect(component.open_settings_key).toBe(first.key);

    component.toggleSettings(second);
    expect(component.open_settings_key).toBe(second.key);

    component.toggleSettings(second);
    expect(component.open_settings_key).toBeNull();

    component.toggleSettings(first);
    component.closeSettings();
    expect(component.open_settings_key).toBeNull();
  });

  it('reloads as soon as a run is started rather than waiting for the next poll', fakeAsync(() => {
    listReturns(task());
    component.ngOnInit();
    expect(postsService.getTasks).toHaveBeenCalledTimes(1);

    component.runTask(TaskType.BACKUP_LOCAL_DB);

    expect(postsService.getTasks).toHaveBeenCalledTimes(2);
  }));
});
