import { fakeAsync, tick } from '@angular/core/testing';
import { BehaviorSubject, of, throwError } from 'rxjs';
import { Schedule, Task, TaskType } from 'api-types';

import { TasksComponent } from './tasks.component';
import { RestoreDbDialogComponent } from 'app/dialogs/restore-db-dialog/restore-db-dialog.component';

describe('TasksComponent', () => {
  let component: TasksComponent;
  let postsService: any;
  let dialog: any;
  let clipboard: any;

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
      dismissTaskError: vi.fn().mockName('dismissTaskError').mockReturnValue(of({ success: true })),
      openSnackBar: vi.fn().mockName('openSnackBar')
    };
    dialog = { open: vi.fn().mockName('open').mockReturnValue({ afterClosed: () => of(true) }) };
    clipboard = { copy: vi.fn().mockName('copy').mockReturnValue(true) };
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    component = new TasksComponent(postsService, dialog, clipboard);
  });

  afterEach(() => {
    component.ngOnDestroy();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('waits for the app to be ready before asking for the tasks', () => {
    const ready = new BehaviorSubject(false);
    postsService.initialized = false;
    postsService.service_initialized = ready;

    component.ngOnInit();
    expect(postsService.getTasks).not.toHaveBeenCalled();

    ready.next(true);
    expect(postsService.getTasks).toHaveBeenCalledTimes(1);
  });

  it('stops waiting for the app once it is gone', () => {
    const ready = new BehaviorSubject(false);
    postsService.initialized = false;
    postsService.service_initialized = ready;

    component.ngOnInit();
    component.ngOnDestroy();
    ready.next(true);

    expect(postsService.getTasks).not.toHaveBeenCalled();
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
    expect(component.statusText(task({ error: 'boom' }))).toBe('Last run failed');
    expect(component.statusText(task())).toBe('Never run');
  });

  it('says how long ago a failure was, since it stays until the next run', () => {
    const failed = task({ error: 'boom', last_ran: (Date.now() - 60 * 86400_000) / 1000 });

    expect(component.statusText(failed)).toMatch(/^Failed .*ago$/);
  });

  it('clears a dismissed error and reloads straight away', () => {
    listReturns(task({ error: 'boom', last_ran: 1 }));
    component.ngOnInit();
    expect(postsService.getTasks).toHaveBeenCalledTimes(1);

    component.dismissError(task({ error: 'boom', last_ran: 1 }));

    expect(postsService.dismissTaskError).toHaveBeenCalledWith(TaskType.BACKUP_LOCAL_DB);
    expect(postsService.getTasks).toHaveBeenCalledTimes(2);
    expect(postsService.openSnackBar).not.toHaveBeenCalled();
  });

  it('says so when an error could not be dismissed', () => {
    postsService.dismissTaskError.mockReturnValue(of({ success: false }));

    component.dismissError(task({ error: 'boom' }));

    expect(postsService.openSnackBar).toHaveBeenCalledWith("Couldn't dismiss the error.");
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

  it('says so when a run could not be started', () => {
    postsService.runTask.mockReturnValueOnce(of({ success: false }));
    component.runTask(TaskType.BACKUP_LOCAL_DB);
    expect(postsService.openSnackBar).toHaveBeenLastCalledWith('Failed to run task!');

    postsService.openSnackBar.mockClear();
    postsService.runTask.mockReturnValueOnce(throwError(() => new Error('offline')));
    component.runTask(TaskType.BACKUP_LOCAL_DB);
    expect(postsService.openSnackBar).toHaveBeenLastCalledWith('Failed to run task!');
  });

  it('does not rebuild the database when that is called off', () => {
    dialog.open.mockReturnValue({ afterClosed: () => of(false) });

    component.runTask(TaskType.REBUILD_DATABASE);

    expect(postsService.runTask).not.toHaveBeenCalled();
  });

  it('acts on what a run found, and reloads straight away', () => {
    listReturns(task({ key: TaskType.MISSING_FILES_CHECK, data: { uids: ['a'] } }));
    component.ngOnInit();

    component.confirmTask(TaskType.MISSING_FILES_CHECK);

    expect(postsService.confirmTask).toHaveBeenCalledWith(TaskType.MISSING_FILES_CHECK);
    expect(postsService.getTasks).toHaveBeenCalledTimes(2);
    expect(postsService.openSnackBar).not.toHaveBeenCalled();
  });

  it('says so when what a run found could not be acted on', () => {
    postsService.confirmTask.mockReturnValueOnce(of({ success: false }));
    component.confirmTask(TaskType.MISSING_FILES_CHECK);
    expect(postsService.openSnackBar).toHaveBeenLastCalledWith('Failed to confirm task!');

    postsService.openSnackBar.mockClear();
    postsService.confirmTask.mockReturnValueOnce(throwError(() => new Error('offline')));
    component.confirmTask(TaskType.MISSING_FILES_CHECK);
    expect(postsService.openSnackBar).toHaveBeenLastCalledWith('Failed to confirm task!');
  });

  it('opens the backups to restore from', () => {
    component.openRestoreDBBackupDialog();

    expect(dialog.open).toHaveBeenCalledWith(RestoreDbDialogComponent, expect.objectContaining({ autoFocus: 'dialog' }));
  });

  it('resets the tasks once that is confirmed, closing any open settings', () => {
    component.toggleSettings(task());

    component.resetTasks();

    expect(dialog.open.mock.lastCall[1].data.warnSubmitColor).toBe(true);
    expect(postsService.resetTasks).toHaveBeenCalledTimes(1);
    expect(postsService.openSnackBar).toHaveBeenCalledWith('Tasks successfully reset!');
    expect(component.open_settings_key).toBeNull();
    expect(postsService.getTasks).toHaveBeenCalledTimes(1);
  });

  it('leaves the tasks alone when a reset is called off', () => {
    dialog.open.mockReturnValue({ afterClosed: () => of(false) });

    component.resetTasks();

    expect(postsService.resetTasks).not.toHaveBeenCalled();
  });

  it('says so when the tasks could not be reset', () => {
    postsService.resetTasks.mockReturnValueOnce(of({ success: false }));
    component.resetTasks();
    expect(postsService.openSnackBar).toHaveBeenLastCalledWith('Failed to reset tasks!');

    postsService.openSnackBar.mockClear();
    postsService.resetTasks.mockReturnValueOnce(throwError(() => new Error('offline')));
    component.resetTasks();
    expect(postsService.openSnackBar).toHaveBeenLastCalledWith('Failed to reset tasks!');
  });

  it('says so when dismissing an error failed outright', () => {
    postsService.dismissTaskError.mockReturnValue(throwError(() => new Error('offline')));

    component.dismissError(task({ error: 'boom' }));

    expect(postsService.openSnackBar).toHaveBeenCalledWith("Couldn't dismiss the error.");
  });

  it('shows the whole of an error, and copies it when asked', () => {
    const failed = task({ title: 'Backup DB', error: 'Disk full\n    at write (db.js:1)' });

    component.showError(failed);

    const { data } = dialog.open.mock.lastCall[1];
    expect(data.dialogTitle).toBe('Error for: Backup DB');
    expect(data.dialogText).toBe(failed.error);
    expect(clipboard.copy).not.toHaveBeenCalled();

    data.doneEmitter.emit(true);

    expect(clipboard.copy).toHaveBeenCalledWith(failed.error);
    expect(postsService.openSnackBar).toHaveBeenCalledWith('Copied to clipboard!');
  });

  it('sums an error up by its first line', () => {
    expect(component.errorSummary(task({ error: '\n  Disk full\n    at write (db.js:1)' }))).toBe('Disk full');
    expect(component.errorSummary(task({ error: '   ' }))).toBe('Something went wrong.');
    expect(component.errorSummary(task({ error: { code: 'EIO' } as any }))).toBe('Something went wrong.');
  });

  it('describes each task, and counts what it found', () => {
    const found = task({ key: TaskType.DELETE_OLD_FILES, data: { files_to_remove: [{ uid: 'a' }, { uid: 'b' }] } });

    expect(component.icon(found)).toBe('auto_delete');
    expect(component.description(found)).toContain('older than');
    expect(component.pendingCount(found)).toBe(2);
    expect(component.confirmLabel(found)).toBe('Delete 2 files');
  });
});
