import { Task, TaskType } from 'api-types';

/**
 * What each task is for, which the page needs because a key like "missing_db_records" says
 * nothing to the person deciding whether to run it. Titles come from the backend; the icon
 * and the sentence under it are ours.
 */
export const TASK_ICONS: { [key in TaskType]?: string } = {
  [TaskType.BACKUP_LOCAL_DB]: 'backup',
  [TaskType.MISSING_FILES_CHECK]: 'search_off',
  [TaskType.MISSING_DB_RECORDS]: 'playlist_add',
  [TaskType.GENERATE_MISSING_THUMBNAILS]: 'image',
  [TaskType.DUPLICATE_FILES_CHECK]: 'content_copy',
  [TaskType.YOUTUBEDL_UPDATE_CHECK]: 'system_update_alt',
  [TaskType.DELETE_OLD_FILES]: 'auto_delete',
  [TaskType.IMPORT_LEGACY_ARCHIVES]: 'unarchive',
  [TaskType.REBUILD_DATABASE]: 'construction',
  [TaskType.APPLY_CATEGORIES]: 'label',
  [TaskType.SUBSCRIPTIONS_CHECK]: 'subscriptions'
};

const TASK_DESCRIPTIONS: { [key in TaskType]?: string } = {
  [TaskType.BACKUP_LOCAL_DB]: $localize`Writes a copy of the database to appdata/db_backup, which is what Restore reads back.`,
  [TaskType.MISSING_FILES_CHECK]: $localize`Finds files the database still lists that are no longer on disk.`,
  [TaskType.MISSING_DB_RECORDS]: $localize`Finds media on disk that the database has no record of, and imports it.`,
  [TaskType.GENERATE_MISSING_THUMBNAILS]: $localize`Gives files with no cover art one, from the source where it can and from the video itself otherwise.`,
  [TaskType.DUPLICATE_FILES_CHECK]: $localize`Finds more than one database record pointing at the same file.`,
  [TaskType.YOUTUBEDL_UPDATE_CHECK]: $localize`Checks whether a newer release of the downloader is available.`,
  [TaskType.DELETE_OLD_FILES]: $localize`Deletes downloads older than the age set in its options.`,
  [TaskType.IMPORT_LEGACY_ARCHIVES]: $localize`Imports archive files written before 4.3 into the database.`,
  [TaskType.REBUILD_DATABASE]: $localize`Reimports every user, subscription and file it can find. Backs the database up first.`,
  [TaskType.APPLY_CATEGORIES]: $localize`Sorts files that were downloaded before your category rules existed.`,
  [TaskType.SUBSCRIPTIONS_CHECK]: $localize`Checks every subscription for new uploads and queues whatever it finds.`
};

export function taskIcon(task: Task): string {
  return TASK_ICONS[task?.key] ?? 'settings_suggest';
}

export function taskDescription(task: Task): string {
  return TASK_DESCRIPTIONS[task?.key] ?? '';
}

export type TaskState = 'running' | 'failed' | 'pending' | 'scheduled' | 'idle';

export function taskState(task: Task): TaskState {
  if (!task) return 'idle';
  if (task.running || task.confirming) return 'running';
  if (task.error) return 'failed';
  if (hasPendingWork(task)) return 'pending';
  if (task.schedule) return 'scheduled';
  return 'idle';
}

/** How many things the last run turned up, or null when the result is not a count. */
export function pendingCount(task: Task): number | null {
  const data = task?.data;
  if (!data) return null;
  if (Array.isArray(data['uids'])) return data['uids'].length;
  if (Array.isArray(data['files_to_remove'])) return data['files_to_remove'].length;
  return null;
}

/** A run that found nothing leaves an empty result behind; there is nothing to confirm then. */
export function hasPendingWork(task: Task): boolean {
  if (!task?.data) return false;
  const count = pendingCount(task);
  return count === null || count > 0;
}

/** What the button that acts on the last run's findings says. */
export function confirmLabel(task: Task): string {
  const count = pendingCount(task);
  switch (task?.key) {
    case TaskType.MISSING_FILES_CHECK:
      return $localize`Remove ${count}:count: from the database`;
    case TaskType.DUPLICATE_FILES_CHECK:
      return count === 1 ? $localize`Remove 1 duplicate` : $localize`Remove ${count}:count: duplicates`;
    case TaskType.DELETE_OLD_FILES:
      return count === 1 ? $localize`Delete 1 file` : $localize`Delete ${count}:count: files`;
    case TaskType.YOUTUBEDL_UPDATE_CHECK:
      return $localize`Update to ${task.data}:version:`;
    default:
      return count === null ? $localize`Apply` : $localize`Apply to ${count}:count:`;
  }
}
