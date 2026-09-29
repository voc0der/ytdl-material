import {
  AfterViewChecked, ChangeDetectionStrategy, ChangeDetectorRef, Component, ElementRef, EventEmitter, HostBinding,
  HostListener, Input, NgZone, OnChanges, OnDestroy, Output, SimpleChanges, ViewChild
} from '@angular/core';
import { MatIcon } from '@angular/material/icon';
import type { IChapter } from '../player.component';

// How long the controls stay up after the pointer last moved over a playing video.
const CONTROLS_HIDE_DELAY_MS = 2500;
const FLASH_DURATION_MS = 650;
// Holding the left button, or a finger, on the picture plays at SPEED_HOLD_RATE until it is let
// go. A press released sooner is an ordinary click.
const SPEED_HOLD_DELAY_MS = 400;
const SPEED_HOLD_RATE = 2;
// A press that drifts further than this before the hold engages is a drag, not a hold.
const SPEED_HOLD_MOVE_TOLERANCE_PX = 10;
const SEEK_STEP_SECONDS = 5;
const SEEK_JUMP_SECONDS = 10;
const VOLUME_STEP = 0.05;
// HTMLMediaElement.HAVE_FUTURE_DATA, which jsdom does not define.
const HAVE_FUTURE_DATA = 3;
export const PLAYBACK_RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
// Chrome opens its cast picker only within five seconds of a click. A source swap that takes
// longer than this leaves the picker to a second click.
const CAST_PROMPT_WINDOW_MS = 4000;
// One black frame of H.264, which every cast device plays. Whether it could be cast says a device
// is around even while the file itself is in a codec the device cannot take, such as AV1 on
// Android, where the file's own availability never turns true.
const CAST_PROBE_SRC = 'assets/cast-probe.mp4';

const MEDIA_EVENTS = [
  'play', 'pause', 'playing', 'waiting', 'ended', 'timeupdate', 'durationchange', 'loadedmetadata', 'progress',
  'volumechange', 'ratechange', 'seeking', 'seeked', 'canplay', 'emptied', 'error', 'enterpictureinpicture',
  'leavepictureinpicture'
];
const CAST_EVENTS = ['connecting', 'connect', 'disconnect'];

/**
 * Whether the loaded file may go to a cast device, which fetches it itself (Chrome on Android,
 * AirPlay) rather than through the browser:
 * - ready: as it is.
 * - needs-link: its URL carries the viewer's login, so the player swaps in a playback link first.
 * - preparing: the player is getting one, or waiting on a copy the device can play.
 * - unavailable: no link can be had for it.
 */
export type CastSource = 'ready' | 'needs-link' | 'preparing' | 'unavailable';

export interface CastRequest {
  // A device is around, but it cannot play the file as it is.
  transcode: boolean;
}

export interface ScrubSegment {
  start: number;
  end: number;
  title: string | null;
}

interface Flash {
  icon: string;
  label: string | null;
}

interface SpeedHold {
  src: string;
  start_x: number;
  start_y: number;
  // Pending until the hold engages; null once it has.
  timer: ReturnType<typeof setTimeout> | null;
  previous_rate: number;
  was_paused: boolean;
}

type Menu = 'speed' | 'chapters';

// The Remote Playback API's methods reject rather than throw, but a browser that throws anyway
// must not take the rest of the controls down with it.
function attempt<T>(call: () => Promise<T>): Promise<T> {
  try {
    return call();
  } catch (error) {
    return Promise.reject(error);
  }
}

export function formatMediaTime(total_seconds: number): string {
  const safe_seconds = Math.max(0, Math.floor(total_seconds || 0));
  const hours = Math.floor(safe_seconds / 3600);
  const minutes = Math.floor((safe_seconds % 3600) / 60);
  const seconds = `${safe_seconds % 60}`.padStart(2, '0');
  return hours > 0 ? `${hours}:${`${minutes}`.padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`;
}

