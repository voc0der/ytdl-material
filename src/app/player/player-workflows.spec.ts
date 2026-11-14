import { ChangeDetectorRef, NgZone } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import { ActivatedRoute, Router } from '@angular/router';
import { of, Subject, throwError } from 'rxjs';
import { DatabaseFile, Playlist } from '../../api-types';
import { PostsService } from '../posts.services';
import { PlayerComponent } from './player.component';


describe('Player workflows', () => {
  let component: PlayerComponent;
  let posts: any;
  let dialog: any;
  let media: any;
  let closed: Subject<any>;
  let dialogRef: any;
  let router: any;
  let saved: string[];
  const file = { uid: 'clip', title: 'Clip', duration: 120, isAudio: false } as DatabaseFile;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    saved = [];
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fixture');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function(this: HTMLAnchorElement) { saved.push(this.download); });
    posts = {
      path: '/api/', hasPermission: () => true, setPageTitle: vi.fn(), openSnackBar: vi.fn(),
      downloadFileFromServer: vi.fn(), downloadPlaylistFromServer: vi.fn(),
      snipFile: vi.fn().mockReturnValue(of({ success: true, job_uid: 'job' })),
      getSnipStatus: vi.fn().mockReturnValue(of({ success: true, status: 'snipping', percent: 10.6 })),
      getAllFiles: vi.fn(), getFile: vi.fn()
    };
    closed = new Subject();
    dialogRef = { afterClosed: () => closed, componentInstance: { file, sharing_enabled: true } };
    dialog = { open: vi.fn().mockReturnValue(dialogRef) };
    router = { navigate: vi.fn() };
    component = new PlayerComponent(posts as PostsService, {} as ActivatedRoute, dialog as MatDialog,
      router as Router, { detectChanges: vi.fn() } as unknown as ChangeDetectorRef,
      { run: fn => fn(), runOutsideAngular: fn => fn() } as NgZone);
    media = { currentTime: 12, duration: 120, pause: vi.fn(), play: vi.fn().mockResolvedValue(undefined),
      load: vi.fn(), removeAttribute: vi.fn(), querySelectorAll: () => [] };
    component.mediaElement = { nativeElement: media };
    component.uid = file.uid;
    component.db_file = { ...file };
    component.currentFile = component.db_file;
    component.currentItem = { uid: 'clip', title: 'Clip', label: 'Clip', src: '/clip', type: 'video/mp4', url: '/clip' };
    component.playlist = [component.currentItem];
  });

  afterEach(() => {
    component.ngOnDestroy();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('creates a snip, reports rounded progress, polls, and exits after completion', () => {
    component.playbackTime = 12;
    component.enterSnipMode();
    expect(component.snip_mode).toBe(true);
    expect([component.snip_start, component.snip_end]).toEqual([12, 42]);
    component.confirmSnip();
    expect(posts.snipFile).toHaveBeenCalledExactlyOnceWith('clip', 12, 42);
    expect(component.snip_in_progress).toBe(true);
    expect(component.snip_percent).toBe(11);
    expect(component.snip_poll_timer).not.toBeNull();
    posts.getSnipStatus.mockReturnValue(of({ success: true, status: 'complete', percent: 100 }));
    vi.runOnlyPendingTimers();
    expect(component.snip_mode).toBe(false);
    expect(component.snip_in_progress).toBe(false);
    expect(component.snip_poll_timer).toBeNull();
    expect(posts.openSnackBar).toHaveBeenCalledWith('Snip created successfully.');
  });

  for (const response of [{ success: false, error: 'Not permitted' }, { success: true }]) {
    it(`clears snip progress when creation returns ${JSON.stringify(response)}`, () => {
      component.snip_start = 2;
      component.snip_end = 5;
      posts.snipFile.mockReturnValue(of(response));
      component.confirmSnip();
      expect(component.snip_in_progress).toBe(false);
      expect(component.snip_percent).toBe(0);
      expect(posts.getSnipStatus).not.toHaveBeenCalled();
      expect(posts.openSnackBar).toHaveBeenCalledWith(response['error'] || 'Failed to snip video.');
    });
  }

  it('handles creation and polling transport errors without leaving work in progress', () => {
    posts.snipFile.mockReturnValue(throwError(() => new Error('offline')));
    component.snip_end = 10;
    component.confirmSnip();
    expect(component.snip_in_progress).toBe(false);
    component.snip_in_progress = true;
    posts.getSnipStatus.mockReturnValue(throwError(() => new Error('offline')));
    component.pollSnipStatus('job');
    expect(component.snip_in_progress).toBe(false);
    expect(component.snip_poll_timer).toBeNull();
    expect(posts.openSnackBar).toHaveBeenCalledTimes(2);
  });

  for (const response of [{ success: false, error: 'Missing job' }, { success: true, status: 'failed', error: 'Encoder failed' }]) {
    it(`shows the server's snip error: ${response.error}`, () => {
      component.snip_in_progress = true;
      posts.getSnipStatus.mockReturnValue(of(response));
      component.pollSnipStatus('job');
      expect(posts.openSnackBar).toHaveBeenCalledWith(response.error);
      expect(component.snip_in_progress).toBe(false);
      expect(component.snip_poll_timer).toBeNull();
    });
  }

  it('ignores late poll responses after the player is destroyed', () => {
    const result = new Subject<any>();
    posts.getSnipStatus.mockReturnValue(result);
    component.pollSnipStatus('job');
    component.ngOnDestroy();
    result.next({ success: true, status: 'complete' });
    expect(posts.openSnackBar).not.toHaveBeenCalled();
    expect(component.snip_poll_timer).toBeNull();
  });

  it('previews the selected range and guards invalid or duplicate submissions', () => {
    component.snip_start = 5;
    component.snip_end = 5;
    component.confirmSnip();
    component.previewSnip();
    expect(posts.snipFile).not.toHaveBeenCalled();
    expect(media.play).not.toHaveBeenCalled();
    component.snip_end = 10;
    component.previewSnip();
    expect(media.currentTime).toBe(5);
    expect(media.play).toHaveBeenCalledOnce();
    component.snip_in_progress = true;
    component.confirmSnip();
    expect(posts.snipFile).not.toHaveBeenCalled();
    component.snip_in_progress = false;
    component.currentFile = null;
    component.confirmSnip();
    expect(posts.snipFile).not.toHaveBeenCalled();
    expect(component.formatSnipTimestamp(3661.9)).toBe('1:01:01');
    expect(component.formatSnipTimestamp(-1)).toBe('0:00');
  });

  it('downloads the playing file with the correct name and resets after failure', () => {
    const blob = new Blob(['audio']);
    posts.downloadFileFromServer.mockReturnValue(of(blob));
    component.currentItem.type = 'audio/mp3';
    component.uuid = 'owner';
    component.downloadFile();
    expect(posts.downloadFileFromServer).toHaveBeenCalledWith('clip', 'owner');
    expect(saved).toEqual(['Clip.mp3']);
    expect(URL.createObjectURL).toHaveBeenCalledWith(blob);
    expect(component.downloading).toBe(false);
    posts.downloadFileFromServer.mockReturnValue(throwError(() => new Error('offline')));
    component.downloadFile();
    expect(component.downloading).toBe(false);
    expect(saved).toHaveLength(1);
  });

  it('waits for playlist confirmation, saves the zip and handles download failure', () => {
    const blob = new Blob(['zip']);
    component.db_playlist = { id: 'mix', name: 'Mix', uids: ['clip'] } as Playlist;
    component.playlist_id = 'mix';
    component.file_objs = [{ ...file, size: 2048 }];
    posts.downloadPlaylistFromServer.mockReturnValue(of(blob));
    component.downloadContent();
    expect(posts.downloadPlaylistFromServer).not.toHaveBeenCalled();
    expect(dialog.open.mock.lastCall[1].data.dialogText).toContain('1 files');
    closed.next(true);
    expect(saved).toEqual(['Mix.zip']);
    expect(component.downloading).toBe(false);
    const failed = new Subject<Blob>();
    posts.downloadPlaylistFromServer.mockReturnValue(failed);
    component.startPlaylistDownload();
    failed.error(new Error('offline'));
    expect(component.downloading).toBe(false);
    expect(component.playlistDownloadSubscription).toBeNull();
  });

  it('keeps the queue in place while sharing and editing its current file', () => {
    component.autoplay_queue_file_objs = [component.db_file];
    component.openShareDialog();
    expect(dialog.open.mock.lastCall[1].data.current_timestamp).toBe(12000);
    closed.next(undefined);
    expect(component.db_file.sharingEnabled).toBe(true);
    expect(component.playlist).toHaveLength(1);
    const updated = { ...file, title: 'Edited' };
    dialogRef.componentInstance.file = updated;
    dialogRef.componentInstance.snip_requested = true;
    component.openFileInfoDialog();
    closed.next(undefined);
    expect(component.currentFile).toBe(updated);
    expect(component.autoplay_queue_file_objs).toEqual([updated]);
    expect(component.snip_mode).toBe(true);
  });

  it('updates the original playlist entry after the info dialog closes', () => {
    component.db_file = null;
    component.db_playlist = { id: 'mix', name: 'Mix', uids: ['clip'] } as Playlist;
    component.playlist_id = 'mix';
    component.file_objs = [{ ...file }];
    component.openFileInfoDialog();
    expect(dialog.open.mock.lastCall[1].data.file).toBe(component.file_objs[0]);
    const updated = { ...file, title: 'Edited' };
    dialogRef.componentInstance.file = updated;
    closed.next(undefined);
    expect(component.file_objs).toEqual([updated]);
    expect(component.currentFile).toBe(updated);
    component.playlistPostCreationHandler('new-playlist');
    expect(router.navigate).toHaveBeenCalledWith(['/'], { queryParams: { playlist_id: 'new-playlist' } });
  });

  describe('loading what to play', () => {
    const video = (uid: string, extra = {}) => ({ uid, title: uid, isAudio: false, duration: 60, chapters: [], subtitles: [], ...extra }) as DatabaseFile;

    beforeEach(() => {
      component.baseStreamPath = '/api/';
      component.currentItem = null;
      component.playlist = [];
      component.db_file = null;
      component.uid = null;
    });

    it('queues every video in a subscription', () => {
      posts.getSubscription = vi.fn().mockReturnValue(of({ subscription: { type: 'video', videos: [video('first'), video('second')] } }));
      component.sub_id = 'sub';

      component.getSubscription();

      expect(posts.getSubscription).toHaveBeenCalledWith('sub');
      expect(component.type).toBe('video');
      expect(component.uids).toEqual(['first', 'second']);
      expect(component.playlist.map(item => item.uid)).toEqual(['first', 'second']);
      expect(component.playlist[0].src).toBe('/api/stream?uid=first&type=video&sub_id=sub');
      expect(component.currentFile.uid).toBe('first');
      expect(component.show_player).toBe(true);
    });

    it('names the subscription it could not find', () => {
      posts.getSubscription = vi.fn().mockReturnValue(throwError(() => new Error('not found')));
      component.sub_id = 'missing';

      component.getSubscription();

      expect(posts.openSnackBar).toHaveBeenCalledWith('Failed to find subscription missing', 'Dismiss');
      expect(component.show_player).toBe(false);
    });

    it('says so when a playlist or file cannot be loaded', () => {
      posts.getPlaylist = vi.fn().mockReturnValue(of({}));
      component.getPlaylistFiles();
      posts.getPlaylist.mockReturnValue(throwError(() => new Error('offline')));
      component.getPlaylistFiles();
      expect(posts.openSnackBar.mock.calls).toEqual([['Failed to load playlist!'], ['Failed to load playlist!']]);

      posts.openSnackBar.mockClear();
      posts.getFile.mockReturnValue(of({ file: null }));
      component.getFile();
      posts.getFile.mockReturnValue(throwError(() => new Error('offline')));
      component.getFile();
      expect(posts.openSnackBar.mock.calls).toEqual([
        ['Failed to get file information from the server.', 'Dismiss'],
        ['Failed to get file information from the server.', 'Dismiss']
      ]);
      expect(component.show_player).toBe(false);
    });

    it('streams a URL it was handed straight away', () => {
      posts.config = { Downloader: { 'path-audio': 'audio/', 'path-video': 'video/' }, Subscriptions: { subscriptions_base_path: 'subscriptions/' } };
      component.url = 'https://media.example.test/clip.mp4';
      component.name = 'Clip';

      component.processConfig();

      expect(component.playlist).toEqual([expect.objectContaining({ title: 'Clip', src: 'https://media.example.test/clip.mp4', type: 'video/mp4' })]);
      expect(component.currentItem).toBe(component.playlist[0]);
      expect(component.show_player).toBe(true);
    });

    it('plays a playlist marked for random order in a shuffled order', () => {
      const files = [video('a'), video('b'), video('c')];
      posts.getPlaylist = vi.fn().mockReturnValue(of({ playlist: { id: 'mix', uids: ['a', 'b', 'c'], randomize_order: true }, file_objs: files, type: 'video' }));
      component.playlist_id = 'mix';
      vi.spyOn(Math, 'random').mockReturnValue(0);

      component.getPlaylistFiles();

      // Always drawing the first remaining item moves each one up a place, last to the front.
      expect(component.playlist.map(item => item.uid)).toEqual(['b', 'c', 'a']);
      expect(component.playlist[0].src).toContain('&playlist_id=mix');
    });

    it('keeps only chapters with a title and a range that moves forward', () => {
      expect(component.normalizeChapters([
        { title: ' Intro ', start_time: 0, end_time: 30 },
        { title: 'Backwards', start_time: 40, end_time: 35 },
        { title: 'Before the start', start_time: -5, end_time: 5 },
        { title: '   ', start_time: 50, end_time: 60 },
        { title: 'Not a time', start_time: 'soon', end_time: 70 },
        { title: 'Outro', start_time: '90', end_time: '120' }
      ] as any)).toEqual([
        { title: 'Intro', start_time: 0, end_time: 30 },
        { title: 'Outro', start_time: 90, end_time: 120 }
      ]);
      expect(component.normalizeChapters(null)).toEqual([]);
    });
  });

  it('pauses and changes speed on the media element', () => {
    component.togglePlayback(false);
    component.setPlaybackRate(1.5);

    expect(media.pause).toHaveBeenCalledOnce();
    expect(media.playbackRate).toBe(1.5);
  });

  it('will not repeat a file while autoplay moves on to the next one', () => {
    localStorage.setItem('player_autoplay_enabled', 'true');
    localStorage.setItem('player_repeat_enabled', 'true');
    try {
      component.initPlaybackModeToggles();

      expect(component.autoplay_enabled).toBe(true);
      expect(component.repeat_enabled).toBe(false);
      expect(localStorage.getItem('player_repeat_enabled')).toBe('false');
    } finally {
      localStorage.removeItem('player_autoplay_enabled');
      localStorage.removeItem('player_repeat_enabled');
    }
  });

  it('asks for subtitles with whatever authorizes playing the file', () => {
    component.baseStreamPath = '/api';
    component.uuid = 'owner';
    component.library = 'shared lib';
    component.sub_id = 'sub';
    expect(component.createSubtitleTrackURL('a b', 2)).toBe('/api/streamSubtitle?uid=a%20b&index=2&uuid=owner&library=shared%20lib&sub_id=sub');

    component.sub_id = null;
    component.playlist_id = 'mix';
    expect(component.createSubtitleTrackURL('clip')).toBe('/api/streamSubtitle?uid=clip&index=0&uuid=owner&library=shared%20lib&playlist_id=mix');
  });

  it('clears a pending autoplay advance when loading fails or autoplay was turned off', () => {
    const result = new Subject<any>();
    posts.getAllFiles.mockReturnValue(result);
    component.autoplay_enabled = true;
    component.nextVideo();
    expect(component.pending_autoplay_advance).toBe(true);
    expect(component.autoplay_queue_loading).toBe(true);
    result.error(new Error('offline'));
    expect(component.pending_autoplay_advance).toBe(false);
    expect(component.autoplay_queue_loading).toBe(false);
    posts.getAllFiles.mockReturnValue(of({ files: [file] }));
    component.autoplay_enabled = false;
    component.pending_autoplay_advance = true;
    component.ensureAutoplayQueueReady();
    expect(component.pending_autoplay_advance).toBe(false);
    expect(component.playlist).toHaveLength(1);
  });
});
