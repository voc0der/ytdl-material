import { NO_ERRORS_SCHEMA } from '@angular/core';
import { ComponentFixture, TestBed, waitForAsync } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { MatDialog } from '@angular/material/dialog';
import { MatMenuTrigger } from '@angular/material/menu';
import { OverlayContainer } from '@angular/cdk/overlay';

import { getListCardHeight, UnifiedFileCardComponent } from './unified-file-card.component';
import { configureTestBed } from '../../../testing/test-bed';

describe('UnifiedFileCardComponent', () => {
  let component: UnifiedFileCardComponent;
  let fixture: ComponentFixture<UnifiedFileCardComponent>;

  beforeEach(waitForAsync(() => {
    configureTestBed({
      imports: [ UnifiedFileCardComponent ],
      providers: [
        { provide: MatDialog, useValue: {} }
      ],
      schemas: [NO_ERRORS_SCHEMA]
    })
    .compileComponents();
  }));

  beforeEach(() => {
    fixture = TestBed.createComponent(UnifiedFileCardComponent);
    component = fixture.componentInstance;
    component.theme = {
      ghost_primary: '#000000',
      ghost_secondary: '#111111'
    } as any;
  });


  // "Add to playlist" is a nested lazy menu inside the card's own lazy action menu, so both
  // have to be opened before the playlist buttons exist anywhere to assert on.
  function openAddToPlaylistMenu(): HTMLButtonElement[] {
    const outer = fixture.debugElement.query(By.css('button.menuButton'));
    outer.injector.get(MatMenuTrigger).openMenu();
    fixture.detectChanges();

    const nested = fixture.debugElement.queryAll(By.directive(MatMenuTrigger))
      .find(candidate => candidate.nativeElement.textContent.includes('Add to playlist'));
    expect(nested).toBeDefined();
    nested.injector.get(MatMenuTrigger).openMenu();
    fixture.detectChanges();

    const panels = TestBed.inject(OverlayContainer).getContainerElement()
      .querySelectorAll('.mat-mdc-menu-panel');
    const playlist_panel = panels[panels.length - 1];
    return Array.from(playlist_panel.querySelectorAll('button.mat-mdc-menu-item'));
  }

  function setUpFileCard(file_obj: any, playlists: any[] = [{id: 'p1', name: 'Alpha', uids: []}, {id: 'p2', name: 'Beta', uids: []}]): void {
    component.loading = false;
    component.is_playlist = false;
    component.availablePlaylists = playlists as any;
    component.file_obj = file_obj;
    fixture.detectChanges();
  }

  it('should offer every playlist for a video file', () => {
    setUpFileCard({uid: 'f1', title: 'A video', isAudio: false, registered: Date.now(), duration: 5});

    expect(openAddToPlaylistMenu().map(button => button.textContent.trim())).toEqual(['Alpha', 'Beta']);
  });

  it('should offer every playlist for an audio file', () => {
    // A playlist's type is never written, so matching the file's type against it left this
    // menu empty for everything that was not strictly video.
    setUpFileCard({uid: 'f1', title: 'A song', isAudio: true, registered: Date.now(), duration: 5});

    expect(openAddToPlaylistMenu().map(button => button.textContent.trim())).toEqual(['Alpha', 'Beta']);
  });

  it('should offer every playlist for a record that has no isAudio at all', () => {
    setUpFileCard({uid: 'f1', title: 'An older record', registered: Date.now(), duration: 5});

    expect(openAddToPlaylistMenu().map(button => button.textContent.trim())).toEqual(['Alpha', 'Beta']);
  });

  it('should disable a playlist that already holds the file', () => {
    setUpFileCard(
      {uid: 'f1', title: 'A video', isAudio: false, registered: Date.now(), duration: 5},
      [{id: 'p1', name: 'Holds it', uids: ['f1']}, {id: 'p2', name: 'Does not', uids: ['other']}]
    );

    const buttons = openAddToPlaylistMenu();
    expect(buttons.map(button => button.textContent.trim())).toEqual(['Holds it', 'Does not']);
    expect(buttons[0].disabled).toBe(true);
    expect(buttons[1].disabled).toBe(false);
  });

  it('should leave a playlist enabled when it carries no uids array', () => {
    component.file_obj = {uid: 'f1'} as any;

    expect(component.playlistContainsFile({name: 'No uids'} as any)).toBe(false);
  });

  it('should treat a missing playlist list as nothing to add to', () => {
    component.availablePlaylists = null;

    expect(component.playlistsToAddTo).toEqual([]);
  });

  it('should create', () => {
    fixture.detectChanges();
    expect(component).toBeTruthy();
  });

  it('should build preview stream URLs without a trailing slash before the query string', () => {
    component.baseStreamPath = '/api/';
    component.file_obj = {
      uid: 'uid with spaces',
      isAudio: false
    } as any;

    expect(component.generateStreamURL()).toBe('/api/stream?uid=uid%20with%20spaces&type=video&t=,10');
  });

  it('should use the upload date as the displayed date when requested', () => {
    component.displayDateProperty = 'upload_date';
    component.locale = { ngID: 'en-US' } as any;
    component.file_obj = {
      upload_date: '2020-01-02',
      registered: 1713715200000
    } as any;

    expect(component.displayedDateValue).toBe('2020-01-02');
    expect(component.displayedDateTimezone).toBe('UTC');
    expect(component.displayedDateLocale).toBe('en-US');
  });

  it('should fall back to the registered date when the upload date is unavailable', () => {
    component.displayDateProperty = 'upload_date';
    component.file_obj = {
      upload_date: 'N/A',
      registered: 1713715200000
    } as any;

    expect(component.displayedDateValue).toBe(1713715200000);
    expect(component.displayedDateTimezone).toBeUndefined();
  });

  it('should count a playlist by the uids it holds', () => {
    component.is_playlist = true;
    component.file_obj = {
      name: 'Example playlist',
      uids: ['one', 'two', 'three']
    } as any;

    expect(component.playlistItemCount).toBe(3);
    expect(component.playlistItemCountLabel).toBe('3 items');
  });

  it('should count an automatic playlist by the file count the server sent', () => {
    component.is_playlist = true;
    component.file_obj = {
      name: 'Music',
      auto: true,
      file_count: 157
    } as any;

    expect(component.playlistItemCount).toBe(157);
    expect(component.playlistItemCountLabel).toBe('157 items');
  });

  it('should count an empty playlist rather than treating it as unknown', () => {
    component.is_playlist = true;
    component.file_obj = {
      name: 'Empty playlist',
      uids: []
    } as any;

    expect(component.playlistItemCount).toBe(0);
    expect(component.playlistItemCountLabel).toBe('0 items');
  });

  it('should say item rather than items for a playlist holding one file', () => {
    component.is_playlist = true;
    component.file_obj = {
      name: 'Single',
      uids: ['only']
    } as any;

    expect(component.playlistItemCountLabel).toBe('1 item');
  });

  it('should not count a playlist whose size is unknown', () => {
    component.is_playlist = true;
    component.file_obj = {
      name: 'Unknown size'
    } as any;

    expect(component.playlistItemCount).toBeNull();
    expect(component.playlistItemCountLabel).toBeNull();
    expect(component.showPlaylistItemCount).toBe(false);
  });

  it('should not count a card that is not a playlist', () => {
    component.is_playlist = false;
    component.file_obj = {
      title: 'Example video',
      uids: ['one', 'two']
    } as any;

    expect(component.playlistItemCount).toBeNull();
    expect(component.showPlaylistItemCount).toBe(false);
  });

  it('should leave the count off a small card, which has no room for it', () => {
    component.is_playlist = true;
    component.card_size = 'small';
    component.file_obj = {
      name: 'Example playlist',
      uids: ['one', 'two']
    } as any;

    expect(component.playlistItemCountLabel).toBe('2 items');
    expect(component.showPlaylistItemCount).toBe(false);
  });

  it('should render the count under the playlist title', () => {
    component.loading = false;
    component.is_playlist = true;
    component.file_obj = {
      name: 'Example playlist',
      duration: 0,
      registered: Date.now(),
      uids: ['one', 'two', 'three']
    } as any;
    fixture.detectChanges();

    const count_element = fixture.debugElement.query(By.css('.playlist-item-count'));
    expect(count_element).not.toBeNull();
    expect(count_element.nativeElement.textContent.trim()).toBe('3 items');

    // The title gives up its second line to the count, so the block stays the same height.
    expect(fixture.debugElement.query(By.css('.playlist-text .max-one-line'))).not.toBeNull();
    expect(fixture.debugElement.query(By.css('.playlist-text .max-two-lines'))).toBeNull();
  });

  it('should render a file card title without a count', () => {
    component.loading = false;
    component.is_playlist = false;
    component.file_obj = {
      uid: 'example-uid',
      title: 'Example title',
      duration: 90,
      registered: Date.now()
    } as any;
    fixture.detectChanges();

    expect(fixture.debugElement.query(By.css('.playlist-item-count'))).toBeNull();
    expect(fixture.debugElement.query(By.css('.max-two-lines'))).not.toBeNull();
  });

  it('should keep the thumbnail rendered while the hover preview is active', () => {
    component.loading = false;
    component.locale = { ngID: 'en-GB' } as any;
    component.file_obj = {
      uid: 'example-uid',
      duration: 90,
      type: 'video',
      isAudio: false,
      title: 'Example title',
      registered: Date.now(),
      thumbnailURL: 'https://example.com/thumb.jpg'
    } as any;
    component.elevated = true;
    component.showPreview = true;
    component.streamURL = 'https://example.com/preview.mp4';
    fixture.detectChanges();

    const thumbnail = fixture.debugElement.query(By.css('img'));
    const preview = fixture.debugElement.query(By.css('video.preview-video'));
    expect(thumbnail).not.toBeNull();
    expect(preview).not.toBeNull();
    expect(thumbnail.nativeElement.compareDocumentPosition(preview.nativeElement) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  describe('list layout', () => {
    beforeEach(() => {
      component.layout = 'list';
      component.loading = false;
      component.locale = { ngID: 'en-US' } as any;
    });

    it('should lay a file out as a thumbnail with its details beside it', () => {
      setUpFileCard({
        uid: 'f1',
        title: 'A video',
        uploader: 'An uploader',
        isAudio: false,
        duration: 90,
        registered: Date.UTC(2026, 2, 25, 12),
        thumbnailURL: 'https://example.com/thumb.jpg'
      });

      expect(fixture.nativeElement.classList).toContain('list-layout');
      expect(fixture.debugElement.query(By.css('mat-card'))).toBeNull();
      expect(fixture.debugElement.query(By.css('.download-time'))).toBeNull();
      expect(fixture.debugElement.query(By.css('.list-thumbnail img'))).not.toBeNull();
      expect(fixture.debugElement.query(By.css('.list-duration')).nativeElement.textContent.trim()).toBe('1:30');
      expect(fixture.debugElement.query(By.css('.list-title')).nativeElement.textContent.trim()).toBe('A video');
      const details = fixture.debugElement.queryAll(By.css('.list-detail')).map(detail => detail.nativeElement.textContent.trim());
      expect(details).toEqual(['An uploader', '3/25/26']);
    });

    it('should size the thumbnail from the shared share and aspect ratio', () => {
      setUpFileCard({uid: 'f1', title: 'A video', duration: 5, registered: Date.now()});

      const thumbnail: HTMLElement = fixture.debugElement.query(By.css('.list-thumbnail')).nativeElement;
      // jsdom drops aspect-ratio as an unknown property, so only the share can be read back here.
      expect(thumbnail.style.flexBasis).toBe('60%');
      // 388px of row: a 232.8px wide thumbnail, 130.95px tall, rounded up so a row is never short.
      expect(getListCardHeight(388)).toBe(131);
    });

    it('should mark an audio file in its duration badge', () => {
      setUpFileCard({uid: 'f1', title: 'A song', isAudio: true, duration: 5, registered: Date.now(), thumbnailURL: 'https://example.com/thumb.jpg'});

      expect(fixture.debugElement.query(By.css('.list-duration mat-icon')).nativeElement.textContent.trim()).toBe('audiotrack');
    });

    it('should keep the thumbnail rendered under the hover preview', () => {
      component.elevated = true;
      component.showPreview = true;
      component.streamURL = 'https://example.com/preview.mp4';
      setUpFileCard({uid: 'f1', title: 'A video', isAudio: false, duration: 5, registered: Date.now(), thumbnailURL: 'https://example.com/thumb.jpg'});

      const thumbnail = fixture.debugElement.query(By.css('.list-thumbnail img'));
      const preview = fixture.debugElement.query(By.css('.list-thumbnail video.preview-video'));
      expect(thumbnail).not.toBeNull();
      expect(preview).not.toBeNull();
      expect(thumbnail.nativeElement.compareDocumentPosition(preview.nativeElement) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('should stand an icon in for a file with no thumbnail, so the row keeps its height', () => {
      setUpFileCard({uid: 'f1', title: 'A video', isAudio: false, duration: 5, registered: Date.now()});

      expect(fixture.debugElement.query(By.css('.list-thumbnail img'))).toBeNull();
      expect(fixture.debugElement.query(By.css('.list-thumbnail-fallback')).nativeElement.textContent.trim()).toBe('movie');
    });

    it('should show a playlist with its item count', () => {
      component.is_playlist = true;
      component.file_obj = {name: 'A playlist', duration: 0, registered: Date.now(), uids: ['one', 'two']} as any;
      fixture.detectChanges();

      expect(fixture.debugElement.query(By.css('.list-title')).nativeElement.textContent.trim()).toBe('A playlist');
      expect(fixture.debugElement.query(By.css('.list-detail')).nativeElement.textContent.trim()).toBe('2 items');
      expect(fixture.debugElement.query(By.css('.list-thumbnail-fallback')).nativeElement.textContent.trim()).toBe('playlist_play');
    });

    it('should open the file from the row but not from its menu button', () => {
      setUpFileCard({uid: 'f1', title: 'A video', duration: 5, registered: Date.now()});
      const go_to_file = vi.fn();
      component.goToFile.subscribe(go_to_file);

      // The button is a sibling of the row rather than inside it, so its click never reaches
      // the row's handler.
      fixture.debugElement.query(By.css('button.menuButton')).nativeElement.click();
      expect(go_to_file).not.toHaveBeenCalled();

      fixture.debugElement.query(By.css('.list-card')).nativeElement.click();
      expect(go_to_file).toHaveBeenCalledTimes(1);
    });

    it('should keep every action in the menu', () => {
      setUpFileCard({uid: 'f1', title: 'A video', isAudio: false, registered: Date.now(), duration: 5});

      expect(openAddToPlaylistMenu().map(button => button.textContent.trim())).toEqual(['Alpha', 'Beta']);
    });

    it('should render a loading placeholder in the same shape', () => {
      component.loading = true;
      fixture.detectChanges();

      expect(fixture.debugElement.query(By.css('.list-thumbnail content-loader'))).not.toBeNull();
      expect(fixture.debugElement.query(By.css('.list-details content-loader'))).not.toBeNull();
      expect(fixture.debugElement.query(By.css('mat-card'))).toBeNull();
    });
  });
});
