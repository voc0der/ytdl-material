import { NgZone } from '@angular/core';

// How long the mouse has to be left alone before theater mode comes on by itself. Resting on the
// page it may be about to be used, so it waits longer than once the mouse has left the window or
// another window has been brought to the front.
export const AUTO_THEATER_REST_DELAY_MS = 5000;
export const AUTO_THEATER_AWAY_DELAY_MS = 3000;
// How soon it asks again when theater mode could not come on, such as while a menu is open.
export const AUTO_THEATER_RETRY_MS = 1000;

// Theater mode is a desktop layout, and a touch screen offers neither it nor this.
export function autoTheaterSupported(): boolean {
  return !(window.matchMedia?.('(hover: none), (pointer: coarse)').matches ?? false);
}

export interface AutoTheaterHost {
  // The mouse has been left alone long enough. False when theater mode cannot come on just now,
  // to be asked again shortly.
  idle(): boolean;
  // The mouse moved, or its wheel turned.
  moved(): void;
}

const PASSIVE_CAPTURE: AddEventListenerOptions = {capture: true, passive: true};

// Notices the mouse being left alone. Mouse events come thick and fast, so they are handled outside
// Angular, and the host goes back in only to change something.
export class AutoTheaterWatch {
  private watching = false;
  // When the mouse will have been left alone long enough.
  private deadline = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private timer_at = 0;
  // Where the mouse last was, to tell a move from an event that repeats where it already is.
  private x: number | null = null;
  private y: number | null = null;
  // The mouse has left the window.
  private pointer_away = false;
  // Another window is in front.
  private blurred = false;

  constructor(private zone: NgZone, private host: AutoTheaterHost) {}

  // Nothing has happened since the mouse was last left alone long enough.
  get idle(): boolean {
    return this.watching && Date.now() >= this.deadline;
  }

  start(): void {
    if (this.watching) return;
    this.watching = true;
    this.pointer_away = false;
    this.blurred = !document.hasFocus();
    this.zone.runOutsideAngular(() => {
      window.addEventListener('pointermove', this.onPointerMove, PASSIVE_CAPTURE);
      window.addEventListener('wheel', this.onWheel, PASSIVE_CAPTURE);
      window.addEventListener('pointerdown', this.onActivity, PASSIVE_CAPTURE);
      window.addEventListener('keydown', this.onActivity, PASSIVE_CAPTURE);
      document.addEventListener('mouseout', this.onMouseOut, PASSIVE_CAPTURE);
      window.addEventListener('blur', this.onBlur);
      window.addEventListener('focus', this.onFocus);
      document.addEventListener('visibilitychange', this.onVisibilityChange);
    });
    this.reset();
  }

  stop(): void {
    if (!this.watching) return;
    this.watching = false;
    window.removeEventListener('pointermove', this.onPointerMove, PASSIVE_CAPTURE);
    window.removeEventListener('wheel', this.onWheel, PASSIVE_CAPTURE);
    window.removeEventListener('pointerdown', this.onActivity, PASSIVE_CAPTURE);
    window.removeEventListener('keydown', this.onActivity, PASSIVE_CAPTURE);
    document.removeEventListener('mouseout', this.onMouseOut, PASSIVE_CAPTURE);
    window.removeEventListener('blur', this.onBlur);
    window.removeEventListener('focus', this.onFocus);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  // Something that says the viewer is there without moving the mouse, such as a key press or
  // playback starting. The wait starts over.
  reset(): void {
    this.arm(Date.now() + this.delay());
  }

  private delay(): number {
    return this.pointer_away || this.blurred || document.hidden ? AUTO_THEATER_AWAY_DELAY_MS : AUTO_THEATER_REST_DELAY_MS;
  }

  // The viewer went elsewhere: the shorter wait, unless the longer one was due sooner anyway.
  private soon(): void {
    const at = Date.now() + AUTO_THEATER_AWAY_DELAY_MS;
    this.arm(this.timer === null ? at : Math.min(this.deadline, at));
  }

  private arm(at: number): void {
    if (!this.watching) return;
    this.deadline = at;
    // A timer due by then looks again when it fires, which saves setting a new one on every move.
    if (this.timer !== null && this.timer_at <= at) return;
    this.schedule(at);
  }

  private schedule(at: number): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer_at = at;
    this.timer = this.zone.runOutsideAngular(() => setTimeout(this.fire, Math.max(at - Date.now(), 0)));
  }

  private readonly fire = (): void => {
    this.timer = null;
    const now = Date.now();
    if (now < this.deadline) {
      this.schedule(this.deadline);
    } else if (!this.host.idle() && this.watching) {
      this.schedule(now + AUTO_THEATER_RETRY_MS);
    }
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    // The page changing under a still mouse can bring a move to where it already was.
    if (event.clientX === this.x && event.clientY === this.y) return;
    this.x = event.clientX;
    this.y = event.clientY;
    this.pointer_away = false;
    this.reset();
    this.host.moved();
  };

  // Turning the wheel asks for the page as much as moving the mouse does.
  private readonly onWheel = (): void => {
    this.reset();
    this.host.moved();
  };

  private readonly onActivity = (): void => this.reset();

  private readonly onMouseOut = (event: MouseEvent): void => {
    // Only leaving the window goes nowhere on the page.
    if (event.relatedTarget) return;
    this.pointer_away = true;
    this.soon();
  };

  private readonly onBlur = (): void => {
    this.blurred = true;
    this.soon();
  };

  private readonly onFocus = (): void => {
    this.blurred = false;
    this.reset();
  };

  private readonly onVisibilityChange = (): void => {
    if (document.hidden) this.soon();
    else this.reset();
  };
}
