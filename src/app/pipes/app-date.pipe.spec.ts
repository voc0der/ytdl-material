import { AppDatePipe, resolveDateFormat } from './app-date.pipe';

describe('resolveDateFormat', () => {
  it('passes the alias through when no format is configured', () => {
    // Angular resolves the alias against the active locale, which is what keeps an en-GB
    // instance on dd/MM/yyyy without anyone configuring anything.
    for (const setting of ['', null, undefined]) {
      expect(resolveDateFormat('shortDate', setting)).toBe('shortDate');
      expect(resolveDateFormat('medium', setting)).toBe('medium');
    }
  });

  it('passes the alias through for a value that matches no known format', () => {
    expect(resolveDateFormat('shortDate', 'dd.mm.yyyy')).toBe('shortDate');
  });

  it('maps every alias to the configured date order', () => {
    expect(resolveDateFormat('shortDate', 'yyyy-mm-dd')).toBe('yyyy-MM-dd');
    expect(resolveDateFormat('mediumDate', 'yyyy-mm-dd')).toBe('yyyy-MM-dd');
    expect(resolveDateFormat('longDate', 'yyyy-mm-dd')).toBe('yyyy-MM-dd');
    expect(resolveDateFormat('shortDate', 'dd/mm/yyyy')).toBe('dd/MM/yyyy');
    expect(resolveDateFormat('shortDate', 'mm/dd/yyyy')).toBe('MM/dd/yyyy');
  });

  it('keeps the time part on the aliases that carry one', () => {
    expect(resolveDateFormat('medium', 'yyyy-mm-dd')).toContain('HH:mm:ss');
    expect(resolveDateFormat('short', 'dd/mm/yyyy')).toContain('HH:mm');
    // A 12-hour clock goes with the US date order and not with the other two.
    expect(resolveDateFormat('medium', 'mm/dd/yyyy')).toContain('h:mm:ss a');
  });
});

describe('AppDatePipe', () => {
  const pipeWith = (date_format: unknown) =>
    new AppDatePipe({ config: { Extra: { date_format } } } as any);

  // 20 Sep 2026, fixed to UTC so the assertions do not move with the runner's timezone.
  const value = '2026-09-20T12:00:00Z';

  it('formats in the configured order', () => {
    expect(pipeWith('yyyy-mm-dd').transform(value, 'shortDate', 'UTC')).toBe('2026-09-20');
    expect(pipeWith('dd/mm/yyyy').transform(value, 'shortDate', 'UTC')).toBe('20/09/2026');
    expect(pipeWith('mm/dd/yyyy').transform(value, 'shortDate', 'UTC')).toBe('09/20/2026');
  });

  it('falls back to the locale when nothing is configured', () => {
    expect(pipeWith('').transform(value, 'shortDate', 'UTC')).toBe('9/20/26');
  });

  it('treats a missing config as unconfigured rather than failing', () => {
    expect(new AppDatePipe({} as any).transform(value, 'shortDate', 'UTC')).toBe('9/20/26');
  });

  it('returns null for an empty value instead of a placeholder date', () => {
    expect(pipeWith('yyyy-mm-dd').transform(null, 'shortDate', 'UTC')).toBeNull();
    expect(pipeWith('yyyy-mm-dd').transform(undefined, 'shortDate', 'UTC')).toBeNull();
  });

  it('returns null for an unparseable value rather than throwing', () => {
    // The pipe runs once per card, so one bad record must not blank out its card.
    expect(pipeWith('yyyy-mm-dd').transform('not a date', 'shortDate', 'UTC')).toBeNull();
  });

  it('reformats when the configured format changes under it', () => {
    // The pipe is impure and memoized; the config object is replaced in place when settings
    // are saved, so a stale cache would leave the old format on screen.
    const config = { Extra: { date_format: 'yyyy-mm-dd' } };
    const pipe = new AppDatePipe({ config } as any);

    expect(pipe.transform(value, 'shortDate', 'UTC')).toBe('2026-09-20');
    config.Extra.date_format = 'dd/mm/yyyy';
    expect(pipe.transform(value, 'shortDate', 'UTC')).toBe('20/09/2026');
  });

  it('serves a repeated call from the memo', () => {
    const pipe = pipeWith('yyyy-mm-dd');

    expect(pipe.transform(value, 'shortDate', 'UTC')).toBe('2026-09-20');
    expect(pipe.transform(value, 'shortDate', 'UTC')).toBe('2026-09-20');
  });
});
