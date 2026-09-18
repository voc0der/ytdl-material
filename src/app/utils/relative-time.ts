const RELATIVE_TIME_STEPS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 60 * 60],
  ['month', 30 * 24 * 60 * 60],
  ['week', 7 * 24 * 60 * 60],
  ['day', 24 * 60 * 60],
  ['hour', 60 * 60],
  ['minute', 60]
];

/** "5 minutes ago", "yesterday", "just now", and the same forward for something still to come. */
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

/** Relative age of a calendar date: no invented hours, and only completed units. */
export function formatRelativeDate(timestamp: number, now = Date.now(), locale?: string): string {
  const day = 24 * 60 * 60;
  const seconds = (Math.floor(timestamp / (day * 1000)) - Math.floor(now / (day * 1000))) * day;
  const options: Intl.RelativeTimeFormatOptions = { numeric: seconds === 0 ? 'auto' : 'always' };
  let format: Intl.RelativeTimeFormat;
  try {
    format = new Intl.RelativeTimeFormat(locale, options);
  } catch {
    format = new Intl.RelativeTimeFormat(undefined, options);
  }
  for (const [unit, unit_seconds] of RELATIVE_TIME_STEPS) {
    if (unit_seconds < day) break;
    if (Math.abs(seconds) >= unit_seconds) {
      return format.format(Math.trunc(seconds / unit_seconds), unit);
    }
  }
  return format.format(0, 'day');
}
