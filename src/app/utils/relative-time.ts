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
