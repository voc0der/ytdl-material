import { NO_ERRORS_SCHEMA } from '@angular/core';
import { ComponentFixture, TestBed, fakeAsync, tick, waitForAsync } from '@angular/core/testing';
import { MatDialog } from '@angular/material/dialog';
import { ActivatedRoute, Router, convertToParamMap } from '@angular/router';
import { VgApiService } from '@videogular/ngx-videogular/core';
import { DatabaseFile } from '../../api-types';
import { PostsService } from '../posts.services';
import { IChapter, IMedia, ISubtitleTrack, PlayerComponent } from './player.component';

describe('PlayerComponent', () => {
  let component: PlayerComponent;
  let fixture: ComponentFixture<PlayerComponent>;
  let postsServiceStub: any;

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
        }
      },
      setPageTitle: jasmine.createSpy('setPageTitle'),
      openSnackBar: jasmine.createSpy('openSnackBar'),
      getAllFiles: jasmine.createSpy('getAllFiles').and.returnValue({
        subscribe: () => ({ unsubscribe() {} })
      }),
      getFile: jasmine.createSpy('getFile').and.returnValue({
        subscribe: () => ({ unsubscribe() {} })
      }),
      service_initialized: {
        pipe: () => ({
          subscribe: () => ({ unsubscribe() {} })
        })
      },
      sidenav: null
    };

    TestBed.configureTestingModule({
      declarations: [PlayerComponent],
      providers: [
        { provide: PostsService, useValue: postsServiceStub },
        { provide: MatDialog, useValue: {} },
        {
          provide: Router,
          useValue: {
            navigate: jasmine.createSpy('navigate'),
            navigateByUrl: jasmine.createSpy('navigateByUrl'),
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
    postsServiceStub.setPageTitle.calls.reset();
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
    } as DatabaseFile & { description: string };
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
    expect(component.show_player).toBeTrue();
  });

  it('should hide the player when a playlist has no playable items', () => {
    component.playlist_id = 'playlist-1';
    component.file_objs = [];
    component.uids = ['missing-file'];

    component.parseFileNames();

    expect(component.currentItem).toBeNull();
    expect(component.show_player).toBeFalse();
    expect(postsServiceStub.openSnackBar).toHaveBeenCalled();
  });

  it('should build stream URLs without a trailing slash before the query string', () => {
    postsServiceStub.isLoggedIn = false;
    postsServiceStub.auth_token = 'public-token';
    component.baseStreamPath = '/api/';

    const streamURL = component.createStreamURL({
      uid: 'uid with spaces',
      isAudio: false
    } as DatabaseFile);

    expect(streamURL).toBe('/api/stream?uid=uid%20with%20spaces&type=video&apiKey=public-token');
  });

  it('should build subtitle track URLs without a trailing slash before the query string', () => {
    postsServiceStub.isLoggedIn = false;
    postsServiceStub.auth_token = 'public-token';
    component.baseStreamPath = '/api/';

    const subtitleTrackURL = component.createSubtitleTrackURL('uid with spaces', 0);

    expect(subtitleTrackURL).toBe('/api/streamSubtitle?uid=uid%20with%20spaces&index=0&apiKey=public-token');
  });

  it('should reset page title on destroy', () => {
    component.ngOnDestroy();

    expect(postsServiceStub.setPageTitle).toHaveBeenCalledWith();
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
    expect(component.chapterDropdownOpen).toBeFalse();
  });

  it('should normalize subtitle metadata into player track URLs', () => {
    postsServiceStub.isLoggedIn = false;
    postsServiceStub.auth_token = 'public-token';
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
        src: '/api/streamSubtitle?uid=uid-subtitle&index=0&apiKey=public-token'
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
    expect(component.subtitlesEnabled).toBeTrue();
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
    spyOn(component, 'refreshMediaSubtitleTracks');

    component.applySubtitlesToMedia('uid-subtitle', [
      { label: 'English', language: 'en', default: true, src: '/api/streamSubtitle?uid=uid-subtitle&index=0' }
    ]);

    expect(component.subtitlesEnabled).toBeTrue();
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

    expect(component.subtitlesEnabled).toBeFalse();
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

    expect(component.canToggleSubtitles()).toBeTrue();
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

    expect(component.canToggleSubtitles()).toBeTrue();
  });

  it('should retry subtitle activation when tracks attach after the initial render', fakeAsync(() => {
    const textTracks: Array<{ mode: string }> = [];
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
      removeEventListener: jasmine.createSpy('removeEventListener')
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
      removeEventListener: jasmine.createSpy('removeEventListener')
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

    expect(component.subtitlesEnabled).toBeTrue();
    expect((textTracks[0] as any).mode).toBe('showing');
  }));

  it('should reload media when subtitles arrive after playback has already started', fakeAsync(() => {
    let loadedMetadataListener: EventListener = null;
    const loadSpy = jasmine.createSpy('load');
    const playSpy = jasmine.createSpy('play').and.returnValue(Promise.resolve());
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
    const loadSpy = jasmine.createSpy('load');
    const preloadedSubtitles: ISubtitleTrack[] = [
      { label: 'English', language: 'en', default: true, src: '/api/streamSubtitle?uid=uid-subtitle&index=0' }
    ];
    const api = {
      volume: 1,
      getDefaultMedia: () => ({
        subscriptions: {
          loadedMetadata: { subscribe: () => ({ unsubscribe() {} }) },
          ended: { subscribe: () => ({ unsubscribe() {} }) },
          timeUpdate: { subscribe: () => ({ unsubscribe() {} }) }
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
        addEventListener: jasmine.createSpy('addEventListener')
      }
    } as any;

    component.onPlayerReady(api);
    tick();

    expect(loadSpy).toHaveBeenCalled();
  }));

  it('should toggle chapter dropdown state', () => {
    const clickEvent = { stopPropagation: jasmine.createSpy('stopPropagation') } as unknown as MouseEvent;

    component.toggleChapterDropdown(clickEvent);
    expect(clickEvent.stopPropagation).toHaveBeenCalled();
    expect(component.chapterDropdownOpen).toBeTrue();

    component.toggleChapterDropdown(clickEvent);
    expect(component.chapterDropdownOpen).toBeFalse();
  });

  it('should close chapter dropdown on document click', () => {
    component.chapterDropdownOpen = true;

    component.onDocumentClick();

    expect(component.chapterDropdownOpen).toBeFalse();
  });

  it('should seek to floored chapter start when selecting from dropdown', () => {
    const seekSpy = jasmine.createSpy('seekTime');
    component.api = { seekTime: seekSpy } as unknown as VgApiService;
    component.chapterDropdownOpen = true;
    const chapter: IChapter = { title: 'Part 2', start_time: 42.9, end_time: 84.2 };
    const clickEvent = { stopPropagation: jasmine.createSpy('stopPropagation') } as unknown as MouseEvent;

    component.selectChapterFromDropdown(chapter, clickEvent);

    expect(clickEvent.stopPropagation).toHaveBeenCalled();
    expect(seekSpy).toHaveBeenCalledWith(42);
    expect(component.chapterDropdownOpen).toBeFalse();
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
    expect(postsServiceStub.getAllFiles.calls.mostRecent().args[6]).toBeFalse();
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
    expect(component.chapterTimelineVisible).toBeTrue();

    component.onPlayerMouseMove({ currentTarget: playerElement, clientY: 320 } as unknown as MouseEvent);
    expect(component.chapterTimelineVisible).toBeFalse();

    component.onPlayerMouseLeave();
    expect(component.chapterTimelineVisible).toBeFalse();
  });
});
