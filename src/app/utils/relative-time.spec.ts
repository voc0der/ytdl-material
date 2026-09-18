import { formatRelativeDate } from './relative-time';

describe('formatRelativeDate', () => {
  const now = Date.UTC(2026, 8, 18, 23, 59);

  it.each([
    ['2026-09-18', 'today'],
    ['2026-09-17', '1 day ago'],
    ['2026-09-12', '6 days ago'],
    ['2026-09-11', '1 week ago'],
    ['2026-08-20', '4 weeks ago'],
    ['2026-08-19', '1 month ago'],
    ['2025-10-01', '11 months ago'],
    ['2025-09-18', '1 year ago'],
    ['2024-09-18', '2 years ago'],
    ['2026-09-19', 'in 1 day']
  ])('formats %s using completed days or larger units', (date, expected) => {
    expect(formatRelativeDate(Date.parse(date), now, 'en-US')).toBe(expected);
  });

  it('counts UTC calendar days even just across midnight', () => {
    expect(formatRelativeDate(Date.parse('2026-09-17'), Date.UTC(2026, 8, 18, 0, 1), 'en-US')).toBe('1 day ago');
  });

  it('uses the selected locale', () => {
    expect(formatRelativeDate(Date.parse('2026-09-16'), now, 'fr')).toBe('il y a 2 jours');
  });
});
