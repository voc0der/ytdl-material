import {
  changedSubscriptionFields, defaultSubscriptionSettings, formatRelativeTime, formatTimerange, isSubscriptionBusy,
  isSubscriptionChecking, lastCheckedAt, parseTimerange, settingsFromSubscription, subscriptionState, timerangeChoice
} from './subscription-settings';

describe('subscription settings', () => {
  describe('timeranges', () => {
    it('reads the range a subscription stores', () => {
      expect(parseTimerange('now-2weeks')).toEqual({ amount: 2, unit: 'week' });
      expect(parseTimerange('now-1day')).toEqual({ amount: 1, unit: 'day' });
    });

    it('has no range for every upload or for something it cannot read', () => {
      expect(parseTimerange(null)).toBeNull();
      expect(parseTimerange('now-fortnight')).toBeNull();
    });

    it('writes a range the way the backend expects it, singular for one', () => {
      expect(formatTimerange(1, 'week')).toBe('now-1week');
      expect(formatTimerange(30, 'day')).toBe('now-30days');
    });

    it('has nothing to write while the number is empty or below one', () => {
      expect(formatTimerange(null, 'day')).toBeNull();
      expect(formatTimerange(0, 'day')).toBeNull();
    });

    it('shows a range that is not one of the presets as a custom one', () => {
      expect(timerangeChoice('now-1month')).toBe('now-1month');
      expect(timerangeChoice('now-13days')).toBe('custom');
      expect(timerangeChoice(null)).toBeNull();
    });
  });

  describe('reading a subscription', () => {
    it('keeps the behaviour of a subscription saved before these settings existed', () => {
      const settings = settingsFromSubscription({ id: 'sub-1' } as any);

      expect(settings.use_subfolder).toBe(true);
      expect(settings.auto_create_playlist).toBe(false);
      expect(settings.maxQuality).toBe('best');
      expect(settings.timerange).toBeNull();
    });

    it('reads audio only from the type it downloads', () => {
      expect(settingsFromSubscription({ id: 'sub-1', type: 'audio' } as any).audioOnly).toBe(true);
      expect(settingsFromSubscription({ id: 'sub-1', type: 'video' } as any).audioOnly).toBe(false);
    });
  });

  describe('what an update sends', () => {
    it('sends nothing while nothing has changed', () => {
      const settings = defaultSubscriptionSettings();

      expect(changedSubscriptionFields(settings, { ...settings })).toEqual({});
    });

    it('sends only the settings that changed', () => {
      const before = defaultSubscriptionSettings();
      const after = { ...before, paused: true, maxQuality: '720' };

      expect(changedSubscriptionFields(before, after)).toEqual({ paused: true, maxQuality: '720' });
    });

    it('never sends audio only, which cannot change after subscribing', () => {
      const before = defaultSubscriptionSettings();

      expect(changedSubscriptionFields(before, { ...before, audioOnly: true })).toEqual({});
    });

    it('sends a range that was cleared', () => {
      const before = { ...defaultSubscriptionSettings(), timerange: 'now-1week' };

      expect(changedSubscriptionFields(before, { ...before, timerange: null })).toEqual({ timerange: null });
    });
  });

  describe('state', () => {
    it('calls a subscription whose link could not be read unavailable', () => {
      expect(subscriptionState({ id: 'sub-1', name: null } as any)).toBe('unavailable');
    });

    it('calls one that is being looked up for the first time checking', () => {
      expect(subscriptionState({ id: 'sub-1', name: null, downloading: true } as any)).toBe('checking');
    });

    it('puts paused ahead of a last check that failed', () => {
      expect(subscriptionState({ id: 'sub-1', name: 'Test', paused: true, refresh_status: { phase: 'error' } } as any)).toBe('paused');
    });

    it('calls one with downloads still queued downloading', () => {
      const sub = { id: 'sub-1', name: 'Test', refresh_status: { phase: 'queued', pending_download_count: 3 } } as any;

      expect(subscriptionState(sub)).toBe('downloading');
      expect(isSubscriptionBusy(sub)).toBe(true);
    });

    it('calls a finished refresh with nothing left to do idle', () => {
      const sub = { id: 'sub-1', name: 'Test', refresh_status: { phase: 'complete', completed_at: 1000 } } as any;

      expect(subscriptionState(sub)).toBe('idle');
      expect(isSubscriptionBusy(sub)).toBe(false);
      expect(lastCheckedAt(sub)).toBe(1000);
    });

    it('still reports a check that can be stopped on a paused subscription', () => {
      const sub = { id: 'sub-1', name: 'Test', paused: true, refresh_status: { phase: 'collecting', active: true } } as any;

      expect(subscriptionState(sub)).toBe('paused');
      expect(isSubscriptionChecking(sub)).toBe(true);
    });
  });

  describe('relative times', () => {
    const now = Date.parse('2026-03-25T12:00:00Z');

    it('says just now for the last minute', () => {
      expect(formatRelativeTime(now - 20_000, now, 'en-US')).toBe('just now');
    });

    it('counts in the largest unit that fits', () => {
      expect(formatRelativeTime(now - 5 * 60_000, now, 'en-US')).toBe('5 minutes ago');
      expect(formatRelativeTime(now - 3 * 60 * 60_000, now, 'en-US')).toBe('3 hours ago');
      expect(formatRelativeTime(now - 24 * 60 * 60_000, now, 'en-US')).toBe('yesterday');
    });

    it('falls back to the browser locale when given one it does not know', () => {
      expect(formatRelativeTime(now - 5 * 60_000, now, 'not-a-locale')).toContain('5');
    });
  });
});
