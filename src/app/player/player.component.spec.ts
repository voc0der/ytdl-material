import { NO_ERRORS_SCHEMA } from '@angular/core';
import { ComponentFixture, TestBed, fakeAsync, tick, waitForAsync } from '@angular/core/testing';
import { MatDialog } from '@angular/material/dialog';
import { By } from '@angular/platform-browser';
import { ActivatedRoute, Router, convertToParamMap } from '@angular/router';
import { VgApiService } from '@videogular/ngx-videogular/core';
import { Observable, Subject } from 'rxjs';
import { DatabaseFile } from '../../api-types';
import { PostsService } from '../posts.services';
import { IChapter, IMedia, ISubtitleTrack, PlayerComponent } from './player.component';
import { configureTestBed } from '../../testing/test-bed';

describe('PlayerComponent', () => {
  let component: PlayerComponent;
  let fixture: ComponentFixture<PlayerComponent>;
  let postsServiceStub: any;
  let matDialogStub: any;

  beforeEach(waitForAsync(() => {
    postsServiceStub = {
      initialized: true,
      path: '/api/',
      config: {
        Downloader: {
          'path-audio': '/tmp/audio',
          'path-video': '/tmp/video'
        },
        Subscriptions: {
          subscriptions_base_path: '/tmp/subscriptions'
        },
        Advanced: {
          multi_user_mode: false
        }
      },
      theme: {
        drawer_color: '#fff'
      },
      setPageTitle: vi.fn().mockName('setPageTitle'),
      openSnackBar: vi.fn().mockName('openSnackBar'),
      getAllFiles: vi.fn().mockName('getAllFiles').mockReturnValue({
        subscribe: () => ({ unsubscribe() { } })
      }),
      getFile: vi.fn().mockName('getFile').mockReturnValue({
        subscribe: () => ({ unsubscribe() { } })
      }),
      service_initialized: {
        pipe: () => ({
          subscribe: () => ({ unsubscribe() { } })
        })
      },
      sidenav: null
    };
    matDialogStub = {
      open: vi.fn().mockName('openDialog')
    };

    configureTestBed({
      declarations: [PlayerComponent],
      providers: [
        { provide: PostsService, useValue: postsServiceStub },
        { provide: MatDialog, useValue: matDialogStub },
        {
          provide: Router,
          useValue: {
            navigate: vi.fn().mockName('navigate'),
            navigateByUrl: vi.fn().mockName('navigateByUrl'),
            url: '/'
          }
        },
        {
          provide: ActivatedRoute,
          useValue: {
            snapshot: {
              paramMap: convertToParamMap({}),
              queryParamMap: convertToParamMap({})
            }
          }
        }
      ],
      schemas: [NO_ERRORS_SCHEMA]
    })
      .compileComponents();
  }));

  beforeEach(() => {
    fixture = TestBed.createComponent(PlayerComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
    postsServiceStub.setPageTitle.mockClear();
  });


  function actionBarButtons(): HTMLButtonElement[] {
    const row = fixture.debugElement.query(By.css('.action-buttons-row'));
    return row ? Array.from(row.nativeElement.querySelectorAll('button')) : [];
  }

  function playerToolbar(): HTMLElement | null {
    return fixture.nativeElement.querySelector('.player-toolbar-section');
  }

  function playerPlaylist(): HTMLElement | null {
    return fixture.nativeElement.querySelector('.player-playlist-section');
  }

  function playerPage(): HTMLElement | null {
    return fixture.nativeElement.querySelector('.player-page');
  }

  function playlistRows(): HTMLElement[] {
    return Array.from(fixture.nativeElement.querySelectorAll('.playlist-row'));
  }

  function playlistAutoplayButtons(): HTMLButtonElement[] {
    return Array.from(fixture.nativeElement.querySelectorAll('.playlist-autoplay-button'));
  }

  // The whole toolbar sits behind the player's own guard, so a spec has to get far enough
  // for the player to be showing before any action button exists. ngOnInit runs on the
  // first detectChanges and rebuilds this state, so it has to settle first.
  function showPlayer(): void {
    fixture.detectChanges();
    component.playlist_id = 'playlist-1';
    component.file_objs = [{
      uid: 'f1',
      title: 'A video',
      isAudio: false,
      url: 'https://example.com/video'
    } as DatabaseFile];
    component.uids = ['f1'];
    component.parseFileNames();
    expect(component.show_player).toBe(true);
  }

  it('should give every action bar button an accessible name', () => {
    showPlayer();
    component.db_file = {uid: 'f1', title: 'A video', url: 'https://example.com/watch', isAudio: false} as any;
    fixture.detectChanges();

    const buttons = actionBarButtons();
    expect(buttons.length).toBeGreaterThan(0);
    for (const button of buttons) {
      // An icon on its own says nothing to a screen reader, and said nothing on hover
      // either until each of these carried a name.
      expect(button.getAttribute('aria-label')).toBeTruthy();
    }
  });

  it('should name the playlist download for what it actually downloads', () => {
    showPlayer();
    component.db_playlist = {id: 'p1', name: 'A playlist', uids: ['f1']} as any;
    fixture.detectChanges();

    const download = actionBarButtons()
      .find(button => button.querySelector('mat-icon')?.textContent.trim() === 'folder_zip');
    expect(download).toBeDefined();
    // A floppy disk said nothing about scope; both the icon and the name now do.
    expect(download.getAttribute('aria-label')).toBe('Download the whole playlist as a zip');
  });

  it('should require confirmation before preparing a playlist archive', () => {
    const confirmation = new Subject<boolean>();
    postsServiceStub.downloadPlaylistFromServer = vi.fn().mockName('downloadPlaylistFromServer');
    matDialogStub.open.mockReturnValue({afterClosed: () => confirmation.asObservable()});
    component.db_playlist = {id: 'p1', name: 'A playlist', uids: ['f1', 'f2']} as any;
    component.file_objs = [
      {uid: 'f1', size: 1024} as DatabaseFile,
      {uid: 'f2', size: 2048} as DatabaseFile
    ];

    component.downloadContent();

    expect(postsServiceStub.downloadPlaylistFromServer).not.toHaveBeenCalled();
    expect(matDialogStub.open.mock.calls[0][1].data.dialogText).toContain('2 files');
    confirmation.next(false);
    expect(postsServiceStub.downloadPlaylistFromServer).not.toHaveBeenCalled();
  });

  it('should abort an in-progress playlist archive request', () => {
    const confirmation = new Subject<boolean>();
    const requestTeardown = vi.fn().mockName('playlistRequestTeardown');
    postsServiceStub.downloadPlaylistFromServer = vi.fn().mockName('downloadPlaylistFromServer').mockReturnValue(
      new Observable(() => requestTeardown)
    );
    matDialogStub.open.mockReturnValue({afterClosed: () => confirmation.asObservable()});
    component.db_playlist = {id: 'p1', name: 'A playlist', uids: ['f1']} as any;
    component.playlist_id = 'p1';

    component.downloadContent();
    confirmation.next(true);

    expect(component.downloading).toBe(true);
    expect(postsServiceStub.downloadPlaylistFromServer).toHaveBeenCalledWith('p1', null);
    component.cancelPlaylistDownload();
    expect(requestTeardown).toHaveBeenCalled();
    expect(component.downloading).toBe(false);
    expect(postsServiceStub.openSnackBar).toHaveBeenCalledWith('Playlist download cancelled.');
  });

  it('should mark only the engaged playback toggles', () => {
    showPlayer();
    component.db_file = {uid: 'f1', title: 'A video', url: 'https://example.com/watch', isAudio: false} as any;
    component.theater_mode_enabled = true;
    component.repeat_enabled = false;
    fixture.detectChanges();

    const toggles = actionBarButtons().filter(button => button.classList.contains('playback-mode-button'));
    const theaterMode = toggles.find(button => button.getAttribute('aria-label') === 'Theater mode');
    const repeat = toggles.find(button => button.getAttribute('aria-label') === 'Repeat current video');
    // Idle toggles carry no marker at all, so they render at the same colour as the
    // actions beside them rather than dimmed.
    expect(theaterMode.classList.contains('active')).toBe(true);
    expect(repeat.classList.contains('active')).toBe(false);
  });

  it('should mark playback toggles as pressed for assistive tech', () => {
    showPlayer();
    component.db_file = {uid: 'f1', title: 'A video', url: 'https://example.com/watch', isAudio: false} as any;
    component.theater_mode_enabled = true;
    component.repeat_enabled = false;
    fixture.detectChanges();

    const toggles = actionBarButtons().filter(button => button.classList.contains('playback-mode-button'));
    const theaterMode = toggles.find(button => button.getAttribute('aria-label') === 'Theater mode');
    const repeat = toggles.find(button => button.getAttribute('aria-label') === 'Repeat current video');
    expect(theaterMode.getAttribute('aria-pressed')).toBe('true');
    expect(repeat.getAttribute('aria-pressed')).toBe('false');
  });

  it('should put autoplay only on the current playlist row and keep its click on that control', () => {
    showPlayer();
    const currentItem = component.currentItem;
    const updateCurrentItem = vi.spyOn(component, 'updateCurrentItem');
    fixture.detectChanges();

    expect(actionBarButtons().some(button => button.getAttribute('aria-label') === 'Autoplay')).toBe(false);
    expect(playlistAutoplayButtons()).toHaveLength(1);
    expect(playlistRows()[0].querySelector('.playlist-autoplay-button')).toBeTruthy();

    playlistAutoplayButtons()[0].click();
    fixture.detectChanges();

    expect(component.currentItem).toBe(currentItem);
    expect(updateCurrentItem).not.toHaveBeenCalled();
    expect(component.autoplay_enabled).toBe(true);
    expect(playlistAutoplayButtons()[0].getAttribute('aria-pressed')).toBe('true');
  });

  it('should move the autoplay control with the playing item', () => {
    component.playlist_id = 'playlist-1';
    component.file_objs = [
      {uid: 'f1', title: 'First video', isAudio: false, url: 'https://example.com/first'} as DatabaseFile,
      {uid: 'f2', title: 'Second video', isAudio: false, url: 'https://example.com/second'} as DatabaseFile
    ];
    component.uids = ['f1', 'f2'];
    component.parseFileNames();
    fixture.detectChanges();

    expect(playlistRows()[0].querySelector('.playlist-autoplay-button')).toBeTruthy();
    expect(playlistRows()[1].querySelector('.playlist-autoplay-button')).toBeFalsy();

    component.onClickPlaylistItem(component.playlist[1], 1);
    fixture.detectChanges();

    expect(playlistRows()[0].querySelector('.playlist-autoplay-button')).toBeFalsy();
    expect(playlistRows()[1].querySelector('.playlist-autoplay-button')).toBeTruthy();

    component.drop({previousIndex: 1, currentIndex: 0} as any);
    fixture.detectChanges();

    expect(component.currentIndex).toBe(0);
    expect(playlistRows()[0].querySelector('.playlist-autoplay-button')).toBeTruthy();
  });

  it('should place theater mode before download and make the video the only visible player content', () => {
    showPlayer();
    component.db_file = {uid: 'f1', title: 'A video', url: 'https://example.com/watch', isAudio: false} as DatabaseFile;
    component.api = {state: 'paused', time: {current: 0}} as unknown as VgApiService;
    postsServiceStub.isLoggedIn = false;
    fixture.detectChanges();

    const buttons = actionBarButtons();
    const theaterModeIndex = buttons.findIndex(button => button.getAttribute('aria-label') === 'Theater mode');
    const downloadIndex = buttons.findIndex(button => button.getAttribute('aria-label') === 'Download this file');
    const shareIndex = buttons.findIndex(button => button.getAttribute('aria-label') === 'Share');
    expect(theaterModeIndex).toBeGreaterThan(-1);
    expect(downloadIndex).toBe(theaterModeIndex + 1);
    expect(shareIndex).toBe(downloadIndex + 1);

    buttons[theaterModeIndex].click();
    fixture.detectChanges();

    expect(component.theater_mode_enabled).toBe(true);
    expect(buttons[theaterModeIndex].getAttribute('aria-pressed')).toBe('true');
    expect(playerPage()?.classList.contains('theater-mode-active')).toBe(true);
    expect(document.body.classList.contains('player-theater-mode-active')).toBe(true);
    expect(playerToolbar()?.hidden).toBe(true);
    expect(playerPlaylist()?.hidden).toBe(true);
    expect(fixture.nativeElement.querySelector('.watch-together-section')?.hidden).toBe(true);
    expect(fixture.nativeElement.querySelector('.video-player')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('.video-blackout-overlay')).toBeFalsy();
    expect(component.currentItem?.uid).toBe('f1');
  });

  it('should exit theater mode with Escape and restore the surrounding controls', () => {
    showPlayer();
    component.db_file = {uid: 'f1', title: 'A video', url: 'https://example.com/watch', isAudio: false} as DatabaseFile;
    fixture.detectChanges();

    const theaterMode = actionBarButtons().find(button => button.getAttribute('aria-label') === 'Theater mode');
    theaterMode.click();
    fixture.detectChanges();

    expect(playerToolbar()?.hidden).toBe(true);
    expect(playerPlaylist()?.hidden).toBe(true);

    document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape'}));
    fixture.detectChanges();

    expect(component.theater_mode_enabled).toBe(false);
    expect(document.body.classList.contains('player-theater-mode-active')).toBe(false);
    expect(playerToolbar()?.hidden).toBe(false);
    expect(playerPlaylist()?.hidden).toBe(false);
  });

  it('should not offer theater mode for audio', () => {
    component.playlist_id = 'playlist-1';
    component.file_objs = [
      {uid: 'a1', title: 'An audio track', isAudio: true, url: 'https://example.com/audio'} as DatabaseFile
    ];
    component.uids = ['a1'];
    component.parseFileNames();
    fixture.detectChanges();

    expect(actionBarButtons().some(button => button.getAttribute('aria-label') === 'Theater mode')).toBe(false);
    component.toggleTheaterMode();
    expect(component.theater_mode_enabled).toBe(false);
  });

  it('should expose row autoplay and theater mode when playing a subscription', () => {
    component.sub_id = 'subscription-1';
    component.subscription = {
      id: 'subscription-1',
      type: 'video',
      videos: [
        {uid: 's1', title: 'Subscriber video', isAudio: false, url: 'https://example.com/subscriber'} as DatabaseFile
      ]
    } as any;
    component.type = component.subscription.type;
    component.uids = ['s1'];
    component.parseFileNames();
    fixture.detectChanges();

    expect(playlistAutoplayButtons()).toHaveLength(1);
    expect(actionBarButtons().some(button => button.getAttribute('aria-label') === 'Theater mode')).toBe(true);
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('should update page title when current media changes', () => {
    const media: IMedia = {
      title: 'Future - Low Life (Official Music Video) ft. The Weeknd',
      src: '/stream/test',
      type: 'video/mp4',
      label: 'Future - Low Life (Official Music Video) ft. The Weeknd',
      url: 'https://example.com/video'
    };

    component.updateCurrentItem(media, 0);

    expect(postsServiceStub.setPageTitle).toHaveBeenCalledWith(media.title);
  });

  it('should sync current file metadata from the selected playlist item', () => {
    const playlistFile = {
      uid: 'uid-playlist',
      title: 'Playlist item',
      description: 'Playlist description',
      isAudio: false,
      url: 'https://example.com/video'
    } as DatabaseFile & {
      description: string;
    };
    const media: IMedia = {
      title: 'Playlist item',
      src: '/stream/test',
      type: 'video/mp4',
      label: 'Playlist item',
      url: 'https://example.com/video',
      uid: 'uid-playlist'
    };

    component.playlist_id = 'playlist-1';
    component.file_objs = [playlistFile];

    component.updateCurrentItem(media, 0);

    expect(component.currentFile).toBe(playlistFile);
    expect(component.currentFile['description']).toBe('Playlist description');
  });

  it('should clamp a stale playlist index to the first playable item', () => {
    const playlistFile = {
      uid: 'uid-playlist',
      title: 'Playlist item',
      isAudio: false,
      url: 'https://example.com/video'
    } as DatabaseFile;

    component.playlist_id = 'playlist-1';
    component.file_objs = [playlistFile];
    component.uids = ['uid-playlist'];
    component.currentIndex = 7;

    component.parseFileNames();

    expect(component.currentIndex).toBe(0);
    expect(component.currentItem?.uid).toBe('uid-playlist');
    expect(component.show_player).toBe(true);
  });

  it('should hide the player when a playlist has no playable items', () => {
    component.playlist_id = 'playlist-1';
    component.file_objs = [];
    component.uids = ['missing-file'];

    component.parseFileNames();

    expect(component.currentItem).toBeNull();
    expect(component.show_player).toBe(false);
    expect(postsServiceStub.openSnackBar).toHaveBeenCalled();
  });

  it('should build stream URLs without a trailing slash before the query string', () => {
    postsServiceStub.isLoggedIn = false;
    component.baseStreamPath = '/api/';

    const streamURL = component.createStreamURL({
      uid: 'uid with spaces',
      isAudio: false
    } as DatabaseFile);

    expect(streamURL).toBe('/api/stream?uid=uid%20with%20spaces&type=video');
  });

  it('should build subtitle track URLs without a trailing slash before the query string', () => {
    postsServiceStub.isLoggedIn = false;
    component.baseStreamPath = '/api/';

    const subtitleTrackURL = component.createSubtitleTrackURL('uid with spaces', 0);

    expect(subtitleTrackURL).toBe('/api/streamSubtitle?uid=uid%20with%20spaces&index=0');
  });

  it('should reset page title on destroy', () => {
    component.ngOnDestroy();

    expect(postsServiceStub.setPageTitle).toHaveBeenCalledWith();
  });

  it('should unload the native media element on destroy', () => {
    const pauseSpy = vi.fn().mockName('pause');
    const removeAttributeSpy = vi.fn().mockName('removeAttribute');
    const loadSpy = vi.fn().mockName('load');
    component.mediaElement = {
      nativeElement: {
        pause: pauseSpy,
        removeAttribute: removeAttributeSpy,
        load: loadSpy
      }
    } as any;

    component.ngOnDestroy();

    expect(pauseSpy).toHaveBeenCalled();
    expect(removeAttributeSpy).toHaveBeenCalledWith('src');
    expect(loadSpy).toHaveBeenCalled();
  });

  it('should sync current chapters and close chapter dropdown', () => {
    component.chapterDropdownOpen = true;
    component.currentItem = {
      title: 'Chapter Test',
      src: '/stream/test',
      type: 'video/mp4',
      label: 'Chapter Test',
      url: 'https://example.com/video',
      chapters: [
        { title: 'Intro', start_time: 0, end_time: 10 }
      ]
    };

    component.syncCurrentChapters();

    expect(component.currentChapters.length).toBe(1);
    expect(component.currentChapters[0].title).toBe('Intro');
    expect(component.chapterDropdownOpen).toBe(false);
  });

  it('should normalize subtitle metadata into player track URLs', () => {
    postsServiceStub.isLoggedIn = false;
    component.baseStreamPath = '/api/';

    const mediaObject = component.createMediaObject({
      uid: 'uid-subtitle',
      title: 'Subtitle test',
      isAudio: false,
      url: 'https://example.com/video',
      subtitles: [
        {
          label: 'English',
          language: 'en',
          kind: 'subtitles',
          default: true
        }
      ]
    } as DatabaseFile);

    expect(mediaObject.subtitles).toEqual([
      {
        label: 'English',
        language: 'en',
        kind: 'subtitles',
        default: true,
        src: '/api/streamSubtitle?uid=uid-subtitle&index=0'
      }
    ]);
  });

  it('should resolve active chapter based on current playback time', () => {
    component.currentChapters = [
      { title: 'Intro', start_time: 0, end_time: 30 },
      { title: 'Part 2', start_time: 30, end_time: 90 }
    ];
    component.api = { currentTime: 45 } as unknown as VgApiService;

    const chapter = component.getCurrentChapter();

    expect(chapter?.title).toBe('Part 2');
  });

  it('should return first chapter when no active chapter is available', () => {
    component.currentChapters = [
      { title: 'Intro', start_time: 0, end_time: 30 },
      { title: 'Part 2', start_time: 30, end_time: 90 }
    ];
    component.api = null;

    const chapter = component.getCurrentChapter();

    expect(chapter?.title).toBe('Intro');
  });

  it('should sync current subtitle tracks from the current media item', () => {
    const subtitles: ISubtitleTrack[] = [
      {
        label: 'English',
        language: 'en',
        kind: 'subtitles',
        default: true,
        src: '/api/streamSubtitle?uid=uid-subtitle&index=0'
      }
    ];
    component.currentItem = {
      title: 'Subtitle Test',
      src: '/stream/test',
      type: 'video/mp4',
      label: 'Subtitle Test',
      url: 'https://example.com/video',
      uid: 'uid-subtitle',
      subtitles
    };

    component.syncCurrentSubtitles();

    expect(component.currentSubtitleTracks).toEqual(subtitles);
    expect(component.subtitlesEnabled).toBe(true);
  });

  it('should enable subtitles when subtitle metadata arrives for the current item later', () => {
    component.currentItem = {
      title: 'Subtitle arrival test',
      src: '/stream/test',
      type: 'video/mp4',
      label: 'Subtitle arrival test',
      url: 'https://example.com/video',
      uid: 'uid-subtitle'
    };
    component.subtitlesEnabled = false;
    vi.spyOn(component, 'refreshMediaSubtitleTracks').mockReturnValue(undefined);

    component.applySubtitlesToMedia('uid-subtitle', [
      { label: 'English', language: 'en', default: true, src: '/api/streamSubtitle?uid=uid-subtitle&index=0' }
    ]);

    expect(component.subtitlesEnabled).toBe(true);
    expect(component.refreshMediaSubtitleTracks).toHaveBeenCalled();
  });

  it('should force the default subtitle track into showing mode', () => {
    const textTracks = [
      { mode: 'disabled' },
      { mode: 'disabled' }
    ];
    component.subtitlesEnabled = true;
    component.currentSubtitleTracks = [
      { label: 'English', language: 'en', default: true, src: '/api/streamSubtitle?uid=uid-subtitle&index=0' },
      { label: 'Spanish', language: 'es', default: false, src: '/api/streamSubtitle?uid=uid-subtitle&index=1' }
    ];
    component.mediaElement = {
      nativeElement: {
        textTracks
      }
    } as any;

    component.showDefaultSubtitleTrack();

    expect(textTracks[0].mode).toBe('showing');
    expect(textTracks[1].mode).toBe('disabled');
  });

  it('should disable subtitle tracks when subtitles are toggled off', () => {
    const textTracks = [
      { mode: 'showing' },
      { mode: 'disabled' }
    ];
    component.currentItem = {
      title: 'Subtitle Toggle Test',
      src: '/stream/test',
      type: 'video/mp4',
      label: 'Subtitle Toggle Test',
      url: 'https://example.com/video',
      uid: 'uid-subtitle'
    };
    component.subtitlesEnabled = true;
    component.currentSubtitleTracks = [
      { label: 'English', language: 'en', default: true, src: '/api/streamSubtitle?uid=uid-subtitle&index=0' },
      { label: 'Spanish', language: 'es', default: false, src: '/api/streamSubtitle?uid=uid-subtitle&index=1' }
    ];
    component.mediaElement = {
      nativeElement: {
        textTracks
      }
    } as any;

    component.toggleSubtitles();

    expect(component.subtitlesEnabled).toBe(false);
    expect(textTracks[0].mode).toBe('disabled');
    expect(textTracks[1].mode).toBe('disabled');
  });

  it('should report that subtitles can be toggled when subtitle tracks are available', () => {
    component.playlist = [{
        title: 'Subtitle Test',
        src: '/stream/test',
        type: 'video/mp4',
        label: 'Subtitle Test',
        url: 'https://example.com/video',
        uid: 'uid-subtitle'
      }];
    component.currentItem = component.playlist[0];
    component.currentSubtitleTracks = [
      { label: 'English', language: 'en', default: true, src: '/api/streamSubtitle?uid=uid-subtitle&index=0' }
    ];
    component.subtitlesEnabled = true;
    component.show_player = true;

    expect(component.canToggleSubtitles()).toBe(true);
  });

  it('should report that subtitles can be toggled when embedded text tracks are available without subtitle metadata', () => {
    component.playlist = [{
        title: 'Embedded Subtitle Test',
        src: '/stream/test',
        type: 'video/mp4',
        label: 'Embedded Subtitle Test',
        url: 'https://example.com/video',
        uid: 'uid-embedded-subtitle'
      }];
    component.currentItem = component.playlist[0];
    component.currentSubtitleTracks = [];
    component.mediaElement = {
      nativeElement: {
        textTracks: {
          length: 1
        }
      }
    } as any;

    expect(component.canToggleSubtitles()).toBe(true);
  });

  it('should retry subtitle activation when tracks attach after the initial render', fakeAsync(() => {
    const textTracks: Array<{
      mode: string;
    }> = [];
    component.subtitlesEnabled = true;
    component.currentSubtitleTracks = [
      { label: 'English', language: 'en', default: true, src: '/api/streamSubtitle?uid=uid-subtitle&index=0' }
    ];
    component.mediaElement = {
      nativeElement: {
        textTracks
      }
    } as any;

    component.showDefaultSubtitleTrack();
    textTracks.push({ mode: 'disabled' });
    tick(151);

    expect(textTracks[0].mode).toBe('showing');
  }));

  it('should show the first embedded subtitle track when subtitle metadata is unavailable', () => {
    const textTracks = [
      { mode: 'disabled' },
      { mode: 'disabled' }
    ];
    component.subtitlesEnabled = true;
    component.currentSubtitleTracks = [];
    component.mediaElement = {
      nativeElement: {
        textTracks
      }
    } as any;

    component.showDefaultSubtitleTrack();

    expect(textTracks[0].mode).toBe('showing');
    expect(textTracks[1].mode).toBe('disabled');
  });

  it('should reapply subtitle activation when the browser adds tracks later', fakeAsync(() => {
    let addTrackListener: EventListener = null;
    const textTracks = {
      0: { mode: 'disabled' },
      length: 1,
      addEventListener: (_event: string, listener: EventListener) => {
        addTrackListener = listener;
      },
      removeEventListener: vi.fn().mockName('removeEventListener')
    } as unknown as TextTrackList & EventTarget;

    component.subtitlesEnabled = true;
    component.currentSubtitleTracks = [
      { label: 'English', language: 'en', default: true, src: '/api/streamSubtitle?uid=uid-subtitle&index=0' }
    ];
    component.mediaElement = {
      nativeElement: {
        textTracks
      }
    } as any;

    component.attachSubtitleTrackListener();
    addTrackListener(new Event('addtrack'));
    tick();

    expect((textTracks[0] as any).mode).toBe('showing');
  }));

  it('should enable subtitle toggling when embedded tracks are added later without subtitle metadata', fakeAsync(() => {
    let addTrackListener: EventListener = null;
    const textTracks = {
      0: { mode: 'disabled' },
      length: 1,
      addEventListener: (_event: string, listener: EventListener) => {
        addTrackListener = listener;
      },
      removeEventListener: vi.fn().mockName('removeEventListener')
    } as unknown as TextTrackList & EventTarget;

    component.currentItem = {
      title: 'Embedded subtitle arrival test',
      src: '/stream/test',
      type: 'video/mp4',
      label: 'Embedded subtitle arrival test',
      url: 'https://example.com/video',
      uid: 'uid-embedded-subtitle'
    };
    component.subtitlesEnabled = false;
    component.currentSubtitleTracks = [];
    component.mediaElement = {
      nativeElement: {
        textTracks
      }
    } as any;

    component.attachSubtitleTrackListener();
    addTrackListener(new Event('addtrack'));
    tick();

    expect(component.subtitlesEnabled).toBe(true);
    expect((textTracks[0] as any).mode).toBe('showing');
  }));

  it('should reload media when subtitles arrive after playback has already started', fakeAsync(() => {
    let loadedMetadataListener: EventListener = null;
    const loadSpy = vi.fn().mockName('load');
    const playSpy = vi.fn().mockName('play').mockResolvedValue(undefined);
    const textTracks = [{ mode: 'disabled' }];
    component.currentItem = {
      title: 'Subtitle reload test',
      src: '/stream/test',
      type: 'video/mp4',
      label: 'Subtitle reload test',
      url: 'https://example.com/video',
      uid: 'uid-subtitle'
    };
    component.subtitlesEnabled = true;
    component.currentSubtitleTracks = [
      { label: 'English', language: 'en', default: true, src: '/api/streamSubtitle?uid=uid-subtitle&index=0' }
    ];
    component.mediaElement = {
      nativeElement: {
        textTracks,
        readyState: 4,
        paused: false,
        ended: false,
        duration: 100,
        currentTime: 42,
        load: loadSpy,
        play: playSpy,
        addEventListener: (_event: string, listener: EventListener) => {
          loadedMetadataListener = listener;
        }
      }
    } as any;

    component.refreshMediaSubtitleTracks();
    tick();

    expect(loadSpy).toHaveBeenCalled();
    expect(loadedMetadataListener).toBeTruthy();

    (loadedMetadataListener as EventListener)(new Event('loadedmetadata'));
    tick();

    expect(component.mediaElement.nativeElement.currentTime).toBe(42);
    expect(textTracks[0].mode).toBe('showing');
    expect(playSpy).toHaveBeenCalled();
  }));

  it('should reapply preloaded subtitles when the player becomes ready', fakeAsync(() => {
    const loadSpy = vi.fn().mockName('load');
    const preloadedSubtitles: ISubtitleTrack[] = [
      { label: 'English', language: 'en', default: true, src: '/api/streamSubtitle?uid=uid-subtitle&index=0' }
    ];
    const api = {
      volume: 1,
      getDefaultMedia: () => ({
        subscriptions: {
          loadedMetadata: { subscribe: () => ({ unsubscribe() { } }) },
          ended: { subscribe: () => ({ unsubscribe() { } }) },
          timeUpdate: { subscribe: () => ({ unsubscribe() { } }) }
        }
      })
    } as unknown as VgApiService;

    component.currentItem = {
      title: 'Preloaded subtitle test',
      src: '/stream/test',
      type: 'video/mp4',
      label: 'Preloaded subtitle test',
      url: 'https://example.com/video',
      uid: 'uid-subtitle',
      subtitles: preloadedSubtitles
    };
    component.currentSubtitleTracks = preloadedSubtitles;
    component.loadedSubtitleTrackSignature = component.getSubtitleTrackSignature(preloadedSubtitles);
    component.mediaElement = {
      nativeElement: {
        textTracks: [],
        readyState: 4,
        paused: true,
        ended: false,
        duration: 100,
        currentTime: 0,
        load: loadSpy,
        addEventListener: vi.fn().mockName('addEventListener')
      }
    } as any;

    component.onPlayerReady(api);
    tick();

    expect(loadSpy).toHaveBeenCalled();
  }));

  it('should toggle chapter dropdown state', () => {
    const clickEvent = { stopPropagation: vi.fn().mockName('stopPropagation') } as unknown as MouseEvent;

    component.toggleChapterDropdown(clickEvent);
    expect(clickEvent.stopPropagation).toHaveBeenCalled();
    expect(component.chapterDropdownOpen).toBe(true);

    component.toggleChapterDropdown(clickEvent);
    expect(component.chapterDropdownOpen).toBe(false);
  });

  it('should close chapter dropdown on document click', () => {
    component.chapterDropdownOpen = true;

    component.onDocumentClick();

    expect(component.chapterDropdownOpen).toBe(false);
  });

  it('should seek to floored chapter start when selecting from dropdown', () => {
    const seekSpy = vi.fn().mockName('seekTime');
    component.api = { seekTime: seekSpy } as unknown as VgApiService;
    component.chapterDropdownOpen = true;
    const chapter: IChapter = { title: 'Part 2', start_time: 42.9, end_time: 84.2 };
    const clickEvent = { stopPropagation: vi.fn().mockName('stopPropagation') } as unknown as MouseEvent;

    component.selectChapterFromDropdown(chapter, clickEvent);

    expect(clickEvent.stopPropagation).toHaveBeenCalled();
    expect(seekSpy).toHaveBeenCalledWith(42);
    expect(component.chapterDropdownOpen).toBe(false);
  });

  it('should request autoplay queue without chapter metadata in bulk mode', () => {
    const media: IMedia = {
      title: 'Single file',
      src: '/stream/test',
      type: 'video/mp4',
      label: 'Single file',
      url: 'https://example.com/video',
      uid: 'uid-single'
    };
    component.uid = 'uid-single';
    component.playlist = [media];
    component.currentItem = media;
    component.autoplay_enabled = true;
    component.autoplay_queue_initialized = false;
    component.autoplay_queue_loading = false;

    component.ensureAutoplayQueueReady();

    expect(postsServiceStub.getAllFiles).toHaveBeenCalled();
    expect(vi.mocked(postsServiceStub.getAllFiles).mock.lastCall[6]).toBe(false);
  });

  it('should cache active chapter index and label from playback time', () => {
    component.currentChapters = [
      { title: 'Intro', start_time: 0, end_time: 30 },
      { title: 'Part 2', start_time: 30, end_time: 90 }
    ];
    component.api = { currentTime: 45 } as unknown as VgApiService;

    component.refreshCurrentChapterState();

    expect(component.activeChapterIndex).toBe(1);
    expect(component.currentChapterLabel).toBe('Part 2');

    component.api = { currentTime: 5 } as unknown as VgApiService;
    component.onPlaybackTimeUpdate();

    expect(component.activeChapterIndex).toBe(0);
    expect(component.currentChapterLabel).toBe('Intro');
  });

  it('should calculate chapter segment progress from the current playback time', () => {
    component.playbackTime = 45;
    const chapter: IChapter = { title: 'Part 2', start_time: 30, end_time: 90 };

    expect(component.getChapterProgressWidth(chapter)).toBe(25);

    component.playbackTime = 120;
    expect(component.getChapterProgressWidth(chapter)).toBe(100);
  });

  it('should use file duration when building the chapter timeline duration', () => {
    component.currentChapters = [
      { title: 'Intro', start_time: 0, end_time: 30 },
      { title: 'Part 2', start_time: 30, end_time: 90 }
    ];
    component.currentFile = { duration: 120 } as DatabaseFile;

    expect(component.getChapterTimelineDuration()).toBe(120);

    component.currentFile = { duration: 60 } as DatabaseFile;
    expect(component.getChapterTimelineDuration()).toBe(90);
  });

  it('should only show the chapter timeline overlay near the bottom hover band', () => {
    component.currentItem = {
      title: 'Hover Test',
      src: '/stream/test',
      type: 'video/mp4',
      label: 'Hover Test',
      url: 'https://example.com/video'
    };
    component.currentChapters = [
      { title: 'Intro', start_time: 0, end_time: 30 }
    ];

    const playerElement = {
      clientHeight: 540,
      getBoundingClientRect: () => ({ bottom: 500 })
    } as unknown as HTMLElement;

    component.onPlayerMouseMove({ currentTarget: playerElement, clientY: 430 } as unknown as MouseEvent);
    expect(component.chapterTimelineVisible).toBe(true);

    component.onPlayerMouseMove({ currentTarget: playerElement, clientY: 320 } as unknown as MouseEvent);
    expect(component.chapterTimelineVisible).toBe(false);

    component.onPlayerMouseLeave();
    expect(component.chapterTimelineVisible).toBe(false);
  });

  describe('snip mode', () => {
    beforeEach(() => {
      component.currentFile = { uid: 'file-uid', duration: 120 } as DatabaseFile;
      component.api = {
        seekTime: vi.fn().mockName('seekTime'),
        play: vi.fn().mockName('play'),
        pause: vi.fn().mockName('pause')
      } as unknown as VgApiService;
      postsServiceStub.hasPermission = vi.fn().mockName('hasPermission').mockReturnValue(true);
      component.snip_mode = true;
      component.snip_start = 10;
      component.snip_end = 40;
    });

    it('keeps the start knob to the left of the end knob', () => {
      component.onSnipStartChange(80);

      expect(component.snip_start).toBe(80);
      expect(component.snip_end).toBeGreaterThan(component.snip_start);
    });

    it('keeps the end knob to the right of the start knob', () => {
      component.onSnipEndChange(5);

      expect(component.snip_end).toBe(5);
      expect(component.snip_start).toBeLessThan(component.snip_end);
    });

    it('never lets the knobs select a zero-length range', () => {
      component.onSnipStartChange(40);
      expect(component.getSnipSelectionLength()).toBeGreaterThanOrEqual(1);

      component.onSnipEndChange(component.snip_start);
      expect(component.getSnipSelectionLength()).toBeGreaterThanOrEqual(1);
    });

    it('clamps the knobs to the bounds of the media', () => {
      component.onSnipStartChange(-30);
      expect(component.snip_start).toBe(0);

      component.onSnipEndChange(9999);
      expect(component.snip_end).toBe(120);
    });

    it('treats a zero-length selection as invalid and refuses to submit it', () => {
      component.snip_start = 30;
      component.snip_end = 30;

      expect(component.snipSelectionValid()).toBe(false);

      postsServiceStub.snipFile = vi.fn().mockName('snipFile');
      component.confirmSnip();
      expect(postsServiceStub.snipFile).not.toHaveBeenCalled();
    });

    it('submits a valid selection and reports failure without hanging', () => {
      component.snip_start = 10;
      component.snip_end = 40;
      postsServiceStub.snipFile = vi.fn().mockName('snipFile').mockReturnValue({
        subscribe: (next: (res: any) => void) => {
          next({ success: false, error: 'nope' });
          return { unsubscribe() { } };
        }
      });

      component.confirmSnip();

      expect(postsServiceStub.snipFile).toHaveBeenCalledWith('file-uid', 10, 40);
      expect(component.snip_in_progress).toBe(false);
      expect(postsServiceStub.openSnackBar).toHaveBeenCalledWith('nope');
    });

    it('seeks to the knob being dragged so the edge can be previewed', fakeAsync(() => {
      component.onSnipStartChange(25);
      tick(200);
      expect(component.api.seekTime).toHaveBeenCalledWith(25);
    }));

    it('coalesces seeks while a knob is being dragged', fakeAsync(() => {
      component.onSnipStartChange(20);
      component.onSnipStartChange(25);
      component.onSnipStartChange(30);
      tick(200);

      expect(component.api.seekTime).toHaveBeenCalledTimes(1);
      expect(component.api.seekTime).toHaveBeenCalledWith(30);
    }));

    it('does not offer snipping on media too short to trim', () => {
      component.currentFile = { uid: 'file-uid', duration: 0.5 } as DatabaseFile;
      expect(component.canSnipCurrentFile()).toBe(false);
    });
  });
});
