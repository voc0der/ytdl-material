import { DatePipe } from '@angular/common';
import { Pipe, PipeTransform } from '@angular/core';
import { PostsService } from '../posts.services';

/**
 * The format aliases this app passes to Angular's date pipe. Each one is resolved against
 * the locale by Angular itself, which is what the default (empty) setting keeps.
 */
export type DateFormatAlias = 'shortDate' | 'mediumDate' | 'longDate' | 'short' | 'medium';

export type DateFormatSetting = '' | 'mm/dd/yyyy' | 'dd/mm/yyyy' | 'yyyy-mm-dd';

/**
 * What each alias becomes once a format has been chosen explicitly. The date part is the
 * chosen order in every case; the time part follows the convention that goes with it, since
 * a 12-hour clock beside an ISO date reads as a mismatch.
 *
 * longDate loses its spelled-out month here on purpose: picking a format means asking for
 * dates to look the same everywhere, and a tooltip that disagrees with the card under it
 * would defeat the setting.
 */
const EXPLICIT_FORMATS: Record<Exclude<DateFormatSetting, ''>, Record<DateFormatAlias, string>> = {
  'mm/dd/yyyy': {
    shortDate: 'MM/dd/yyyy',
    mediumDate: 'MM/dd/yyyy',
    longDate: 'MM/dd/yyyy',
    short: 'MM/dd/yyyy, h:mm a',
    medium: 'MM/dd/yyyy, h:mm:ss a'
  },
  'dd/mm/yyyy': {
    shortDate: 'dd/MM/yyyy',
    mediumDate: 'dd/MM/yyyy',
    longDate: 'dd/MM/yyyy',
    short: 'dd/MM/yyyy, HH:mm',
    medium: 'dd/MM/yyyy, HH:mm:ss'
  },
  'yyyy-mm-dd': {
    shortDate: 'yyyy-MM-dd',
    mediumDate: 'yyyy-MM-dd',
    longDate: 'yyyy-MM-dd',
    short: 'yyyy-MM-dd HH:mm',
    medium: 'yyyy-MM-dd HH:mm:ss'
  }
};

export function resolveDateFormat(alias: DateFormatAlias, setting: unknown): string {
  const explicit = EXPLICIT_FORMATS[setting as Exclude<DateFormatSetting, ''>];
  return explicit ? explicit[alias] : alias;
}

/**
 * Formats a date the way the instance is configured to, falling back to the locale's own
 * pattern when no format has been set.
 *
 * Impure because the format comes from the config rather than from an argument, and the
 * config is replaced in place when settings are saved. The last call is memoized so the
 * repeated change-detection passes that an impure pipe invites cost a few comparisons
 * rather than a reformat -- the library renders one of these per card.
 */
@Pipe({ name: 'appDate', pure: false })
export class AppDatePipe implements PipeTransform {
  private readonly datePipe = new DatePipe('en-US');
  private last_key: string | null = null;
  private last_result: string | null = null;

  constructor(private postsService: PostsService) {}

  transform(
    value: string | number | Date | null | undefined,
    alias: DateFormatAlias = 'shortDate',
    timezone?: string,
    locale?: string
  ): string | null {
    const setting = this.postsService.config?.['Extra']?.['date_format'] ?? '';
    const key = JSON.stringify([value, alias, setting, timezone, locale]);
    if (key === this.last_key) return this.last_result;

    const format = resolveDateFormat(alias, setting);
    // An unparseable value throws rather than returning null, and one bad record should not
    // blank out the card it belongs to.
    try {
      this.last_result = this.datePipe.transform(value, format, timezone, locale);
    } catch {
      this.last_result = null;
    }
    this.last_key = key;
    return this.last_result;
  }
}
