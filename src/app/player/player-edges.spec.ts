import { ChangeDetectorRef, NgZone } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import { ActivatedRoute, Router, convertToParamMap } from '@angular/router';
import { BehaviorSubject, of, Subject, throwError } from 'rxjs';
import { DatabaseFile } from '../../api-types';
import { PostsService } from '../posts.services';
import { IMedia, PlayerComponent } from './player.component';

// The player's quieter paths: a queue handed over from another tab, failures it recovers from,
// and what it keeps per file while moving through a queue. Built without a template.
describe('Player edges', () => {
  let component: PlayerComponent;
  let posts: any;
  let media: any;
  const item = (uid: string, fields: Partial<IMedia> = {}): IMedia =>
    ({ uid, title: uid, label: uid, src: `/${uid}`, type: 'video/mp4', url: `/${uid}`, ...fields });

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    posts = {
      path: '/api/', initialized: true, isLoggedIn: false, hasPermission: () => true, setPageTitle: vi.fn(), openSnackBar: vi.fn(),
      config: { Downloader: { 'path-audio': 'audio', 'path-video': 'video' }, Subscriptions: { subscriptions_base_path: 'subscriptions' } },
      service_initialized: new Subject<boolean>(),
      auto_theater: new BehaviorSubject(false),
      incrementViewCount: vi.fn().mockReturnValue(of({ success: true })),
      getFile: vi.fn().mockReturnValue(of({ file: {} })),
      getAllFiles: vi.fn()
    };
    const route = { snapshot: { queryParamMap: convertToParamMap({}) } } as unknown as ActivatedRoute;
    const router = { navigate: vi.fn(), currentNavigation: () => null } as unknown as Router;
    component = new PlayerComponent(posts as PostsService, route, { open: vi.fn() } as unknown as MatDialog, router,
      { detectChanges: vi.fn() } as unknown as ChangeDetectorRef, { run: fn => fn(), runOutsideAngular: fn => fn() } as NgZone);
    media = { currentTime: 0, duration: 120, readyState: 0, paused: true, pause: vi.fn(), play: vi.fn().mockResolvedValue(undefined),
      load: vi.fn(), removeAttribute: vi.fn(), querySelectorAll: () => [] };
    component.mediaElement = { nativeElement: media };
    component.uid = 'clip';
    component.currentItem = item('clip');
    component.playlist = [component.currentItem];
  });

  afterEach(() => {
    component.ngOnDestroy();
    sessionStorage.clear();
    window.history.replaceState(null, '');
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('keeps a queue handed over from another tab in this tab\'s history, and reads the settings once they arrive', () => {
    sessionStorage.setItem('playerQueueForNewTab', JSON.stringify({ url: window.location.href, queue: { queue_sort_by: 'title' } }));
    posts.initialized = false;
    const process = vi.spyOn(component, 'processConfig').mockImplementation(() => {});

    component.ngOnInit();

    expect(window.history.state.playerQueue).toEqual({ queue_sort_by: 'title' });
    expect(component.queue_sort_by).toBe('title');
    expect(process).not.toHaveBeenCalled();
    posts.service_initialized.next(false);
    posts.service_initialized.next(true);
    expect(process).toHaveBeenCalledTimes(1);
  });

  it('loads a subscription\'s files when opened from one', () => {
    component.uid = null;
    component.sub_id = 'sub';
    const load = vi.spyOn(component, 'getSubscription').mockImplementation(() => {});
    component.processConfig();
    expect(load).toHaveBeenCalled();
  });

  it('lets a view be counted again when counting it failed', () => {
    posts.incrementViewCount.mockReturnValue(throwError(() => new Error('offline')));
    component.onPlaybackStarted();
    expect((component as any).counted_view_uid).toBeNull();
    expect(console.error).toHaveBeenCalledWith('Failed to increment view count', expect.any(Error));
  });

  it('stops at the end of a video with autoplay off, and goes straight on to a next one when there is one', () => {
    component.repeat_enabled = false;
    component.autoplay_enabled = false;
    const advance = vi.spyOn(component, 'advanceToNextVideo').mockReturnValue(true);
    const load_queue = vi.spyOn(component, 'ensureAutoplayQueueReady');

    component.nextVideo();
    expect(advance).not.toHaveBeenCalled();

    component.autoplay_enabled = true;
    component.nextVideo();
    expect(advance).toHaveBeenCalledTimes(1);
    expect(load_queue).not.toHaveBeenCalled();
  });

  describe('casting', () => {
    it('stops a cast going on to a file it may not hand over', () => {
      posts.isLoggedIn = true;
      component.library = 'bob';
      const stop = vi.spyOn(component as any, 'stopCasting').mockImplementation(() => {});
      (component as any).resetCastSource(true, '/previous');
      expect(stop).toHaveBeenCalled();
      expect(component.castSource).toBe('unavailable');
    });

    it('says so when the copy a cast device can play could not be made', async () => {
      posts.createPlaybackLink = vi.fn().mockReturnValue(of({ stream_path: 'stream?token=x', transcode: true, ready: false }));
      vi.spyOn(component as any, 'waitForTranscode').mockResolvedValue(false);
      const swap = vi.spyOn(component as any, 'swapCastSource');
      component.baseStreamPath = '/api/';

      await (component as any).requestCastSource(component.currentItem, true, (component as any).cast_token, true);

      expect(swap).not.toHaveBeenCalled();
      expect(component.castSource).toBe('ready');
      expect(posts.openSnackBar).toHaveBeenCalledWith('Couldn\'t make a copy of this file that your cast device can play.');
    });
  });

  describe('the autoplay queue', () => {
    it('goes back to the one file when autoplay is turned off', () => {
      component.autoplay_enabled = true;
      component.autoplay_queue_initialized = true;
      component.pending_autoplay_advance = true;
      component.playlist = [item('first'), component.currentItem, item('last')];
      component.currentIndex = 1;

      component.toggleAutoplay();

      expect(component.autoplay_enabled).toBe(false);
      expect(component.pending_autoplay_advance).toBe(false);
      expect(component.playlist).toEqual([component.currentItem]);
      expect(component.currentIndex).toBe(0);
      expect(component.autoplay_queue_initialized).toBe(false);
    });

    it('moves on to the next file once a queue it was waiting for arrives', () => {
      component.autoplay_enabled = true;
      component.pending_autoplay_advance = true;
      component.baseStreamPath = '/api/';
      posts.getAllFiles.mockReturnValue(of({ files: [{ uid: 'clip', title: 'Clip' }, { uid: 'next', title: 'Next' }] }));
      const advance = vi.spyOn(component, 'advanceToNextVideo').mockReturnValue(true);

      component.ensureAutoplayQueueReady();

      expect(component.pending_autoplay_advance).toBe(false);
      expect(advance).toHaveBeenCalledTimes(1);
    });

    it('finds the file playing among the queue\'s files', () => {
      const next = { uid: 'next', title: 'Next' } as DatabaseFile;
      component.db_file = { uid: 'clip' } as DatabaseFile;
      component.autoplay_queue_file_objs = [next];
      component.currentItem = item('next');
      component.syncCurrentFileMetadata();
      expect(component.currentFile).toBe(next);
    });

    it('fills in chapters and subtitles it already fetched for a file it comes back to', () => {
      const chapters = [{ title: 'Intro', start_time: 0, end_time: 5 }];
      const subtitles = [{ label: 'English', language: 'en', kind: 'subtitles', default: true, src: '/en.vtt' }] as any;
      (component as any).chapterCacheByUID.set('clip', chapters);
      (component as any).subtitleCacheByUID.set('clip', subtitles);

      component.syncCurrentSubtitles();
      component.syncCurrentChapters();

      expect(component.currentItem.chapters).toBe(chapters);
      expect(component.currentItem.subtitles).toBe(subtitles);
    });

    it('stores what it fetched for a file on that file in the queue too', () => {
      const queued = { uid: 'clip', title: 'Clip' } as any;
      component.autoplay_queue_file_objs = [queued];
      component.applyChaptersToMedia('clip', [{ title: 'Intro', start_time: 0, end_time: 5 }]);
      component.applySubtitlesToMedia('clip', [{ label: 'English', language: 'en', kind: 'subtitles', default: true, src: '/en.vtt' } as any]);
      expect(queued.chapters).toEqual([{ title: 'Intro', start_time: 0, end_time: 5 }]);
      expect(queued.subtitles).toEqual([{ label: 'English', language: 'en', kind: 'subtitles', default: true }]);
    });

    it('asks again for a file\'s chapters after asking failed', () => {
      posts.getFile.mockReturnValue(throwError(() => new Error('offline')));
      component.ensureCurrentItemPlaybackMetadataLoaded();
      expect((component as any).chapterLoadInFlight.has('clip')).toBe(false);
      component.ensureCurrentItemPlaybackMetadataLoaded();
      expect(posts.getFile).toHaveBeenCalledTimes(2);
    });
  });

  describe('subtitle tracks', () => {
    it('listens to one track list at a time', () => {
      const first = { length: 0, addEventListener: vi.fn(), removeEventListener: vi.fn() };
      media.textTracks = first;
      component.attachSubtitleTrackListener();
      media.textTracks = { length: 0, addEventListener: vi.fn(), removeEventListener: vi.fn() };
      component.attachSubtitleTrackListener();
      expect(first.removeEventListener).toHaveBeenCalledWith('addtrack', expect.any(Function));
    });

    it('shows the default track once, however often it is asked to, and not after the player is gone', () => {
      vi.useFakeTimers();
      const show = vi.spyOn(component, 'showDefaultSubtitleTrack').mockImplementation(() => {});
      component.scheduleDefaultSubtitleTrackActivation();
      component.scheduleDefaultSubtitleTrackActivation();
      vi.advanceTimersByTime(200);
      expect(show).toHaveBeenCalledTimes(1);

      component.scheduleDefaultSubtitleTrackActivation();
      component.ngOnDestroy();
      vi.advanceTimersByTime(200);
      expect(show).toHaveBeenCalledTimes(1);
    });

    it('does nothing more with the tracks once the player is gone', async () => {
      const attach = vi.spyOn(component, 'attachSubtitleTrackListener');
      component.refreshMediaSubtitleTracks();
      component.ngOnDestroy();
      await Promise.resolve();
      expect(attach).not.toHaveBeenCalled();
    });
  });

  it('leaves snip mode as it found it', () => {
    component.snip_mode = true;
    component.snip_in_progress = true;
    component.snip_percent = 40;
    component.exitSnipMode();
    expect([component.snip_mode, component.snip_in_progress, component.snip_percent]).toEqual([false, false, 0]);
  });

  it('plays when asked to from the controls', () => {
    const play = vi.spyOn(component, 'playVideo').mockImplementation(() => {});
    component.togglePlayback(true);
    expect(play).toHaveBeenCalled();
  });
});
