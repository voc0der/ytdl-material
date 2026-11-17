import { NgZone } from '@angular/core';
import {
  AUTO_THEATER_AWAY_DELAY_MS, AUTO_THEATER_REST_DELAY_MS, AUTO_THEATER_RETRY_MS, AutoTheaterWatch, autoTheaterSupported
} from './auto-theater';

describe('AutoTheaterWatch', () => {
  const zone = { runOutsideAngular: (fn: () => unknown) => fn() } as unknown as NgZone;
  let idle: ReturnType<typeof vi.fn<() => boolean>>;
  let moved: ReturnType<typeof vi.fn<() => void>>;
  let watch: AutoTheaterWatch;

  const move = (x: number, y: number) => window.dispatchEvent(new PointerEvent('pointermove', {clientX: x, clientY: y}));
  const mouseOut = (to: EventTarget | null) => document.body.dispatchEvent(new MouseEvent('mouseout', {bubbles: true, relatedTarget: to}));
  const setHidden = (hidden: boolean) => {
    Object.defineProperty(document, 'hidden', {configurable: true, get: () => hidden});
    document.dispatchEvent(new Event('visibilitychange'));
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    idle = vi.fn<() => boolean>().mockReturnValue(true);
    moved = vi.fn<() => void>();
    watch = new AutoTheaterWatch(zone, {idle, moved});
  });

  afterEach(() => {
    watch.stop();
    delete (document as {hidden?: boolean}).hidden;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('asks for theater mode once the mouse has rested on the page for the longer wait', () => {
    watch.start();
    vi.advanceTimersByTime(AUTO_THEATER_REST_DELAY_MS - 1);
    expect(idle).not.toHaveBeenCalled();
    expect(watch.idle).toBe(false);

    vi.advanceTimersByTime(1);
    expect(idle).toHaveBeenCalledTimes(1);
    expect(watch.idle).toBe(true);
  });

  it('starts the wait over on every move, and reports each one', () => {
    watch.start();
    vi.advanceTimersByTime(4000);
    move(10, 10);
    expect(moved).toHaveBeenCalledTimes(1);
    expect(watch.idle).toBe(false);

    vi.advanceTimersByTime(4000);
    move(12, 10);
    expect(moved).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(AUTO_THEATER_REST_DELAY_MS - 1);
    expect(idle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(idle).toHaveBeenCalledTimes(1);
  });

  // The page changing under a mouse that has not moved can come with an event saying it is where
  // it already was. Taking that for a move would turn theater mode off as soon as it came on.
  it('takes a move to where the mouse already was for no move at all', () => {
    watch.start();
    move(10, 10);
    vi.advanceTimersByTime(4000);
    move(10, 10);

    expect(moved).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(idle).toHaveBeenCalledTimes(1);
  });

  it('takes the wheel turning for a move', () => {
    watch.start();
    vi.advanceTimersByTime(4000);
    window.dispatchEvent(new WheelEvent('wheel', {deltaY: 100}));

    expect(moved).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(4000);
    expect(idle).not.toHaveBeenCalled();
  });

  it('starts the wait over on a key or a click without reporting a move', () => {
    watch.start();
    vi.advanceTimersByTime(4000);
    window.dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowRight'}));
    vi.advanceTimersByTime(4000);
    window.dispatchEvent(new PointerEvent('pointerdown'));
    vi.advanceTimersByTime(4000);
    watch.reset();
    vi.advanceTimersByTime(AUTO_THEATER_REST_DELAY_MS - 1);

    expect(idle).not.toHaveBeenCalled();
    expect(moved).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(idle).toHaveBeenCalledTimes(1);
  });

  it('waits the shorter time once the mouse leaves the window, and the longer again once it is back', () => {
    watch.start();
    move(10, 10);
    mouseOut(null);
    vi.advanceTimersByTime(AUTO_THEATER_AWAY_DELAY_MS);
    expect(idle).toHaveBeenCalledTimes(1);

    move(0, 5);
    vi.advanceTimersByTime(AUTO_THEATER_AWAY_DELAY_MS);
    expect(idle).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(AUTO_THEATER_REST_DELAY_MS - AUTO_THEATER_AWAY_DELAY_MS);
    expect(idle).toHaveBeenCalledTimes(2);
  });

  it('pays no attention to the mouse going from one part of the page to another', () => {
    watch.start();
    mouseOut(document.body);
    vi.advanceTimersByTime(AUTO_THEATER_AWAY_DELAY_MS);
    expect(idle).not.toHaveBeenCalled();
  });

  it('waits the shorter time once another window is in front, unless the longer wait ends first', () => {
    watch.start();
    vi.advanceTimersByTime(1000);
    window.dispatchEvent(new FocusEvent('blur'));
    vi.advanceTimersByTime(AUTO_THEATER_AWAY_DELAY_MS - 1);
    expect(idle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(idle).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new FocusEvent('focus'));
    vi.advanceTimersByTime(AUTO_THEATER_REST_DELAY_MS - 500);
    window.dispatchEvent(new FocusEvent('blur'));
    vi.advanceTimersByTime(500);
    expect(idle).toHaveBeenCalledTimes(2);
  });

  it('starts the longer wait over when the window comes back to the front', () => {
    watch.start();
    window.dispatchEvent(new FocusEvent('blur'));
    vi.advanceTimersByTime(AUTO_THEATER_AWAY_DELAY_MS - 1);
    window.dispatchEvent(new FocusEvent('focus'));
    vi.advanceTimersByTime(AUTO_THEATER_REST_DELAY_MS - 1);
    expect(idle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(idle).toHaveBeenCalledTimes(1);
  });

  it('waits the shorter time from the start for a page opened behind another window', () => {
    vi.mocked(document.hasFocus).mockReturnValue(false);
    watch.start();
    vi.advanceTimersByTime(AUTO_THEATER_AWAY_DELAY_MS);
    expect(idle).toHaveBeenCalledTimes(1);
  });

  it('waits the shorter time once the tab is hidden, and starts over when it is shown again', () => {
    watch.start();
    setHidden(true);
    vi.advanceTimersByTime(AUTO_THEATER_AWAY_DELAY_MS);
    expect(idle).toHaveBeenCalledTimes(1);

    setHidden(false);
    vi.advanceTimersByTime(AUTO_THEATER_REST_DELAY_MS - 1);
    expect(idle).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(idle).toHaveBeenCalledTimes(2);
  });

  it('asks again shortly while theater mode cannot come on, and stops asking once it has', () => {
    idle.mockReturnValue(false);
    watch.start();
    vi.advanceTimersByTime(AUTO_THEATER_REST_DELAY_MS);
    expect(idle).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(AUTO_THEATER_RETRY_MS);
    expect(idle).toHaveBeenCalledTimes(2);
    expect(watch.idle).toBe(true);

    idle.mockReturnValue(true);
    vi.advanceTimersByTime(AUTO_THEATER_RETRY_MS);
    expect(idle).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(60_000);
    expect(idle).toHaveBeenCalledTimes(3);
  });

  it('stops listening and waiting once stopped', () => {
    watch.start();
    watch.stop();
    move(10, 10);
    window.dispatchEvent(new FocusEvent('blur'));
    vi.advanceTimersByTime(60_000);

    expect(idle).not.toHaveBeenCalled();
    expect(moved).not.toHaveBeenCalled();
    expect(watch.idle).toBe(false);
  });

  it('starts only once however often it is started', () => {
    watch.start();
    watch.start();
    move(10, 10);
    expect(moved).toHaveBeenCalledTimes(1);
  });
});

describe('autoTheaterSupported', () => {
  afterEach(() => {
    delete (window as {matchMedia?: unknown}).matchMedia;
  });

  it('is not offered on a touch screen, where theater mode is not either', () => {
    const matchMedia = vi.fn((query: string) => ({matches: query === '(hover: none), (pointer: coarse)'}));
    Object.defineProperty(window, 'matchMedia', {configurable: true, value: matchMedia});
    expect(autoTheaterSupported()).toBe(false);
  });

  it('is offered with a mouse', () => {
    Object.defineProperty(window, 'matchMedia', {configurable: true, value: () => ({matches: false})});
    expect(autoTheaterSupported()).toBe(true);
  });
});