// The player's own controls, drawn over the video in place of the browser's. Firefox keeps every
// press on its native controls to itself, so nothing the page draws over them can react to one.
@Component({
  selector: 'app-media-controls',
  templateUrl: './media-controls.component.html',
  styleUrls: ['./media-controls.component.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIcon]
})
export class MediaControlsComponent implements OnChanges, AfterViewChecked, OnDestroy {
  @Input({required: true}) media!: HTMLVideoElement;
  @Input() chapters: IChapter[] = [];
  @Input() subtitlesAvailable = false;
  @Input() subtitlesEnabled = false;
  @Input() theaterAvailable = false;
  @Input() theaterEnabled = false;
  @Input() hasNext = false;
  @Input() castSource: CastSource = 'ready';

  @Output() toggleSubtitles = new EventEmitter<void>();
  @Output() toggleTheater = new EventEmitter<void>();
  @Output() playNext = new EventEmitter<void>();
  // Asks the player for a source a cast device can fetch; castSource says when it has one.
  @Output() prepareCast = new EventEmitter<CastRequest>();

  @ViewChild('scrubber') scrubber?: ElementRef<HTMLElement>;
  @ViewChild('scrubTooltip') scrubTooltip?: ElementRef<HTMLElement>;

  readonly playback_rates = PLAYBACK_RATES;
  readonly speed_hold_rate = SPEED_HOLD_RATE;
  readonly formatTime = formatMediaTime;

  paused = true;
  ended = false;
  buffering = false;
  error = false;
  current_time = 0;
  duration = 0;
  volume = 1;
  muted = false;
  rate = 1;
  fullscreen = false;
  pip = false;
  pip_supported = false;
  // Chrome and Edge cast to a Chromecast, and Safari to AirPlay, through the Remote Playback API.
  // Firefox has none, so it never shows the button.
  cast_supported = false;
  cast_state: RemotePlaybackState = 'disconnected';

  segments: ScrubSegment[] = [{start: 0, end: 1, title: null}];
  scrubbing = false;
  scrub_time: number | null = null;
  hover_time: number | null = null;
  hover_segment = -1;
  hover_left = 0;

  menu: Menu | null = null;
  flash: Flash | null = null;
  flash_id = 0;
  speed_hold_active = false;
  // Touch gets a play button in the middle, since a tap there only shows the controls.
  touch_ui = false;

  private active = false;
  private pointer_over_bar = false;
  private keyboard_in_bar = false;
  private hide_timer: ReturnType<typeof setTimeout> | null = null;
  private flash_timer: ReturnType<typeof setTimeout> | null = null;
  private frame: number | null = null;
  private pending_seek: number | null = null;
  private volume_before_mute = 1;
  private last_pointer_type = 'mouse';
  private speed_hold: SpeedHold | null = null;
  private suppress_click = false;
  private segments_changed = false;
  // A device can take the loaded file as it is.
  private cast_source_available = false;
  // A device is around that can take the H.264 copy.
  private cast_device_available = false;
  private cast_watch: number | null = null;
  private cast_probe: HTMLVideoElement | null = null;
  private cast_probe_watch: number | null = null;
  // When the cast button last asked the player for a source, for opening the picker once it has.
  private cast_requested_at: number | null = null;

  constructor(private host: ElementRef<HTMLElement>, private cdr: ChangeDetectorRef, private zone: NgZone) {}

  @HostBinding('class.controls-visible')
  get controlsVisible(): boolean {
    return this.paused || this.ended || this.error || this.scrubbing || this.menu !== null
      || this.pointer_over_bar || this.keyboard_in_bar || this.active;
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['media']) {
      this.detachMedia(changes['media'].previousValue);
      this.attachMedia();
    }
    if (changes['chapters']) this.buildSegments();
    if (changes['castSource']) this.onCastSourceChange();
  }

  ngOnDestroy(): void {
    this.endSpeedHold();
    this.detachMedia(this.media);
    this.stopProgressLoop();
    if (this.hide_timer) clearTimeout(this.hide_timer);
    if (this.flash_timer) clearTimeout(this.flash_timer);
  }

  private attachMedia(): void {
    const media = this.media;
    if (!media) return;
    for (const type of MEDIA_EVENTS) media.addEventListener(type, this.onMediaEvent);
    this.pip_supported = !!document.pictureInPictureEnabled && typeof media.requestPictureInPicture === 'function'
      && !media.disablePictureInPicture;
    this.attachCast(media);
    this.sync();
    if (!media.paused) this.startProgressLoop();
  }

  private detachMedia(media: HTMLVideoElement | null | undefined): void {
    if (!media) return;
    for (const type of MEDIA_EVENTS) media.removeEventListener(type, this.onMediaEvent);
    this.detachCast(media);
  }

  private readonly onMediaEvent = (event: Event): void => {
    if (event.type === 'emptied') {
      // A new file: the old one's position and seeks mean nothing to it.
      this.pending_seek = null;
      this.scrub_time = null;
    }
    if (event.type === 'seeked' && this.pending_seek !== null) {
      const time = this.pending_seek;
      this.pending_seek = null;
      this.media.currentTime = time;
    }
    this.sync();
    if (event.type === 'play' || event.type === 'playing') this.startProgressLoop();
    if (event.type === 'pause' || event.type === 'ended' || event.type === 'emptied') this.stopProgressLoop();
    // Paused, the controls stay up; once it plays again they go after the usual delay.
    if (event.type === 'play') this.poke();
    this.cdr.markForCheck();
  };

  private sync(): void {
    const media = this.media;
    this.paused = media.paused;
    this.ended = media.ended;
    this.error = !!media.error;
    this.buffering = !media.paused && !media.error && media.readyState < HAVE_FUTURE_DATA;
    this.current_time = media.currentTime || 0;
    const duration = Number.isFinite(media.duration) ? media.duration : 0;
    if (duration !== this.duration) {
      this.duration = duration;
      this.buildSegments();
    }
    this.volume = media.volume;
    this.muted = media.muted;
    this.rate = media.playbackRate;
    this.pip = !!document.pictureInPictureElement && document.pictureInPictureElement === media;
    this.paintProgress();
  }

  // One segment per chapter, laid end to end over the whole file, or one for the lot.
  buildSegments(): void {
    const total = this.duration;
    const chapters = (this.chapters ?? [])
      .filter(chapter => chapter.end_time > chapter.start_time && (total <= 0 || chapter.start_time < total))
      .sort((a, b) => a.start_time - b.start_time);
    if (chapters.length === 0 || total <= 0) {
      this.segments = [{start: 0, end: total > 0 ? total : 1, title: null}];
    } else {
      this.segments = chapters.map((chapter, index) => ({
        start: index === 0 ? 0 : chapter.start_time,
        end: index === chapters.length - 1 ? total : chapters[index + 1].start_time,
        title: chapter.title
      }));
    }
    // The segments are redrawn on the next check; they are painted once they have been.
    this.segments_changed = true;
    this.cdr.markForCheck();
  }

  ngAfterViewChecked(): void {
    if (!this.segments_changed) return;
    this.segments_changed = false;
    this.paintProgress();
  }

  segmentAt(time: number): number {
    const index = this.segments.findIndex(segment => time >= segment.start && time < segment.end);
    return index >= 0 ? index : this.segments.length - 1;
  }

  get currentChapterTitle(): string | null {
    if (!this.chapters?.length) return null;
    return this.segments[this.segmentAt(this.scrub_time ?? this.current_time)]?.title ?? null;
  }

  get shownTime(): number {
    return this.scrub_time ?? this.current_time;
  }

  get volumeIcon(): string {
    if (this.muted || this.volume === 0) return 'volume_off';
    return this.volume < 0.5 ? 'volume_down' : 'volume_up';
  }

  get playIcon(): string {
    if (this.ended) return 'replay';
    return this.paused ? 'play_arrow' : 'pause';
  }

  get playLabel(): string {
    if (this.ended) return $localize`Replay`;
    return this.paused ? $localize`Play` : $localize`Pause`;
  }

  readonly muteLabel = $localize`Mute`;
  readonly unmuteLabel = $localize`Unmute`;
  readonly fullscreenLabel = $localize`Full screen`;
  readonly exitFullscreenLabel = $localize`Exit full screen`;
  readonly chaptersLabel = $localize`Chapters`;
  readonly castReadyLabel = $localize`Ready to cast`;
  readonly castUnsupportedLabel = $localize`This file can't be cast`;

  get castAvailable(): boolean {
    if (!this.cast_supported || this.castSource === 'unavailable') return false;
    return this.cast_state !== 'disconnected' || this.castSource === 'preparing'
      || this.cast_source_available || this.cast_device_available;
  }

  get castIcon(): string {
    return this.cast_state === 'connected' ? 'cast_connected' : 'cast';
  }

  get castLabel(): string {
    if (this.castSource === 'preparing') return $localize`Getting the file ready to cast`;
    return this.cast_state === 'disconnected' ? $localize`Cast` : $localize`Casting`;
  }

  get rateLabel(): string {
    return `${this.rate}x`;
  }

  // The progress bar moves every frame while playing, so it is painted straight onto the DOM rather
  // than through change detection.
  private paintProgress(time = this.scrub_time ?? this.media?.currentTime ?? 0): void {
    const scrubber = this.scrubber?.nativeElement;
    if (!scrubber) return;
    const played = scrubber.querySelectorAll<HTMLElement>('.segment-played');
    const buffered = scrubber.querySelectorAll<HTMLElement>('.segment-buffered');
    const buffered_end = this.bufferedEnd(time);
    const elements = this.segmentElements();
    const playhead = this.offsetOf(time);
    this.segments.forEach((segment, index) => {
      const fill = played[index];
      if (fill) {
        // Each segment shows its own slice of one gradient that runs from the start of the bar
        // to the playhead.
        fill.style.width = `${this.fraction(time, segment) * 100}%`;
        fill.style.backgroundSize = `${Math.max(playhead, 1)}px 100%`;
        fill.style.backgroundPosition = `${-(elements[index]?.offsetLeft ?? 0)}px 0`;
      }
      buffered[index]?.style.setProperty('transform', `scaleX(${this.fraction(buffered_end, segment)})`);
    });
    const thumb = scrubber.querySelector<HTMLElement>('.scrub-thumb');
    // `translate`, not `transform`: the hover's `scale` would otherwise scale the offset too.
    if (thumb) thumb.style.translate = `${playhead}px 0`;
  }

  private paintHover(time: number | null): void {
    const scrubber = this.scrubber?.nativeElement;
    if (!scrubber) return;
    const hovered = scrubber.querySelectorAll<HTMLElement>('.segment-hover');
    this.segments.forEach((segment, index) => {
      hovered[index]?.style.setProperty('transform', `scaleX(${time === null ? 0 : this.fraction(time, segment)})`);
    });
  }

  private fraction(time: number, segment: ScrubSegment): number {
    const length = segment.end - segment.start;
    if (length <= 0) return 0;
    return Math.min(Math.max((time - segment.start) / length, 0), 1);
  }

  private bufferedEnd(time: number): number {
    const ranges = this.media?.buffered;
    if (!ranges) return 0;
    for (let i = 0; i < ranges.length; i++) {
      if (time >= ranges.start(i) - 0.5 && time <= ranges.end(i)) return ranges.end(i);
    }
    return 0;
  }

  private segmentElements(): HTMLElement[] {
    return Array.from(this.scrubber?.nativeElement.querySelectorAll<HTMLElement>('.segment') ?? []);
  }

  // Pixels from the scrubber's left edge to where `time` falls, gaps between chapters included.
  private offsetOf(time: number): number {
    const elements = this.segmentElements();
    const index = this.segmentAt(time);
    const element = elements[index];
    if (!element) return 0;
    return element.offsetLeft + this.fraction(time, this.segments[index]) * element.offsetWidth;
  }

  // The time under a pointer at `client_x`. In a gap between chapters, the nearer edge.
  timeAt(client_x: number): number {
    const elements = this.segmentElements();
    let best_time = 0;
    let best_distance = Infinity;
    elements.forEach((element, index) => {
      const rect = element.getBoundingClientRect();
      const segment = this.segments[index];
      if (!segment) return;
      const x = Math.min(Math.max(client_x, rect.left), rect.right);
      const distance = Math.abs(client_x - x);
      if (distance < best_distance) {
        best_distance = distance;
        const along = rect.width > 0 ? (x - rect.left) / rect.width : 0;
        best_time = segment.start + along * (segment.end - segment.start);
      }
    });
    return Math.min(Math.max(best_time, 0), this.duration);
  }

  private startProgressLoop(): void {
    if (this.frame !== null || typeof requestAnimationFrame !== 'function') return;
    this.zone.runOutsideAngular(() => {
      const step = () => {
        if (!this.media || this.media.paused) {
          this.frame = null;
          return;
        }
        if (!this.scrubbing) this.paintProgress(this.media.currentTime);
        this.frame = requestAnimationFrame(step);
      };
      this.frame = requestAnimationFrame(step);
    });
  }

  private stopProgressLoop(): void {
    if (this.frame === null) return;
    cancelAnimationFrame(this.frame);
    this.frame = null;
  }

  // Shows the controls, and hides them again after a while if the video is playing.
  poke(): void {
    this.active = true;
    if (this.hide_timer) clearTimeout(this.hide_timer);
    this.hide_timer = setTimeout(() => {
      this.hide_timer = null;
      this.active = false;
      this.cdr.markForCheck();
    }, CONTROLS_HIDE_DELAY_MS);
    this.cdr.markForCheck();
  }

  private hideNow(): void {
    if (this.hide_timer) clearTimeout(this.hide_timer);
    this.hide_timer = null;
    this.active = false;
    this.cdr.markForCheck();
  }

  @HostListener('pointermove', ['$event'])
  onPointerMove(event: PointerEvent): void {
    // A finger dragging to scroll the page is not a request to see the controls.
    if (event.pointerType === 'mouse') this.poke();
  }

  @HostListener('pointerleave', ['$event'])
  onPointerLeave(event: PointerEvent): void {
    if (event.pointerType === 'mouse') this.hideNow();
  }

  onBarPointerEnter(): void {
    this.pointer_over_bar = true;
  }

  onBarPointerLeave(): void {
    this.pointer_over_bar = false;
    this.poke();
  }

  onBarFocusIn(event: FocusEvent): void {
    this.keyboard_in_bar = (event.target as HTMLElement | null)?.matches?.(':focus-visible') ?? false;
  }

  onBarFocusOut(event: FocusEvent): void {
    if (!this.host.nativeElement.contains(event.relatedTarget as Node | null)) this.keyboard_in_bar = false;
  }

  // The picture

  onSurfacePointerDown(event: PointerEvent): void {
    this.last_pointer_type = event.pointerType;
    this.touch_ui = event.pointerType !== 'mouse';
    if (!event.isPrimary || event.button !== 0) return;
    if (this.media.ended || this.error) return;

    this.endSpeedHold();
    this.speed_hold = {
      src: this.media.currentSrc,
      start_x: event.clientX,
      start_y: event.clientY,
      timer: setTimeout(() => this.engageSpeedHold(), SPEED_HOLD_DELAY_MS),
      previous_rate: this.media.playbackRate,
      was_paused: this.media.paused
    };
    // On the window, so letting go anywhere ends the hold, not only over the video.
    window.addEventListener('pointermove', this.onSpeedHoldPointerMove);
    window.addEventListener('pointerup', this.onSpeedHoldRelease);
    window.addEventListener('pointercancel', this.onSpeedHoldRelease);
    window.addEventListener('blur', this.onSpeedHoldRelease);
  }

  onSurfaceClick(): void {
    // Letting go of a hold is also a click.
    if (this.suppress_click) return;
    if (this.last_pointer_type !== 'mouse') {
      if (this.controlsVisible && !this.paused) this.hideNow();
      else this.poke();
      return;
    }
    this.togglePlay(true);
  }

  onSurfaceDoubleClick(): void {
    // Both clicks of it already toggled playback, which leaves it as it was.
    if (this.last_pointer_type === 'mouse') this.toggleFullscreen();
  }

  onSurfaceContextMenu(event: MouseEvent): void {
    // A long press on a touch screen opens the context menu; during a hold it is the hold.
    if (this.speed_hold || this.speed_hold_active) event.preventDefault();
  }

  private engageSpeedHold(): void {
    const hold = this.speed_hold;
    if (!hold) return;
    hold.timer = null;
    this.media.playbackRate = SPEED_HOLD_RATE;
    if (hold.was_paused) this.playMedia();
    this.speed_hold_active = true;
    this.cdr.markForCheck();
  }

  private readonly onSpeedHoldPointerMove = (event: PointerEvent): void => {
    const hold = this.speed_hold;
    // Once engaged, the hold lasts until release wherever the pointer goes.
    if (!hold?.timer) return;
    const distance = Math.hypot(event.clientX - hold.start_x, event.clientY - hold.start_y);
    if (distance > SPEED_HOLD_MOVE_TOLERANCE_PX) this.endSpeedHold();
  };

  private readonly onSpeedHoldRelease = (): void => this.endSpeedHold();

  private endSpeedHold(): void {
    const hold = this.speed_hold;
    if (!hold) return;
    this.speed_hold = null;
    window.removeEventListener('pointermove', this.onSpeedHoldPointerMove);
    window.removeEventListener('pointerup', this.onSpeedHoldRelease);
    window.removeEventListener('pointercancel', this.onSpeedHoldRelease);
    window.removeEventListener('blur', this.onSpeedHoldRelease);
    if (hold.timer) {
      clearTimeout(hold.timer);
      return;
    }

    this.speed_hold_active = false;
    // Loading the next file already reset the rate, and its paused state is its own.
    if (this.media.currentSrc === hold.src) {
      this.media.playbackRate = hold.previous_rate;
      if (hold.was_paused && !this.media.paused) this.media.pause();
    }
    // The click that comes with this release is dispatched before the timeout runs.
    this.suppress_click = true;
    setTimeout(() => {
      this.suppress_click = false;
    });
    this.cdr.markForCheck();
  }

  // The scrubber

  onScrubberPointerDown(event: PointerEvent): void {
    if (event.button !== 0 || this.duration <= 0) return;
    event.preventDefault();
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
    this.scrubbing = true;
    this.scrubTo(event.clientX);
  }

  onScrubberPointerMove(event: PointerEvent): void {
    if (this.duration <= 0) return;
    const time = this.timeAt(event.clientX);
    this.hover_time = time;
    this.hover_segment = this.segmentAt(time);
    this.hover_left = this.tooltipLeft(this.offsetOf(time));
    this.paintHover(time);
    if (this.scrubbing) this.scrubTo(event.clientX);
  }

  onScrubberPointerUp(event: PointerEvent): void {
    if (!this.scrubbing) return;
    this.scrubTo(event.clientX, true);
    this.scrubbing = false;
    this.scrub_time = null;
  }

  onScrubberPointerLeave(): void {
    if (this.scrubbing) return;
    this.hover_time = null;
    this.hover_segment = -1;
    this.paintHover(null);
  }

  onScrubberLostCapture(): void {
    if (!this.scrubbing) return;
    this.scrubbing = false;
    this.scrub_time = null;
    this.onScrubberPointerLeave();
  }

  // Keeps the tooltip inside the scrubber, using the width it had last time.
  private tooltipLeft(offset: number): number {
    const width = this.scrubber?.nativeElement.clientWidth ?? 0;
    const half = (this.scrubTooltip?.nativeElement.offsetWidth ?? 0) / 2;
    if (width <= 0) return offset;
    return Math.min(Math.max(offset, half), Math.max(width - half, half));
  }

  private scrubTo(client_x: number, final = false): void {
    const time = this.timeAt(client_x);
    this.scrub_time = time;
    this.paintProgress(time);
    this.seekTo(time, !final);
  }

  // During a drag a seek is made only once the last has landed, so they do not pile up.
  seekTo(time: number, dragging = false): void {
    const target = Math.min(Math.max(time, 0), this.duration || 0);
    if (dragging && this.media.seeking) {
      this.pending_seek = target;
      return;
    }
    this.pending_seek = null;
    this.media.currentTime = target;
    this.current_time = target;
    this.paintProgress(target);
  }

  seekBy(seconds: number, flash = false): void {
    if (this.duration <= 0) return;
    this.seekTo(this.media.currentTime + seconds);
    if (flash) {
      const icon = seconds < 0
        ? (Math.abs(seconds) >= SEEK_JUMP_SECONDS ? 'replay_10' : 'replay_5')
        : (seconds >= SEEK_JUMP_SECONDS ? 'forward_10' : 'forward_5');
      this.showFlash(icon);
    }
  }

  // Buttons

  togglePlay(flash = false): void {
    if (this.media.paused || this.media.ended) {
      this.playMedia();
      if (flash) this.showFlash('play_arrow');
    } else {
      this.media.pause();
      if (flash) this.showFlash('pause');
    }
  }

  private playMedia(): void {
    // A rejected play() (such as the file failing to load) needs no handling here.
    this.media.play()?.catch(() => undefined);
  }

  toggleMute(flash = false): void {
    if (this.media.muted || this.media.volume === 0) {
      this.media.muted = false;
      if (this.media.volume === 0) this.media.volume = this.volume_before_mute || 1;
    } else {
      this.volume_before_mute = this.media.volume;
      this.media.muted = true;
    }
    if (flash) this.showFlash(this.media.muted ? 'volume_off' : 'volume_up');
  }

  setVolume(value: number): void {
    if (!Number.isFinite(value)) return;
    this.media.volume = Math.min(Math.max(value, 0), 1);
    this.media.muted = this.media.volume === 0;
    if (this.media.volume > 0) this.volume_before_mute = this.media.volume;
  }

  private stepVolume(delta: number): void {
    const from = this.media.muted ? 0 : this.media.volume;
    this.setVolume(Math.round((from + delta) * 100) / 100);
    this.showFlash(this.media.volume === 0 ? 'volume_off' : (this.media.volume < 0.5 ? 'volume_down' : 'volume_up'),
      `${Math.round(this.media.volume * 100)}%`);
  }

  setRate(rate: number): void {
    this.media.playbackRate = rate;
    this.setMenu(null);
  }

  private stepRate(direction: 1 | -1): void {
    const index = PLAYBACK_RATES.indexOf(this.media.playbackRate);
    const from = index >= 0 ? index : PLAYBACK_RATES.indexOf(1);
    const next = PLAYBACK_RATES[Math.min(Math.max(from + direction, 0), PLAYBACK_RATES.length - 1)];
    this.media.playbackRate = next;
    this.showFlash('speed', `${next}x`);
  }

  toggleMenu(menu: Menu, event: MouseEvent): void {
    event.stopPropagation();
    this.setMenu(this.menu === menu ? null : menu);
  }

  private setMenu(menu: Menu | null): void {
    this.menu = menu;
    this.cdr.markForCheck();
  }

  jumpToSegment(segment: ScrubSegment): void {
    this.seekTo(segment.start);
    this.setMenu(null);
  }

  toggleFullscreen(): void {
    if (document.fullscreenElement) {
      document.exitFullscreen?.()?.catch(() => undefined);
      return;
    }
    const target = this.host.nativeElement.parentElement;
    if (target?.requestFullscreen) {
      target.requestFullscreen().catch(() => undefined);
      return;
    }
    // The iPhone only lets the video itself go fullscreen, in its own player.
    (this.media as HTMLVideoElement & {webkitEnterFullscreen?: () => void}).webkitEnterFullscreen?.();
  }

  togglePictureInPicture(): void {
    if (document.pictureInPictureElement) {
      document.exitPictureInPicture().catch(() => undefined);
    } else {
      this.media.requestPictureInPicture().catch(() => undefined);
    }
  }

  // Casting

  cast(): void {
    // The button says it is getting the file ready already.
    if (this.castSource === 'preparing') return;
    // Once connected, the browser's own picker is where the cast is stopped or moved.
    if (this.cast_state !== 'disconnected' || (this.castSource === 'ready' && this.cast_source_available)) {
      this.promptCast();
      return;
    }
    this.cast_requested_at = Date.now();
    this.prepareCast.emit({transcode: !this.cast_source_available});
  }

  // The player has swapped in the source the button asked for. The click still counts for
  // opening the picker for a few seconds; after that it takes another.
  private onCastSourceChange(): void {
    if (this.castSource === 'preparing') return;
    const requested_at = this.cast_requested_at;
    this.cast_requested_at = null;
    if (this.castSource !== 'ready' || requested_at === null) return;
    if (Date.now() - requested_at <= CAST_PROMPT_WINDOW_MS) this.promptCast();
    else this.showFlash('cast', this.castReadyLabel);
  }

  private promptCast(): void {
    attempt(() => this.media.remote.prompt()).catch((error: DOMException) => this.zone.run(() => {
      // Closing the picker, or not picking anything, is not a failure.
      if (error?.name === 'NotSupportedError') this.showFlash('cast', this.castUnsupportedLabel);
      // The click that asked for the swap no longer counts, so the next one opens the picker.
      if (error?.name === 'InvalidAccessError') this.showFlash('cast', this.castReadyLabel);
    }));
  }

  private attachCast(media: HTMLVideoElement): void {
    const remote = media.remote;
    this.cast_supported = typeof remote?.watchAvailability === 'function' && !media.disableRemotePlayback;
    if (!this.cast_supported) return;
    this.cast_state = remote.state;
    for (const type of CAST_EVENTS) remote.addEventListener(type, this.onCastStateChange);
    this.watchCastAvailability();
    this.startCastProbe();
  }

  private detachCast(media: HTMLVideoElement): void {
    const remote = media.remote;
    if (typeof remote?.watchAvailability !== 'function') return;
    for (const type of CAST_EVENTS) remote.removeEventListener(type, this.onCastStateChange);
    if (this.cast_watch !== null) attempt(() => remote.cancelWatchAvailability(this.cast_watch)).catch(() => undefined);
    this.cast_watch = null;
    this.cast_source_available = false;
    this.cast_state = 'disconnected';
    this.stopCastProbe();
  }

  // Called again after a session ends, since a page can only end one by switching the API off,
  // and that drops every watch.
  private watchCastAvailability(): void {
    const remote = this.media.remote;
    if (this.cast_watch !== null) attempt(() => remote.cancelWatchAvailability(this.cast_watch)).catch(() => undefined);
    this.cast_watch = null;
    attempt(() => remote.watchAvailability(available => this.zone.run(() => {
      this.cast_source_available = available;
      this.cdr.markForCheck();
    }))).then(id => {
      this.cast_watch = id;
    }, (error: DOMException) => this.zone.run(() => {
      // A browser that cannot look for devices in the background, as on low-end Android phones,
      // still finds them once its picker is open.
      if (error?.name === 'NotSupportedError') this.cast_source_available = true;
      this.cdr.markForCheck();
    }));
  }

  private readonly onCastStateChange = (): void => {
    this.cast_state = this.media.remote.state;
    if (this.cast_state === 'disconnected') this.watchCastAvailability();
    this.cdr.markForCheck();
  };

  protected createCastProbe(): HTMLVideoElement {
    const probe = document.createElement('video');
    probe.muted = true;
    probe.preload = 'metadata';
    probe.src = CAST_PROBE_SRC;
    return probe;
  }

  private startCastProbe(): void {
    if (this.cast_probe) return;
    const probe = this.createCastProbe();
    if (typeof probe.remote?.watchAvailability !== 'function') return;
    this.cast_probe = probe;
    attempt(() => probe.remote.watchAvailability(available => this.zone.run(() => {
      this.cast_device_available = available;
      this.cdr.markForCheck();
    }))).then(id => {
      if (this.cast_probe === probe) this.cast_probe_watch = id;
      else attempt(() => probe.remote.cancelWatchAvailability(id)).catch(() => undefined);
    }, () => undefined);
  }

  private stopCastProbe(): void {
    const probe = this.cast_probe;
    if (!probe) return;
    this.cast_probe = null;
    if (this.cast_probe_watch !== null) attempt(() => probe.remote.cancelWatchAvailability(this.cast_probe_watch)).catch(() => undefined);
    this.cast_probe_watch = null;
    this.cast_device_available = false;
    probe.removeAttribute('src');
    probe.load();
  }

  @HostListener('document:fullscreenchange')
  onFullscreenChange(): void {
    this.fullscreen = !!document.fullscreenElement && document.fullscreenElement === this.host.nativeElement.parentElement;
    this.cdr.markForCheck();
  }

  @HostListener('document:pointerdown', ['$event'])
  onDocumentPointerDown(event: PointerEvent): void {
    if (!this.menu) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest('.controls-menu, .menu-button')) return;
    this.setMenu(null);
  }

  private showFlash(icon: string, label: string | null = null): void {
    this.flash = {icon, label};
    this.flash_id += 1;
    if (this.flash_timer) clearTimeout(this.flash_timer);
    this.flash_timer = setTimeout(() => {
      this.flash_timer = null;
      this.flash = null;
      this.cdr.markForCheck();
    }, FLASH_DURATION_MS);
    this.cdr.markForCheck();
  }

  // Keyboard shortcuts, as video players commonly bind them.
  @HostListener('document:keydown', ['$event'])
  onKeydown(event: KeyboardEvent): void {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target as HTMLElement | null;
    if (this.menu && event.key === 'Escape') {
      this.setMenu(null);
      return;
    }
    if (target?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"]), .cdk-overlay-container')) return;
    const on_button = !!target?.closest?.('button, a, [role="button"], [role="menuitemradio"]');
    const in_player = !!target && !!this.host.nativeElement.parentElement?.contains(target);
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;

    switch (key) {
      case ' ':
        // Space on a button presses that button.
        if (on_button) return;
        this.togglePlay(true);
        break;
      case 'k':
        this.togglePlay(true);
        break;
      case 'ArrowLeft':
        this.seekBy(-SEEK_STEP_SECONDS, true);
        break;
      case 'ArrowRight':
        this.seekBy(SEEK_STEP_SECONDS, true);
        break;
      case 'j':
        this.seekBy(-SEEK_JUMP_SECONDS, true);
        break;
      case 'l':
        this.seekBy(SEEK_JUMP_SECONDS, true);
        break;
      case 'ArrowUp':
      case 'ArrowDown':
        // Anywhere else on the page these scroll it.
        if (!in_player) return;
        this.stepVolume(key === 'ArrowUp' ? VOLUME_STEP : -VOLUME_STEP);
        break;
      case 'm':
        this.toggleMute(true);
        break;
      case 'f':
        this.toggleFullscreen();
        break;
      case 'c':
        if (!this.subtitlesAvailable) return;
        this.toggleSubtitles.emit();
        this.showFlash(this.subtitlesEnabled ? 'closed_caption_off' : 'closed_caption');
        break;
      case 't':
        if (!this.theaterAvailable || this.fullscreen) return;
        this.toggleTheater.emit();
        break;
      case 'n':
        if (!event.shiftKey || !this.hasNext) return;
        this.playNext.emit();
        break;
      case '<':
      case '>':
        this.stepRate(key === '>' ? 1 : -1);
        break;
      default:
        if (/^[0-9]$/.test(key) && this.duration > 0) {
          this.seekTo(this.duration * Number(key) / 10);
          break;
        }
        return;
    }
    event.preventDefault();
    this.poke();
  }
}
