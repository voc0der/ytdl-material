import { ComponentFixture, TestBed, fakeAsync, tick } from '@angular/core/testing';
import { configureTestBed } from '../../../testing/test-bed';
import { MediaControlsComponent, formatMediaTime } from './media-controls.component';

// Enough of a media element for the controls: the state they read, and the events that say it
// changed.
class FakeMedia extends EventTarget {
  paused = true;
  ended = false;
  seeking = false;
  currentTime = 0;
  duration = 60;
  volume = 1;
  muted = false;
  playbackRate = 1;
  readyState = 4;
  error: MediaError | null = null;
  currentSrc = '/stream/a';
  disablePictureInPicture = false;
  buffered = {length: 1, start: () => 0, end: () => 30};
  play = vi.fn().mockName('play').mockImplementation(() => {
    this.paused = false;
    this.ended = false;
    this.dispatchEvent(new Event('play'));
    return Promise.resolve();
  });
  pause = vi.fn().mockName('pause').mockImplementation(() => {
    this.paused = true;
    this.dispatchEvent(new Event('pause'));
  });
}

describe('MediaControlsComponent', () => {
  let fixture: ComponentFixture<MediaControlsComponent>;
  let component: MediaControlsComponent;
  let media: FakeMedia;
  // Stands in for the player element the controls sit in, which is what goes full screen and what
  // counts as inside the player.
  let player: HTMLElement;

  beforeEach(async () => {
    configureTestBed({imports: [MediaControlsComponent]});
    await TestBed.compileComponents();
    media = new FakeMedia();
    fixture = TestBed.createComponent(MediaControlsComponent);
    component = fixture.componentInstance;
    player = document.createElement('div');
    document.body.appendChild(player);
    player.appendChild(fixture.nativeElement);
    fixture.componentRef.setInput('media', media as unknown as HTMLVideoElement);
    fixture.detectChanges();
  });

  afterEach(() => {
    player.remove();
  });

  const host = (): HTMLElement => fixture.nativeElement;
  const surface = (): HTMLElement => host().querySelector('.surface');
  const button = (label: string): HTMLButtonElement =>
    Array.from(host().querySelectorAll<HTMLButtonElement>('button')).find(candidate => candidate.getAttribute('aria-label') === label);

  function press(pointerType = 'mouse', init: PointerEventInit = {}): void {
    surface().dispatchEvent(new PointerEvent('pointerdown', {pointerType, button: 0, isPrimary: true, clientX: 100, clientY: 100, bubbles: true, ...init}));
  }

  function release(): void {
    window.dispatchEvent(new Event('pointerup'));
  }

  function key(value: string, target: EventTarget = document.body, init: KeyboardEventInit = {}): KeyboardEvent {
    const event = new KeyboardEvent('keydown', {key: value, bubbles: true, cancelable: true, ...init});
    target.dispatchEvent(event);
    fixture.detectChanges();
    return event;
  }

  function startPlaying(): void {
    media.play();
    fixture.detectChanges();
  }

  it('formats times the way the rest of the player does', () => {
    expect(formatMediaTime(0)).toBe('0:00');
    expect(formatMediaTime(65.9)).toBe('1:05');
    expect(formatMediaTime(3725)).toBe('1:02:05');
    expect(formatMediaTime(Number.NaN)).toBe('0:00');
  });

  describe('the picture', () => {
    it('pauses and plays on a click', fakeAsync(() => {
      startPlaying();
      press();
      release();
      surface().click();
      expect(media.pause).toHaveBeenCalled();
      expect(media.paused).toBe(true);

      tick();
      press();
      release();
      surface().click();
      expect(media.paused).toBe(false);
      tick(3000);
    }));

    it('only shows the controls on a tap, since a finger cannot hover', fakeAsync(() => {
      startPlaying();
      tick(3000);
      fixture.detectChanges();
      expect(host().classList.contains('controls-visible')).toBe(false);

      press('touch');
      release();
      surface().click();
      fixture.detectChanges();
      expect(media.pause).not.toHaveBeenCalled();
      expect(host().classList.contains('controls-visible')).toBe(true);
      tick(3000);
    }));

    it('plays at 2x while held, then goes back to the old rate without the release pausing it', fakeAsync(() => {
      startPlaying();
      media.playbackRate = 1.5;
      press();
      tick(399);
      expect(media.playbackRate).toBe(1.5);

      tick(1);
      fixture.detectChanges();
      expect(media.playbackRate).toBe(2);
      expect(host().querySelector('.speed-hold-badge')?.textContent).toContain('2x');

      release();
      fixture.detectChanges();
      expect(media.playbackRate).toBe(1.5);
      expect(host().querySelector('.speed-hold-badge')).toBeNull();
      // The click that comes with the release is not a request to pause.
      surface().click();
      expect(media.paused).toBe(false);
      tick();
      tick(3000);
    }));

    it('plays a paused video while held and pauses it again on release', fakeAsync(() => {
      press();
      tick(400);
      expect(media.paused).toBe(false);
      release();
      expect(media.paused).toBe(true);
      tick();
      tick(3000);
    }));

    it('leaves a short press as a click', fakeAsync(() => {
      startPlaying();
      press();
      tick(100);
      release();
      tick(1000);
      expect(media.playbackRate).toBe(1);
      expect(component.speed_hold_active).toBe(false);
      tick(3000);
    }));

    it('treats a press that drifts before the hold engages as a drag', fakeAsync(() => {
      startPlaying();
      press();
      window.dispatchEvent(new MouseEvent('pointermove', {clientX: 130, clientY: 100}));
      tick(1000);
      expect(media.playbackRate).toBe(1);
      tick(3000);
    }));

    it('leaves the next file alone when the hold outlasts the one it started on', fakeAsync(() => {
      media.playbackRate = 1.5;
      press();
      tick(400);
      media.currentSrc = '/stream/b';
      media.playbackRate = 1;
      release();
      expect(media.playbackRate).toBe(1);
      expect(media.pause).not.toHaveBeenCalled();
      tick();
      tick(3000);
    }));
  });

  describe('showing the controls', () => {
    it('keeps them up while paused', fakeAsync(() => {
      tick(5000);
      fixture.detectChanges();
      expect(host().classList.contains('controls-visible')).toBe(true);
    }));

    it('hides them a while after playback starts, and brings them back when the mouse moves', fakeAsync(() => {
      startPlaying();
      expect(host().classList.contains('controls-visible')).toBe(true);
      tick(2500);
      fixture.detectChanges();
      expect(host().classList.contains('controls-visible')).toBe(false);

      host().dispatchEvent(new PointerEvent('pointermove', {pointerType: 'mouse', bubbles: true}));
      fixture.detectChanges();
      expect(host().classList.contains('controls-visible')).toBe(true);
      tick(2500);
    }));
  });

  describe('the bar', () => {
    it('lays one scrubber segment per chapter over the whole file', () => {
      fixture.componentRef.setInput('chapters', [
        {title: 'Intro', start_time: 0, end_time: 10},
        {title: 'Middle', start_time: 12, end_time: 40},
        {title: 'End', start_time: 40, end_time: 55}
      ]);
      fixture.detectChanges();

      expect(component.segments).toEqual([
        {start: 0, end: 12, title: 'Intro'},
        {start: 12, end: 40, title: 'Middle'},
        {start: 40, end: 60, title: 'End'}
      ]);
      expect(host().querySelectorAll('.segment').length).toBe(3);
      media.currentTime = 20;
      media.dispatchEvent(new Event('timeupdate'));
      fixture.detectChanges();
      expect(host().querySelector('.chapter-title')?.textContent).toBe('Middle');
    });

    it('seeks where the scrubber is pressed', () => {
      const segment = host().querySelector<HTMLElement>('.segment');
      vi.spyOn(segment, 'getBoundingClientRect').mockReturnValue({left: 0, right: 200, width: 200} as DOMRect);
      const scrubber = host().querySelector<HTMLElement>('.scrubber');
      scrubber.dispatchEvent(new PointerEvent('pointerdown', {button: 0, clientX: 50, bubbles: true}));
      scrubber.dispatchEvent(new PointerEvent('pointerup', {button: 0, clientX: 150, bubbles: true}));
      expect(media.currentTime).toBe(45);
      expect(component.scrubbing).toBe(false);
    });

    it('sets the speed from its menu, and says so on the button', () => {
      button('Playback speed').click();
      fixture.detectChanges();
      const option = Array.from(host().querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'))
        .find(item => item.textContent.trim() === '1.5x');
      option.click();
      media.dispatchEvent(new Event('ratechange'));
      fixture.detectChanges();

      expect(media.playbackRate).toBe(1.5);
      expect(host().querySelector('.controls-menu')).toBeNull();
      expect(host().querySelector('.rate-badge')?.textContent).toBe('1.5x');
    });

    it('mutes and unmutes', () => {
      button('Mute').click();
      media.dispatchEvent(new Event('volumechange'));
      fixture.detectChanges();
      expect(media.muted).toBe(true);
      button('Unmute').click();
      expect(media.muted).toBe(false);
    });

    it('offers subtitles, theater mode and the next file only when there are any', () => {
      expect(button('Subtitles')).toBeUndefined();
      expect(button('Theater mode')).toBeUndefined();
      expect(button('Next')).toBeUndefined();

      fixture.componentRef.setInput('subtitlesAvailable', true);
      fixture.componentRef.setInput('theaterAvailable', true);
      fixture.componentRef.setInput('hasNext', true);
      fixture.detectChanges();
      const emitted: string[] = [];
      component.toggleSubtitles.subscribe(() => emitted.push('subtitles'));
      component.toggleTheater.subscribe(() => emitted.push('theater'));
      component.playNext.subscribe(() => emitted.push('next'));
      button('Subtitles').click();
      button('Theater mode').click();
      button('Next').click();
      expect(emitted).toEqual(['subtitles', 'theater', 'next']);
    });

    it('takes the whole player full screen, not only the video', () => {
      const request = vi.fn().mockName('requestFullscreen').mockResolvedValue(undefined);
      player.requestFullscreen = request;
      button('Full screen').click();
      expect(request).toHaveBeenCalled();
    });
  });

  describe('the keyboard', () => {
    it('plays and pauses with k and space', () => {
      key('k');
      expect(media.paused).toBe(false);
      expect(key(' ').defaultPrevented).toBe(true);
      expect(media.paused).toBe(true);
    });

    it('seeks with the arrows and j and l', () => {
      media.currentTime = 20;
      key('ArrowRight');
      expect(media.currentTime).toBe(25);
      key('j');
      expect(media.currentTime).toBe(15);
      key('5');
      expect(media.currentTime).toBe(30);
    });

    it('mutes with m and steps the speed with < and >', () => {
      key('m');
      expect(media.muted).toBe(true);
      key('>');
      expect(media.playbackRate).toBe(1.25);
      key('<');
      key('<');
      expect(media.playbackRate).toBe(0.75);
    });

    it('changes the volume with up and down only inside the player, so the page still scrolls', () => {
      const event = key('ArrowDown');
      expect(media.volume).toBe(1);
      expect(event.defaultPrevented).toBe(false);

      host().querySelector<HTMLElement>('.scrubber').focus();
      key('ArrowDown', host().querySelector('.scrubber'));
      expect(media.volume).toBe(0.95);
    });

    it('leaves typing, and space on a button, alone', () => {
      const input = document.createElement('input');
      document.body.appendChild(input);
      key('k', input);
      expect(media.play).not.toHaveBeenCalled();
      input.remove();

      key(' ', button('Play'));
      expect(media.play).not.toHaveBeenCalled();
      key('k', document.body, {ctrlKey: true});
      expect(media.play).not.toHaveBeenCalled();
    });
  });

  describe('casting', () => {
    // The Remote Playback API as Chrome has it: devices come and go through the availability
    // callbacks, and a session through its state.
    class FakeRemote extends EventTarget {
      state: RemotePlaybackState = 'disconnected';
      private callbacks = new Map<number, (available: boolean) => void>();
      private next_id = 1;
      watchAvailability = vi.fn().mockName('watchAvailability').mockImplementation((callback: (available: boolean) => void) => {
        const id = this.next_id++;
        this.callbacks.set(id, callback);
        return Promise.resolve(id);
      });
      cancelWatchAvailability = vi.fn().mockName('cancelWatchAvailability').mockImplementation((id: number) => {
        this.callbacks.delete(id);
        return Promise.resolve();
      });
      prompt = vi.fn().mockName('prompt').mockResolvedValue(undefined);

      setAvailable(available: boolean): void {
        this.callbacks.forEach(callback => callback(available));
      }

      setState(state: RemotePlaybackState, type: string): void {
        this.state = state;
        this.dispatchEvent(new Event(type));
      }
    }

    let remote: FakeRemote;
    // Stands in for the H.264 clip the controls watch to find a device the file cannot go to.
    let probe_remote: FakeRemote;

    beforeEach(() => {
      remote = new FakeRemote();
      probe_remote = new FakeRemote();
      vi.spyOn(component as any, 'createCastProbe').mockReturnValue({
        remote: probe_remote,
        removeAttribute: vi.fn(),
        load: vi.fn()
      });
      const castable = new FakeMedia();
      (castable as any).remote = remote;
      fixture.componentRef.setInput('media', castable as unknown as HTMLVideoElement);
      fixture.detectChanges();
    });

    const castButton = (): HTMLButtonElement => host().querySelector('.cast-button');

    function devices(file: boolean, copy = file): void {
      remote.setAvailable(file);
      probe_remote.setAvailable(copy);
      fixture.detectChanges();
    }

    function source(value: string): void {
      fixture.componentRef.setInput('castSource', value);
      fixture.detectChanges();
    }

    it('offers nothing where the browser has no Remote Playback API, as in Firefox', () => {
      fixture.componentRef.setInput('media', new FakeMedia() as unknown as HTMLVideoElement);
      fixture.detectChanges();
      expect(castButton()).toBeNull();
    });

    it('shows the button only while a device is around, and opens the browser\'s picker', () => {
      expect(castButton()).toBeNull();
      devices(true);
      expect(castButton().getAttribute('aria-label')).toBe('Cast');

      castButton().click();
      expect(remote.prompt).toHaveBeenCalled();

      devices(false);
      expect(castButton()).toBeNull();
    });

    it('asks the player for a link first when the URL carries the login, then opens the picker', () => {
      const requests: unknown[] = [];
      component.prepareCast.subscribe(request => requests.push(request));
      source('needs-link');
      devices(true);

      castButton().click();
      expect(requests).toEqual([{transcode: false}]);
      expect(remote.prompt).not.toHaveBeenCalled();

      source('preparing');
      expect(castButton().getAttribute('aria-label')).toBe('Getting the file ready to cast');
      expect(castButton().classList).toContain('pending');
      castButton().click();
      expect(requests.length).toBe(1);

      source('ready');
      expect(remote.prompt).toHaveBeenCalledTimes(1);
    });

    it('asks for the H.264 copy when the device around cannot play the file as it is', () => {
      const requests: unknown[] = [];
      component.prepareCast.subscribe(request => requests.push(request));
      devices(false, true);

      castButton().click();
      expect(requests).toEqual([{transcode: true}]);
      expect(remote.prompt).not.toHaveBeenCalled();
    });

    it('leaves the picker to a second click once the click that asked is too old to open it', () => {
      const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
      source('needs-link');
      devices(true);
      castButton().click();
      source('preparing');

      now.mockReturnValue(1000 + 60000);
      source('ready');
      expect(remote.prompt).not.toHaveBeenCalled();
      expect(host().querySelector('.flash-label').textContent).toBe('Ready to cast');

      castButton().click();
      expect(remote.prompt).toHaveBeenCalled();
    });

    it('says when it is casting, and opens the picker to stop it', () => {
      devices(true);
      remote.setState('connected', 'connect');
      fixture.detectChanges();
      expect(castButton().getAttribute('aria-label')).toBe('Casting');
      expect(castButton().getAttribute('aria-pressed')).toBe('true');
      expect(castButton().querySelector('mat-icon').textContent).toBe('cast_connected');

      castButton().click();
      expect(remote.prompt).toHaveBeenCalled();
    });

    it('watches for devices again once a session ends, since ending one drops the watch', () => {
      devices(true);
      remote.setState('connected', 'connect');
      const watches = remote.watchAvailability.mock.calls.length;
      remote.setState('disconnected', 'disconnect');
      expect(remote.watchAvailability.mock.calls.length).toBe(watches + 1);
    });

    it('hides the button for a file that cannot be cast', () => {
      devices(true);
      source('unavailable');
      expect(castButton()).toBeNull();
    });

    it('stops watching when the video goes', () => {
      component.ngOnDestroy();
      expect(remote.cancelWatchAvailability).toHaveBeenCalled();
      expect(probe_remote.cancelWatchAvailability).toHaveBeenCalled();
    });
  });
});
