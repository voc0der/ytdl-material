import type { Subscription } from 'api-types';
import type { PickerOption } from '../picker/picker.component';

/** What can be chosen for a subscription, whether it is being created or edited. */
export interface SubscriptionSettings {
  maxQuality: string;
  audioOnly: boolean;
  // yt-dlp's --dateafter form, as in "now-2weeks"; null downloads every upload.
  timerange: string | null;
  paused: boolean;
  use_subfolder: boolean;
  auto_create_playlist: boolean;
  custom_args: string;
  custom_output: string;
}

export type TimerangeUnit = 'day' | 'week' | 'month' | 'year';

export const CUSTOM_TIMERANGE = 'custom';

export const QUALITY_OPTIONS: PickerOption<string>[] = [
  { value: 'best', label: $localize`Best` },
  { value: '2160', label: '4K' },
  { value: '1440', label: '1440p' },
  { value: '1080', label: '1080p' },
  { value: '720', label: '720p' },
  { value: '480', label: '480p' },
  { value: '360', label: '360p' }
];

export const TIMERANGE_OPTIONS: PickerOption<string | null>[] = [
  { value: null, label: $localize`All` },
  { value: 'now-1week', label: $localize`Last week` },
  { value: 'now-1month', label: $localize`Last month` },
  { value: 'now-3months', label: $localize`Last 3 months` },
  { value: 'now-1year', label: $localize`Last year` },
  { value: CUSTOM_TIMERANGE, label: $localize`Custom` }
];

export const TIMERANGE_UNIT_OPTIONS: PickerOption<TimerangeUnit>[] = [
  { value: 'day', label: $localize`days` },
  { value: 'week', label: $localize`weeks` },
  { value: 'month', label: $localize`months` },
  { value: 'year', label: $localize`years` }
];

export function defaultSubscriptionSettings(): SubscriptionSettings {
  return {
    maxQuality: 'best',
    audioOnly: false,
    timerange: null,
    paused: false,
    use_subfolder: true,
    auto_create_playlist: false,
    custom_args: '',
    custom_output: ''
  };
}

export function settingsFromSubscription(sub: Subscription): SubscriptionSettings {
  return {
    maxQuality: sub.maxQuality || 'best',
    audioOnly: sub.type === 'audio',
    timerange: sub.timerange || null,
    paused: sub.paused === true,
    // Both predate these settings, so a subscription without them keeps the old behaviour.
    use_subfolder: sub.use_subfolder !== false,
    auto_create_playlist: sub.auto_create_playlist === true,
    custom_args: sub.custom_args || '',
    custom_output: sub.custom_output || ''
  };
}

/**
 * The settings that differ between two versions, named as the subscription record names
 * them, so an update sends only what changed. Whether audio only is set cannot change: the
 * files already downloaded sit in the audio or the video folder.
 */
export function changedSubscriptionFields(before: SubscriptionSettings, after: SubscriptionSettings): Partial<Subscription> {
  const changes: Partial<Subscription> = {};
  if (after.maxQuality !== before.maxQuality) changes.maxQuality = after.maxQuality;
  if (after.timerange !== before.timerange) changes.timerange = after.timerange;
  if (after.paused !== before.paused) changes.paused = after.paused;
  if (after.use_subfolder !== before.use_subfolder) changes.use_subfolder = after.use_subfolder;
  if (after.auto_create_playlist !== before.auto_create_playlist) changes.auto_create_playlist = after.auto_create_playlist;
  if (after.custom_args !== before.custom_args) changes.custom_args = after.custom_args;
  if (after.custom_output !== before.custom_output) changes.custom_output = after.custom_output;
  return changes;
}

/** Reads "now-2weeks" as 2 weeks. Anything else, including no range at all, gives null. */
export function parseTimerange(timerange: string | null): { amount: number; unit: TimerangeUnit } | null {
  const match = /^now-(\d+)(day|week|month|year)s?$/.exec(timerange ?? '');
  if (!match) return null;
  return { amount: Number(match[1]), unit: match[2] as TimerangeUnit };
}

export function formatTimerange(amount: number, unit: TimerangeUnit): string | null {
  const whole_amount = Math.floor(Number(amount));
  if (!Number.isFinite(whole_amount) || whole_amount < 1) return null;
  return `now-${whole_amount}${unit}${whole_amount === 1 ? '' : 's'}`;
}

/** The preset a range is one of, or the custom choice when it is not one of them. */
export function timerangeChoice(timerange: string | null): string | null {
  if (!timerange) return null;
  return TIMERANGE_OPTIONS.some(option => option.value === timerange) ? timerange : CUSTOM_TIMERANGE;
}

export type SubscriptionState = 'unavailable' | 'paused' | 'checking' | 'downloading' | 'failed' | 'idle';

/**
 * Where a subscription is, most pressing first: a link that could not be read, paused, a
 * check under way, downloads still waiting or running, a last check that failed, or nothing
 * going on.
 */
export function subscriptionState(sub: Subscription): SubscriptionState {
  const status = sub.refresh_status;
  if (!sub.name) return sub.downloading ? 'checking' : 'unavailable';
  if (sub.paused) return 'paused';
  if (status?.active || status?.phase === 'collecting' || status?.phase === 'queueing') return 'checking';
  if ((status?.running_download_count ?? 0) > 0 || (status?.pending_download_count ?? 0) > 0) return 'downloading';
  if (sub.downloading) return 'checking';
  if (status?.phase === 'error') return 'failed';
  return 'idle';
}

/** Whether a check is under way, which can be stopped, whatever else is true of it. */
export function isSubscriptionChecking(sub: Subscription): boolean {
  const phase = sub.refresh_status?.phase;
  return !!(sub.downloading || sub.refresh_status?.active || phase === 'collecting' || phase === 'queueing');
}

/** A subscription whose state is still changing, which the pages keep polling for. */
export function isSubscriptionBusy(sub: Subscription): boolean {
  const state = subscriptionState(sub);
  return state === 'checking' || state === 'downloading';
}

export function lastCheckedAt(sub: Subscription): number | null {
  return sub.refresh_status?.completed_at ?? null;
}

const RELATIVE_TIME_STEPS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 60 * 60],
  ['month', 30 * 24 * 60 * 60],
  ['week', 7 * 24 * 60 * 60],
  ['day', 24 * 60 * 60],
  ['hour', 60 * 60],
  ['minute', 60]
];

/** "5 minutes ago", "yesterday", "just now". */
export function formatRelativeTime(timestamp: number, now = Date.now(), locale?: string): string {
  const seconds = Math.round((timestamp - now) / 1000);
  let format: Intl.RelativeTimeFormat;
  try {
    format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  } catch {
    format = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  }
  for (const [unit, unit_seconds] of RELATIVE_TIME_STEPS) {
    if (Math.abs(seconds) >= unit_seconds) {
      return format.format(Math.round(seconds / unit_seconds), unit);
    }
  }
  return $localize`just now`;
}
