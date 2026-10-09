import { NO_ERRORS_SCHEMA } from '@angular/core';
import { ComponentFixture, TestBed, fakeAsync, tick, waitForAsync } from '@angular/core/testing';
import { MatDialog } from '@angular/material/dialog';
import { By } from '@angular/platform-browser';
import { ActivatedRoute, Router, convertToParamMap } from '@angular/router';
import { Observable, Subject, of, throwError } from 'rxjs';
import { DatabaseFile } from '../../api-types';
import { PostsService } from '../posts.services';
import { IChapter, IMedia, ISubtitleTrack, PlayerComponent } from './player.component';
import { MediaControlsComponent } from './media-controls/media-controls.component';
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
      incrementViewCount: vi.fn().mockReturnValue(of({success: true})),
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
      imports: [PlayerComponent],
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

  // The player's own bar, over the video.
  function controlBarButtons(): HTMLButtonElement[] {
    return Array.from(fixture.nativeElement.querySelectorAll('app-media-controls button'));
  }

  function theaterButton(): HTMLButtonElement | undefined {
    return controlBarButtons().find(button => button.getAttribute('aria-label') === 'Theater mode');
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

  it('records playback only when a video starts, once across pause and resume', async () => {
    postsServiceStub.getFile.mockReturnValue(of({file: {uid: 'f1', title: 'A video', isAudio: false, url: 'https://example.com/video'}}));
    component.uid = 'f1';
    component.getFile();
    fixture.detectChanges();
    await Promise.resolve();
    expect(postsServiceStub.incrementViewCount).not.toHaveBeenCalled();

    const media = fixture.nativeElement.querySelector('video') as HTMLVideoElement;
    media.dispatchEvent(new Event('playing'));
    media.dispatchEvent(new Event('pause'));
    media.dispatchEvent(new Event('playing'));

    expect(postsServiceStub.incrementViewCount).toHaveBeenCalledExactlyOnceWith('f1', null, null, null);
  });

  it('records each played queue item while leaving queued items alone', () => {
    component.playlist_id = 'playlist-1';
    component.file_objs = [{uid: 'f1', title: 'First'}, {uid: 'f2', title: 'Second'}] as DatabaseFile[];
    component.uids = ['f1', 'f2'];
    component.parseFileNames();
    component.onPlaybackStarted();
    expect(postsServiceStub.incrementViewCount).toHaveBeenCalledExactlyOnceWith('f1', null, null, 'playlist-1');

    component.updateCurrentItem(component.playlist[1], 1);
    expect(postsServiceStub.incrementViewCount).toHaveBeenCalledTimes(1);
    component.onPlaybackStarted();
    expect(postsServiceStub.incrementViewCount).toHaveBeenLastCalledWith('f2', null, null, 'playlist-1');
    expect(postsServiceStub.incrementViewCount).toHaveBeenCalledTimes(2);
  });

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

  it('should let the right-click menu loop the video and copy its short link', () => {
    postsServiceStub.path = 'https://media.example.com/api/';
    showPlayer();
    component.currentFile.share_id = 'AbCdEf12345';
    fixture.detectChanges();
    const controls: MediaControlsComponent = fixture.debugElement.query(By.directive(MediaControlsComponent)).componentInstance;

    expect(controls.shareLink).toBe('https://media.example.com/s/AbCdEf12345');
    expect(controls.loop).toBe(false);
    component.autoplay_enabled = true;
    controls.toggleLoop.emit();
    fixture.detectChanges();
    expect(component.repeat_enabled).toBe(true);
    expect(component.autoplay_enabled).toBe(false);
    expect(controls.loop).toBe(true);
  });

  it('should give no short link without one, or from someone else\'s library', () => {
    postsServiceStub.path = 'https://media.example.com/api/';
    component.currentFile = {uid: 'f1'} as DatabaseFile;
    expect(component.currentShareLink).toBeNull();

    component.currentFile = {uid: 'f1', share_id: 'AbCdEf12345'} as DatabaseFile;
    component.library = 'bob';
    expect(component.currentShareLink).toBeNull();
  });

  it('should share the file playing, and keep the queue when the dialog closes', () => {
    const closed = new Subject<void>();
    const dialogRef = {afterClosed: () => closed, componentInstance: {sharing_enabled: false}};
    matDialogStub.open.mockReturnValue(dialogRef);
    // Autoplay has moved on from the file the page opened with.
    component.uid = 'f1';
    component.db_file = {uid: 'f2', share_id: 'AbCdEf12345', sharingEnabled: false} as DatabaseFile;

    component.openShareDialog();
    expect(matDialogStub.open.mock.lastCall[1].data).toEqual(expect.objectContaining({
      uid: 'f2', share_id: 'AbCdEf12345', sharing_enabled: false, is_playlist: false
    }));

    dialogRef.componentInstance.sharing_enabled = true;
    closed.next();
    expect(component.db_file.sharingEnabled).toBe(true);
    expect(postsServiceStub.getFile).not.toHaveBeenCalled();
  });

  it('should mark the Autoplay toggle only while it is engaged', () => {
    showPlayer();
    component.db_file = {uid: 'f1', title: 'A video', url: 'https://example.com/watch', isAudio: false} as any;
    component.autoplay_enabled = true;
    fixture.detectChanges();
    expect(playlistAutoplayButtons()[0].classList.contains('active')).toBe(true);

    // Idle, it carries no marker at all, so it renders at the same colour as the actions
    // beside it rather than dimmed.
    component.autoplay_enabled = false;
    fixture.detectChanges();
    expect(playlistAutoplayButtons()[0].classList.contains('active')).toBe(false);
  });

  it('should mark playback toggles as pressed for assistive tech', () => {
    showPlayer();
    component.db_file = {uid: 'f1', title: 'A video', url: 'https://example.com/watch', isAudio: false} as any;
    component.theater_mode_enabled = true;
    component.autoplay_enabled = false;
    fixture.detectChanges();

    expect(theaterButton().getAttribute('aria-pressed')).toBe('true');
    expect(playlistAutoplayButtons()[0].getAttribute('aria-pressed')).toBe('false');
  });

  it('should keep autoplay clicks on the current playlist row without restarting playback', () => {
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
    // Loop is in the player's right-click menu, so Autoplay is the row's only playback mode.
    expect(playlistRows()[0].querySelectorAll('.playback-mode-button')).toHaveLength(1);
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

  describe('the list under the player', () => {
    function showTwo(overrides: Partial<DatabaseFile>[] = []): void {
      component.playlist_id = 'playlist-1';
      component.db_playlist = {id: 'playlist-1', name: 'Space Station', uids: ['f1', 'f2']} as any;
      component.file_objs = [
        {uid: 'f1', title: 'First video', isAudio: false, url: 'https://example.com/first', uploader: 'NASA', duration: 1504, thumbnailPath: 'video/f1.jpg', ...overrides[0]} as DatabaseFile,
        {uid: 'f2', title: 'Second video', isAudio: false, url: 'https://example.com/second', uploader: 'ESA', duration: '4:03', thumbnailURL: 'https://example.com/f2.jpg', ...overrides[1]} as DatabaseFile
      ];
      component.uids = ['f1', 'f2'];
      component.parseFileNames();
      fixture.detectChanges();
    }

    const text = (element: Element | null) => element?.textContent.replace(/\s+/g, ' ').trim();

    it('is headed by what is playing and where it is in it', () => {
      showTwo();

      expect(text(playerPlaylist().querySelector('.queue-title'))).toBe('Space Station');
      expect(text(playerPlaylist().querySelector('.queue-meta'))).toBe('1 of 2');

      component.onClickPlaylistItem(component.playlist[1], 1);
      fixture.detectChanges();
      expect(text(playerPlaylist().querySelector('.queue-meta'))).toBe('2 of 2');
    });

    it('shows each file the way the library does: thumbnail, title, uploader and length', () => {
      showTwo();

      const [first, second] = playlistRows();
      expect(first.querySelector('img').getAttribute('src')).toBe('/api/thumbnail/f1');
      expect(second.querySelector('img').getAttribute('src')).toBe('https://example.com/f2.jpg');
      expect(text(first.querySelector('.queue-item-title'))).toBe('First video');
      expect(text(first.querySelector('.queue-item-meta'))).toBe('NASA');
      expect(text(first.querySelector('.queue-duration'))).toBe('25:04');
      expect(text(second.querySelector('.queue-duration'))).toBe('4:03');
    });

    it('marks the playing row, and plays another when it is clicked', () => {
      showTwo();

      const buttons = () => playlistRows().map(row => row.querySelector('.queue-item') as HTMLButtonElement);
      expect(buttons()[0].getAttribute('aria-current')).toBe('true');
      expect(buttons()[1].hasAttribute('aria-current')).toBe(false);
      expect(text(playlistRows()[1].querySelector('.queue-position'))).toBe('2');

      buttons()[1].click();
      fixture.detectChanges();

      expect(component.currentItem.uid).toBe('f2');
      expect(buttons()[0].hasAttribute('aria-current')).toBe(false);
      expect(buttons()[1].getAttribute('aria-current')).toBe('true');
      expect(text(playlistRows()[0].querySelector('.queue-position'))).toBe('1');
    });

    it('shows an icon for a thumbnail that is missing or will not load', () => {
      showTwo([{thumbnailPath: null}, {}]);

      expect(playlistRows()[0].querySelector('img')).toBeNull();
      expect(text(playlistRows()[0].querySelector('.queue-thumb mat-icon'))).toBe('movie');

      playlistRows()[1].querySelector('img').dispatchEvent(new Event('error'));
      fixture.detectChanges();
      expect(playlistRows()[1].querySelector('img')).toBeNull();
      expect(text(playlistRows()[1].querySelector('.queue-thumb mat-icon'))).toBe('movie');
    });

    it('lets a touch screen scroll the list, dragging a row only after a press and hold', () => {
      expect(component.dragStartDelay).toEqual({touch: 400, mouse: 0});
    });

    it('says what Autoplay would do for a file played on its own', () => {
      component.uid = 'f1';
      component.db_file = {uid: 'f1', title: 'A video', isAudio: false, url: 'https://example.com/video'} as DatabaseFile;
      component.uids = ['f1'];
      component.autoplay_enabled = false;
      component.parseFileNames();
      fixture.detectChanges();

      expect(text(playerPlaylist().querySelector('.queue-title'))).toBe('Now playing');
      expect(text(playerPlaylist().querySelector('.queue-meta'))).toBe('Turn on Autoplay to keep playing from your library.');
    });

    it('becomes the library once Autoplay has queued it', () => {
      const library = new Subject<any>();
      postsServiceStub.getAllFiles.mockReturnValue(library.asObservable());
      component.uid = 'f2';
      component.db_file = {uid: 'f2', title: 'Second video', isAudio: false, url: 'https://example.com/second'} as DatabaseFile;
      component.uids = ['f2'];
      component.autoplay_enabled = false;
      component.parseFileNames();
      fixture.detectChanges();

      playlistAutoplayButtons()[0].click();
      fixture.detectChanges();
      expect(text(playerPlaylist().querySelector('.queue-meta'))).toBe('Loading your library…');

      library.next({files: [
        {uid: 'f1', title: 'First video', isAudio: false, url: 'https://example.com/first'},
        {uid: 'f2', title: 'Second video', isAudio: false, url: 'https://example.com/second'},
        {uid: 'f3', title: 'Third video', isAudio: false, url: 'https://example.com/third'}
      ]});
      fixture.detectChanges();

      expect(text(playerPlaylist().querySelector('.queue-title'))).toBe('Library');
      expect(text(playerPlaylist().querySelector('.queue-meta'))).toBe('2 of 3');
      expect(playlistRows()).toHaveLength(3);
      expect(playlistRows()[1].querySelector('.queue-item').getAttribute('aria-current')).toBe('true');
    });

    it('scrolls the list, not the page, to a playing row that is out of sight', () => {
      showTwo();
      const list = playerPlaylist().querySelector('.queue-list') as HTMLElement;
      const row = playlistRows()[1];
      Object.defineProperty(list, 'scrollHeight', {configurable: true, value: 600});
      Object.defineProperty(list, 'clientHeight', {configurable: true, value: 200});
      Object.defineProperty(row, 'offsetTop', {configurable: true, value: 400});
      Object.defineProperty(row, 'offsetHeight', {configurable: true, value: 66});
      Object.defineProperty(list, 'scrollTop', {configurable: true, writable: true, value: 0});
      const pageScroll = vi.spyOn(window, 'scrollTo');

      component.onClickPlaylistItem(component.playlist[1], 1);
      fixture.detectChanges();

      expect(list.scrollTop).toBe(392);
      expect(pageScroll).not.toHaveBeenCalled();
    });
  });

  it('should put theater mode in the player\'s own bar and make the video the only visible player content', () => {
    showPlayer();
    component.db_file = {uid: 'f1', title: 'A video', url: 'https://example.com/watch', isAudio: false} as DatabaseFile;
    component.media_ready = true;
    postsServiceStub.isLoggedIn = false;
    fixture.detectChanges();

    const buttons = actionBarButtons();
    const downloadIndex = buttons.findIndex(button => button.getAttribute('aria-label') === 'Download this file');
    const shareIndex = buttons.findIndex(button => button.getAttribute('aria-label') === 'Share');
    expect(buttons.some(button => button.getAttribute('aria-label') === 'Theater mode')).toBe(false);
    expect(downloadIndex).toBe(0);
    expect(shareIndex).toBe(downloadIndex + 1);

    theaterButton().click();
    fixture.detectChanges();

    expect(component.theater_mode_enabled).toBe(true);
    expect(theaterButton().getAttribute('aria-pressed')).toBe('true');
    expect(playerPage()?.classList.contains('theater-mode-active')).toBe(true);
    expect(document.body.classList.contains('player-theater-mode-active')).toBe(true);
    expect(playerToolbar()?.classList.contains('theater-toolbar-visible')).toBe(false);
    expect(playerPlaylist()?.hidden).toBe(true);
    expect(fixture.nativeElement.querySelector('app-concurrent-stream')?.closest('.player-playlist-section')?.hidden).toBe(true);
    expect(fixture.nativeElement.querySelector('.video-player')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('.video-blackout-overlay')).toBeFalsy();
    expect(component.currentItem?.uid).toBe('f1');
  });

  it('should reveal the theater toolbar on video hover, keep it usable, and hide it after inactivity', fakeAsync(() => {
    showPlayer();
    component.db_file = {uid: 'f1', title: 'A video', url: 'https://example.com/watch', isAudio: false} as DatabaseFile;
    fixture.detectChanges();

    const theaterMode = theaterButton();
    theaterMode.focus();
    expect(document.activeElement).toBe(theaterMode);
    theaterMode.click();
    fixture.detectChanges();

    expect(playerToolbar()?.classList.contains('theater-toolbar-visible')).toBe(false);
    expect(document.activeElement).not.toBe(theaterMode);
    expect(playerPlaylist()?.hidden).toBe(true);

    component.onPlayerMouseMove();
    fixture.detectChanges();

    expect(playerToolbar()?.classList.contains('theater-toolbar-visible')).toBe(true);

    component.onTheaterToolbarMouseEnter();
    tick(2500);
    fixture.detectChanges();
    expect(playerToolbar()?.classList.contains('theater-toolbar-visible')).toBe(true);

    component.onTheaterToolbarMouseLeave();
    tick(2000);
    fixture.detectChanges();
    expect(playerToolbar()?.classList.contains('theater-toolbar-visible')).toBe(false);
  }));

  it('should exit theater mode with Escape and restore the surrounding controls', () => {
    showPlayer();
    component.db_file = {uid: 'f1', title: 'A video', url: 'https://example.com/watch', isAudio: false} as DatabaseFile;
    fixture.detectChanges();

    theaterButton().click();
    fixture.detectChanges();
    document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape'}));
    fixture.detectChanges();

    expect(component.theater_mode_enabled).toBe(false);
    expect(document.body.classList.contains('player-theater-mode-active')).toBe(false);
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

    // An audio file keeps the browser's own bar, so the player's is not there to offer it either.
    expect(fixture.nativeElement.querySelector('app-media-controls')).toBeNull();
    expect(fixture.nativeElement.querySelector('video').controls).toBe(true);
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
    expect(theaterButton()).toBeDefined();
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

  describe('playing from someone else\'s library', () => {
    beforeEach(() => {
      component.library = 'bob';
      component.baseStreamPath = '/api/';
    });

    it('should ask for its media from that library', () => {
      postsServiceStub.isLoggedIn = true;
      postsServiceStub.token = 'token';

      expect(component.createStreamURL({uid: 'f1', isAudio: false} as DatabaseFile)).toBe('/api/stream?uid=f1&type=video&jwt=token&library=bob');
      expect(component.createSubtitleTrackURL('f1', 0)).toBe('/api/streamSubtitle?uid=f1&index=0&jwt=token&library=bob');
    });

    it('should queue the rest of that library for autoplay', () => {
      const media: IMedia = {title: 'Single file', src: '/stream/test', type: 'video/mp4', label: 'Single file', url: 'https://example.com/video', uid: 'uid-single'};
      component.uid = 'uid-single';
      component.playlist = [media];
      component.currentItem = media;
      component.autoplay_enabled = true;
      component.autoplay_queue_initialized = false;
      component.autoplay_queue_loading = false;

      component.ensureAutoplayQueueReady();

      expect(vi.mocked(postsServiceStub.getAllFiles).mock.lastCall[8]).toBe('bob');
    });

    it('should not count a view of a file that is not the viewer\'s', () => {
      postsServiceStub.incrementViewCount = vi.fn();
      postsServiceStub.getFile.mockReturnValue(of({file: {uid: 'f1', title: 'A video', isAudio: false, url: 'https://example.com/video'}}));
      component.uid = 'f1';

      component.getFile();
      component.onPlaybackStarted();

      expect(postsServiceStub.getFile).toHaveBeenLastCalledWith('f1', null, 'bob');
      expect(postsServiceStub.incrementViewCount).not.toHaveBeenCalled();
    });

    it('should offer nothing that would copy, share or change it', () => {
      postsServiceStub.isLoggedIn = true;
      postsServiceStub.permissions = ['sharing'];
      showPlayer();
      component.db_file = {uid: 'f1', title: 'A video', url: 'https://www.twitch.tv/videos/1', isAudio: false} as any;
      fixture.detectChanges();

      const icons = actionBarButtons().map(button => button.querySelector('mat-icon')?.textContent.trim());
      expect(icons).toContain('info');
      for (const icon of ['cloud_download', 'folder_zip', 'share', 'chat']) {
        expect(icons).not.toContain(icon);
      }
      expect(component.canSnipCurrentFile()).toBe(false);
    });
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
    component.mediaElement = { nativeElement: { currentTime: 45 } } as any;

    const chapter = component.getCurrentChapter();

    expect(chapter?.title).toBe('Part 2');
  });

  it('should return first chapter when no active chapter is available', () => {
    component.currentChapters = [
      { title: 'Intro', start_time: 0, end_time: 30 },
      { title: 'Part 2', start_time: 30, end_time: 90 }
    ];
    component.mediaElement = undefined;

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

    component.onPlayerReady(component.mediaElement.nativeElement);
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
    component.mediaElement = { nativeElement: { currentTime: 0 } } as any;
    component.chapterDropdownOpen = true;
    const chapter: IChapter = { title: 'Part 2', start_time: 42.9, end_time: 84.2 };
    const clickEvent = { stopPropagation: vi.fn().mockName('stopPropagation') } as unknown as MouseEvent;

    component.selectChapterFromDropdown(chapter, clickEvent);

    expect(clickEvent.stopPropagation).toHaveBeenCalled();
    expect(component.media.currentTime).toBe(42);
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
    component.mediaElement = { nativeElement: { currentTime: 45 } } as any;

    component.refreshCurrentChapterState();

    expect(component.activeChapterIndex).toBe(1);
    expect(component.currentChapterLabel).toBe('Part 2');

    component.mediaElement = { nativeElement: { currentTime: 5 } } as any;
    component.onPlaybackTimeUpdate();

    expect(component.activeChapterIndex).toBe(0);
    expect(component.currentChapterLabel).toBe('Intro');
  });

  describe('snip mode', () => {
    let seeks: number[];

    beforeEach(() => {
      component.currentFile = { uid: 'file-uid', duration: 120 } as DatabaseFile;
      seeks = [];
      const media = {
        play: vi.fn().mockName('play').mockResolvedValue(undefined),
        pause: vi.fn().mockName('pause')
      };
      Object.defineProperty(media, 'currentTime', {get: () => seeks.at(-1) ?? 0, set: time => seeks.push(time)});
      component.mediaElement = { nativeElement: media } as any;
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
      expect(seeks).toEqual([25]);
    }));

    it('coalesces seeks while a knob is being dragged', fakeAsync(() => {
      component.onSnipStartChange(20);
      component.onSnipStartChange(25);
      component.onSnipStartChange(30);
      tick(200);

      expect(seeks).toEqual([30]);
    }));

    it('does not offer snipping on media too short to trim', () => {
      component.currentFile = { uid: 'file-uid', duration: 0.5 } as DatabaseFile;
      expect(component.canSnipCurrentFile()).toBe(false);
    });
  });

  // A cast device such as a Chromecast under Chrome on Android fetches the file itself, so what
  // matters is the URL in the <video> when it is handed over.
  describe('casting', () => {
    let remote: EventTarget & {state: RemotePlaybackState};
    // Every value the player set disableRemotePlayback to, which is how it ends a session.
    let disable_toggles: boolean[];

    function showTwo(overrides: Partial<DatabaseFile>[] = []): void {
      component.playlist_id = 'playlist-1';
      component.db_playlist = {id: 'playlist-1', name: 'Space Station', uids: ['f1', 'f2']} as any;
      component.file_objs = [
        {uid: 'f1', title: 'First video', isAudio: false, url: 'https://example.com/first', ...overrides[0]} as DatabaseFile,
        {uid: 'f2', title: 'Second video', isAudio: false, url: 'https://example.com/second', ...overrides[1]} as DatabaseFile
      ];
      component.uids = ['f1', 'f2'];
      component.parseFileNames();
      fixture.detectChanges();
      tick();
    }

    function logIn(permissions = ['sharing']): void {
      postsServiceStub.isLoggedIn = true;
      postsServiceStub.token = 'session-jwt';
      postsServiceStub.permissions = permissions;
      postsServiceStub.hasPermission = vi.fn().mockName('hasPermission')
        .mockImplementation((permission: string) => permissions.includes(permission));
    }

    function linkFor(uid: string, extra: object = {}) {
      return {uid, stream_path: `/api/stream?uid=${uid}&playback_token=token-${uid}`, expires_at: 0, ...extra};
    }

    function video(): HTMLVideoElement {
      return fixture.nativeElement.querySelector('video');
    }

    function src(): string {
      fixture.detectChanges();
      return video().getAttribute('src');
    }

    function makeCastable(): void {
      remote = Object.assign(new EventTarget(), {state: 'disconnected' as RemotePlaybackState});
      disable_toggles = [];
      Object.defineProperty(video(), 'remote', {value: remote, configurable: true});
      Object.defineProperty(video(), 'disableRemotePlayback', {
        configurable: true,
        get: () => false,
        set: (value: boolean) => disable_toggles.push(value)
      });
    }

    // The player plays from the new source, and only then says it can be cast.
    function load(): void {
      tick();
      fixture.detectChanges();
      video().dispatchEvent(new Event('loadedmetadata'));
      fixture.detectChanges();
    }

    // Every time disableremoteplayback goes on or off the <video>, whoever sets it.
    function attributeToggles(): string[] {
      const toggles: string[] = [];
      const media = video();
      const set_attribute = media.setAttribute.bind(media);
      const remove_attribute = media.removeAttribute.bind(media);
      vi.spyOn(media, 'setAttribute').mockImplementation((name: string, value: string) => {
        if (name === 'disableremoteplayback') toggles.push('on');
        set_attribute(name, value);
      });
      vi.spyOn(media, 'removeAttribute').mockImplementation((name: string) => {
        if (name === 'disableremoteplayback') toggles.push('off');
        remove_attribute(name);
      });
      return toggles;
    }

    it('has the browser look for cast devices for every video it loads, the next in the queue too', fakeAsync(() => {
      showTwo();
      const toggles = attributeToggles();
      load();
      expect(toggles).toEqual(['on', 'off']);
      expect(video().hasAttribute('disableremoteplayback')).toBe(false);

      component.advanceToNextVideo();
      load();
      expect(toggles).toEqual(['on', 'off', 'on', 'off']);
    }));

    it('leaves remote playback alone during a cast, and for audio', fakeAsync(() => {
      showTwo([{}, {isAudio: true}]);
      makeCastable();
      const toggles = attributeToggles();
      remote.state = 'connected';
      load();
      expect(toggles).toEqual([]);

      remote.state = 'disconnected';
      component.advanceToNextVideo();
      load();
      expect(component.currentItem.type).toBe('audio/mp3');
      expect(toggles).toEqual([]);
    }));

    it('lets the file\'s own URL go as it is when it carries no login', fakeAsync(() => {
      showTwo();
      expect(component.castSource).toBe('ready');
      expect(src()).toBe('/api/stream?uid=f1&type=video&playlist_id=playlist-1');
    }));

    it('keeps the custom controls and cast button on desktop', fakeAsync(() => {
      showTwo();
      expect(video().controls).toBe(false);
      expect(video().getAttribute('controlslist')).toBe('noremoteplayback');
      expect(fixture.nativeElement.querySelector('app-media-controls')).not.toBeNull();
    }));

    describe('Android native controls', () => {
      beforeEach(() => {
        fixture.destroy();
        vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Linux; Android 14) Vivaldi/7.9');
        fixture = TestBed.createComponent(PlayerComponent);
        component = fixture.componentInstance;
        fixture.detectChanges();
      });

      afterEach(() => vi.restoreAllMocks());

      const castButton = (): HTMLButtonElement | null =>
        fixture.nativeElement.querySelector('.action-buttons-row button[aria-label="Cast"]');

      it('exposes the browser controls without a covering custom player, and puts the cast glyph first in the row below', fakeAsync(() => {
        showTwo();
        expect(video().remote).toBeUndefined();
        expect(video().controls).toBe(true);
        expect(video().getAttribute('controlslist')).toBeNull();
        expect(video().hasAttribute('disableremoteplayback')).toBe(false);
        expect(fixture.nativeElement.querySelector('app-media-controls')).toBeNull();
        const row = Array.from(fixture.nativeElement.querySelectorAll('.action-buttons-row button') as NodeListOf<HTMLButtonElement>)
          .map(button => button.getAttribute('aria-label'));
        expect(row[0]).toBe('Cast');
        expect(row).toContain('Download the whole playlist as a zip');
        expect(castButton().textContent.trim()).toBe('cast');
      }));

      const READY = "Ready to cast. Select Cast in the video's ⋮ menu.";
      const NOT_FOUND = "No cast device found yet. Cast appears in the video's ⋮ menu once your browser finds one.";
      const UNCONFIRMED = "Select Cast in the video's ⋮ menu, if your browser has it.";

      // The browser's Remote Playback on the video, which reports a device only when the test does.
      function watchable() {
        const remote = {
          state: 'disconnected',
          prompt: vi.fn(),
          watchAvailability: vi.fn((_callback: (available: boolean) => void) => Promise.resolve(7)),
          cancelWatchAvailability: vi.fn(() => Promise.resolve())
        };
        Object.defineProperty(video(), 'remote', {value: remote, configurable: true});
        return {remote, report: (available: boolean) => remote.watchAvailability.mock.calls.at(-1)[0](available)};
      }

      function prepareHevc() {
        logIn();
        postsServiceStub.createPlaybackLink = vi.fn().mockReturnValue(of(linkFor('f1')));
        showTwo([{vcodec: 'hevc', acodec: 'aac'}]);
        const cast = watchable();
        castButton().click();
        load();
        tick();
        return cast;
      }

      it('swaps in a playback link for HEVC as it is, and says it can be cast once the browser finds a device', fakeAsync(() => {
        logIn();
        postsServiceStub.createPlaybackLink = vi.fn().mockReturnValue(of(linkFor('f1')));
        showTwo([{vcodec: 'hevc', acodec: 'aac'}]);
        const original_video = video();
        const {remote, report} = watchable();
        original_video.currentTime = 42;
        expect(original_video.hasAttribute('disableremoteplayback')).toBe(true);

        castButton().click();
        fixture.detectChanges();
        expect(fixture.nativeElement.querySelector('button[aria-label="Getting the file ready to cast"]').disabled).toBe(true);
        expect(fixture.nativeElement.querySelector('.action-buttons-row .spinner')).not.toBeNull();
        load();
        tick();

        expect(postsServiceStub.createPlaybackLink).toHaveBeenCalledWith('f1', false);
        expect(video()).toBe(original_video);
        expect(video().currentTime).toBe(42);
        expect(src()).toContain('playback_token=token-f1');
        expect(src()).not.toContain('jwt=');
        expect(video().hasAttribute('disableremoteplayback')).toBe(false);
        expect(castButton().disabled).toBe(false);
        expect(fixture.nativeElement.querySelector('.action-buttons-row .spinner')).toBeNull();
        expect(remote.prompt).not.toHaveBeenCalled();
        // Loaded is not found: the browser has yet to say it has a device for the new source.
        report(false);
        expect(postsServiceStub.openSnackBar).not.toHaveBeenCalled();

        report(true);
        expect(postsServiceStub.openSnackBar.mock.calls).toEqual([[READY]]);
        expect(remote.cancelWatchAvailability).toHaveBeenCalledWith(7);
        tick(5000);
        expect(postsServiceStub.openSnackBar).toHaveBeenCalledOnce();

        component.advanceToNextVideo();
        fixture.detectChanges();
        expect(src()).toContain('uid=f2');
        expect(video().hasAttribute('disableremoteplayback')).toBe(true);
        expect(castButton()).not.toBeNull();
      }));

      it('gives the instructions again from the glyph, without asking for another link', fakeAsync(() => {
        const {remote, report} = prepareHevc();
        report(true);
        castButton().click();
        tick();
        report(true);

        expect(postsServiceStub.createPlaybackLink).toHaveBeenCalledOnce();
        expect(remote.watchAvailability).toHaveBeenCalledTimes(2);
        expect(postsServiceStub.openSnackBar.mock.calls).toEqual([[READY], [READY]]);
      }));

      it('gives the instructions straight away for a file that needs nothing done', fakeAsync(() => {
        postsServiceStub.createPlaybackLink = vi.fn();
        showTwo([{vcodec: 'hevc', acodec: 'aac'}]);
        const {report} = watchable();
        castButton().click();
        tick();
        report(true);

        expect(postsServiceStub.createPlaybackLink).not.toHaveBeenCalled();
        expect(postsServiceStub.openSnackBar.mock.calls).toEqual([[READY]]);
      }));

      it('never lifts disableremoteplayback off a URL with the login in it, and has the browser look for devices for the link', fakeAsync(() => {
        logIn();
        postsServiceStub.createPlaybackLink = vi.fn().mockReturnValue(of(linkFor('f1')));
        showTwo();
        const toggles = attributeToggles();
        load();
        expect(toggles).toEqual([]);
        expect(video().hasAttribute('disableremoteplayback')).toBe(true);

        castButton().click();
        load();
        // Lifted with the link swapped in, then switched on and off once it has loaded.
        expect(toggles).toEqual(['off', 'on', 'off']);
        expect(video().hasAttribute('disableremoteplayback')).toBe(false);
      }));

      it('says no device has been found when the browser reports none in time', fakeAsync(() => {
        const {remote, report} = prepareHevc();
        report(false);
        tick(4999);
        expect(postsServiceStub.openSnackBar).not.toHaveBeenCalled();

        tick(1);
        expect(postsServiceStub.openSnackBar.mock.calls).toEqual([[NOT_FOUND]]);
        expect(remote.cancelWatchAvailability).toHaveBeenCalledWith(7);
        report(true);
        expect(postsServiceStub.openSnackBar).toHaveBeenCalledOnce();
      }));

      it('says nothing about a device found for a file that is no longer playing', fakeAsync(() => {
        const {remote, report} = prepareHevc();
        component.advanceToNextVideo();
        fixture.detectChanges();

        report(true);
        tick(5000);
        expect(postsServiceStub.openSnackBar).not.toHaveBeenCalled();
        expect(remote.cancelWatchAvailability).toHaveBeenCalledWith(7);
      }));

      it('points to Cast straight away on a phone that does not look for devices in the background', fakeAsync(() => {
        logIn();
        postsServiceStub.createPlaybackLink = vi.fn().mockReturnValue(of(linkFor('f1')));
        showTwo([{vcodec: 'hevc', acodec: 'aac'}]);
        const {remote} = watchable();
        remote.watchAvailability.mockImplementation(() =>
          Promise.reject(new DOMException('Availability monitoring is not supported on this device.', 'NotSupportedError')));
        castButton().click();
        load();
        tick();

        expect(postsServiceStub.openSnackBar.mock.calls).toEqual([[READY]]);
      }));

      it('makes a compatible copy for AV1, and only hedges without the Remote Playback API', fakeAsync(() => {
        postsServiceStub.createPlaybackLink = vi.fn().mockReturnValue(of(linkFor('f1', {transcode: true, ready: true})));
        showTwo([{vcodec: 'av1'}]);

        castButton().click();
        load();

        expect(postsServiceStub.createPlaybackLink).toHaveBeenCalledWith('f1', true);
        expect(src()).toContain('playback_token=token-f1');
        expect(video().controls).toBe(true);
        expect(video().hasAttribute('disableremoteplayback')).toBe(false);
        expect(postsServiceStub.openSnackBar.mock.calls).toEqual([[UNCONFIRMED]]);

        castButton().click();
        expect(postsServiceStub.createPlaybackLink).toHaveBeenCalledOnce();
        expect(postsServiceStub.openSnackBar.mock.calls).toEqual([[UNCONFIRMED], [UNCONFIRMED]]);
      }));

      it('keeps native casting disabled when a playback link is refused', fakeAsync(() => {
        logIn();
        postsServiceStub.createPlaybackLink = vi.fn().mockReturnValue(throwError(() => ({status: 403})));
        showTwo();
        castButton().click();
        tick();
        fixture.detectChanges();

        expect(video().controls).toBe(true);
        expect(video().hasAttribute('disableremoteplayback')).toBe(true);
        expect(castButton()).toBeNull();
        expect(postsServiceStub.openSnackBar).toHaveBeenCalledWith("This file can't be cast.");
      }));

      it('disables native casting for a library without permission to issue playback links', fakeAsync(() => {
        logIn([]);
        showTwo();
        expect(video().controls).toBe(true);
        expect(video().hasAttribute('disableremoteplayback')).toBe(true);
        expect(castButton()).toBeNull();
      }));
    });

    it('swaps in a playback link from where it had got to before casting a URL with the login in it', fakeAsync(() => {
      logIn();
      postsServiceStub.createPlaybackLink = vi.fn().mockName('createPlaybackLink').mockReturnValue(of(linkFor('f1')));
      showTwo();
      makeCastable();
      expect(component.castSource).toBe('needs-link');
      expect(src()).toContain('jwt=session-jwt');
      video().currentTime = 42;

      component.prepareCast({transcode: false});
      expect(component.castSource).toBe('preparing');
      load();

      expect(postsServiceStub.createPlaybackLink).toHaveBeenCalledWith('f1', false);
      expect(src()).toMatch(/^https?:\/\/[^/]+\/api\/stream\?uid=f1&playback_token=token-f1$/);
      expect(video().currentTime).toBe(42);
      expect(component.castSource).toBe('ready');
    }));

    it('waits out a transcoding link until its copy is made, then swaps the copy in', fakeAsync(() => {
      postsServiceStub.createPlaybackLink = vi.fn().mockName('createPlaybackLink')
        .mockReturnValue(of(linkFor('f1', {transcode: true, ready: false})));
      let checks = 0;
      postsServiceStub.checkPlaybackLink = vi.fn().mockName('checkPlaybackLink')
        .mockImplementation(() => ++checks < 3 ? throwError(() => ({status: 503})) : of({status: 200}));
      showTwo();

      component.prepareCast({transcode: true});
      tick();
      expect(postsServiceStub.createPlaybackLink).toHaveBeenCalledWith('f1', true);
      expect(component.castSource).toBe('preparing');
      tick(10000);
      expect(src()).not.toContain('playback_token');
      tick(10000);
      load();

      expect(checks).toBe(3);
      expect(src()).toContain('playback_token=token-f1');
      expect(component.castSource).toBe('ready');
      expect(postsServiceStub.openSnackBar).toHaveBeenCalledWith('Making a copy of this file that your cast device can play. This can take a while.');
    }));

    it('shows why a cast did not start', fakeAsync(() => {
      showTwo();
      const controls = fixture.debugElement.query(By.directive(MediaControlsComponent)).componentInstance as MediaControlsComponent;
      controls.castMessage.emit('Your browser did not open its cast picker.');
      expect(postsServiceStub.openSnackBar).toHaveBeenCalledWith('Your browser did not open its cast picker.');
    }));

    it('stops polling for a copy once another file is playing', fakeAsync(() => {
      postsServiceStub.createPlaybackLink = vi.fn().mockName('createPlaybackLink')
        .mockReturnValue(of(linkFor('f1', {transcode: true, ready: false})));
      postsServiceStub.checkPlaybackLink = vi.fn().mockName('checkPlaybackLink').mockReturnValue(throwError(() => ({status: 503})));
      showTwo();

      component.prepareCast({transcode: true});
      tick();
      component.advanceToNextVideo();
      tick(30000);

      expect(postsServiceStub.checkPlaybackLink).toHaveBeenCalledTimes(1);
      expect(src()).toBe('/api/stream?uid=f2&type=video&playlist_id=playlist-1');
    }));

    it('keeps a cast going onto the next file through that file\'s own link', fakeAsync(() => {
      logIn();
      const next_link = new Subject<ReturnType<typeof linkFor>>();
      postsServiceStub.createPlaybackLink = vi.fn().mockName('createPlaybackLink')
        .mockImplementation((uid: string) => uid === 'f1' ? of(linkFor('f1')) : next_link);
      showTwo();
      makeCastable();
      component.prepareCast({transcode: false});
      load();
      remote.state = 'connected';

      component.advanceToNextVideo();
      tick();
      // Until the next file's link is in, the <video> stays on the last file's.
      expect(src()).toContain('playback_token=token-f1');
      expect(component.castSource).toBe('preparing');

      next_link.next(linkFor('f2'));
      next_link.complete();
      load();

      expect(src()).toContain('playback_token=token-f2');
      expect(src()).not.toContain('jwt');
      expect(disable_toggles).toEqual([]);
    }));

    it('ends the cast before a URL with the login in it loads, when the next file gets no link', fakeAsync(() => {
      logIn();
      postsServiceStub.createPlaybackLink = vi.fn().mockName('createPlaybackLink')
        .mockImplementation((uid: string) => uid === 'f1' ? of(linkFor('f1')) : throwError(() => ({status: 404})));
      showTwo();
      makeCastable();
      component.prepareCast({transcode: false});
      load();
      remote.state = 'connected';

      component.advanceToNextVideo();
      tick();

      expect(disable_toggles).toEqual([true, false]);
      expect(src()).toContain('uid=f2&type=video&jwt=session-jwt');
      expect(component.castSource).toBe('unavailable');
    }));

    it('stops the cast rather than move it to an AV1 file whose copy is not made yet', fakeAsync(() => {
      postsServiceStub.createPlaybackLink = vi.fn().mockName('createPlaybackLink')
        .mockReturnValue(of(linkFor('f2', {transcode: true, ready: false})));
      showTwo([{}, {vcodec: 'av1'}]);
      makeCastable();
      remote.state = 'connected';

      component.advanceToNextVideo();
      expect(src()).toBe('/api/stream?uid=f1&type=video&playlist_id=playlist-1');
      tick();

      expect(postsServiceStub.createPlaybackLink).toHaveBeenCalledWith('f2', true);
      expect(disable_toggles).toEqual([true, false]);
      expect(src()).toBe('/api/stream?uid=f2&type=video&playlist_id=playlist-1');
    }));

    it('goes back to the file\'s own URL, from where it stopped, once a playback link stops working', fakeAsync(() => {
      logIn();
      postsServiceStub.createPlaybackLink = vi.fn().mockName('createPlaybackLink').mockReturnValue(of(linkFor('f1')));
      showTwo();
      makeCastable();
      component.prepareCast({transcode: false});
      load();
      video().currentTime = 30;

      video().dispatchEvent(new Event('error'));
      load();

      expect(src()).toContain('jwt=session-jwt');
      expect(video().currentTime).toBe(30);
      expect(component.castSource).toBe('needs-link');
    }));

    it('offers no cast where no link can be had: without the sharing permission, or in someone else\'s library', fakeAsync(() => {
      logIn([]);
      showTwo();
      expect(component.castSource).toBe('unavailable');

      postsServiceStub.hasPermission.mockReturnValue(true);
      component.library = 'someone-else';
      component.advanceToNextVideo();
      expect(component.castSource).toBe('unavailable');
    }));

    it('says why a link was refused, and hides the button only when it will be refused again', fakeAsync(() => {
      logIn();
      postsServiceStub.createPlaybackLink = vi.fn().mockName('createPlaybackLink').mockReturnValue(throwError(() => ({status: 503})));
      showTwo();

      component.prepareCast({transcode: false});
      tick();
      expect(component.castSource).toBe('needs-link');
      expect(postsServiceStub.openSnackBar).toHaveBeenCalledWith('Too many playback links are active. Try again later.');

      postsServiceStub.createPlaybackLink.mockReturnValue(throwError(() => ({status: 403})));
      component.prepareCast({transcode: false});
      tick();
      expect(component.castSource).toBe('unavailable');
    }));
  });
});
