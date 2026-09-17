import { Task, TaskType } from 'api-types';

import { confirmLabel, hasPendingWork, pendingCount, taskDescription, taskIcon, taskState } from './task-info';

describe('task info', () => {
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

  it('describes every task the backend has', () => {
    for (const key of Object.values(TaskType)) {
      expect(taskDescription(task({ key })), key).not.toBe('');
      expect(taskIcon(task({ key })), key).not.toBe('settings_suggest');
    }
  });

  it('falls back rather than showing nothing for a task it has not heard of', () => {
    const unknown = task({ key: 'something_new' as TaskType });

    expect(taskIcon(unknown)).toBe('settings_suggest');
    expect(taskDescription(unknown)).toBe('');
  });

  it('counts findings whether they are files or records', () => {
    expect(pendingCount(task({ data: { uids: ['a'] } }))).toBe(1);
    expect(pendingCount(task({ data: { files_to_remove: [{}, {}] } }))).toBe(2);
    expect(pendingCount(task({ data: '2026.09.01' }))).toBeNull();
    expect(pendingCount(task())).toBeNull();
  });

  it('has nothing to confirm when a run found nothing', () => {
    expect(hasPendingWork(task({ data: { uids: [] } }))).toBe(false);
    expect(hasPendingWork(task({ data: { files_to_remove: [] } }))).toBe(false);
    expect(hasPendingWork(task({ data: { uids: ['a'] } }))).toBe(true);
    expect(hasPendingWork(task({ data: '2026.09.01' }))).toBe(true);
  });

  it('names what the button will do', () => {
    expect(confirmLabel(task({ key: TaskType.DUPLICATE_FILES_CHECK, data: { uids: ['a', 'b', 'c'] } }))).toBe('Remove 3 duplicates');
    expect(confirmLabel(task({ key: TaskType.DELETE_OLD_FILES, data: { files_to_remove: [{}] } }))).toBe('Delete 1 file');
    expect(confirmLabel(task({ key: TaskType.DUPLICATE_FILES_CHECK, data: { uids: ['a'] } }))).toBe('Remove 1 duplicate');
    expect(confirmLabel(task({ key: TaskType.YOUTUBEDL_UPDATE_CHECK, data: '2026.09.01' }))).toBe('Update to 2026.09.01');
    expect(confirmLabel(task({ key: TaskType.APPLY_CATEGORIES, data: true }))).toBe('Apply');
  });

  it('puts a run ahead of a failure, and a failure ahead of findings', () => {
    expect(taskState(task({ running: true, error: 'boom', data: { uids: ['a'] } }))).toBe('running');
    expect(taskState(task({ error: 'boom', data: { uids: ['a'] } }))).toBe('failed');
    expect(taskState(task({ data: { uids: ['a'] } }))).toBe('pending');
    expect(taskState(task({ schedule: { type: 'recurring', data: {} } as any }))).toBe('scheduled');
    expect(taskState(task())).toBe('idle');
  });
});
