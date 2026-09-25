import { NO_ERRORS_SCHEMA } from '@angular/core';
import { ComponentFixture, TestBed, waitForAsync } from '@angular/core/testing';
import { MAT_DIALOG_DATA } from '@angular/material/dialog';
import { of, Subject, throwError } from 'rxjs';

import { VideoInfoDialogComponent } from './video-info-dialog.component';
import { PostsService } from 'app/posts.services';
import { DatePipe } from '@angular/common';
import { configureTestBed } from '../../../testing/test-bed';

describe('VideoInfoDialogComponent', () => {
  let component: VideoInfoDialogComponent;
  let fixture: ComponentFixture<VideoInfoDialogComponent>;
  let postsServiceStub: any;

  beforeEach(waitForAsync(() => {
    postsServiceStub = {
      categories: null,
      user: null,
      reloadCategories: vi.fn().mockName('reloadCategories'),
      getFile: vi.fn().mockName('getFile').mockReturnValue(of({
        file: {
          uid: 'uid-1',
          title: 'Mac Miller - Self Care',
          thumbnailURL: 'https://example.com/thumb.jpg',
          isAudio: false,
          duration: 347,
          url: 'https://www.youtube.com/watch?v=SsKT0s5J8ko',
          uploader: 'Mac Miller',
          size: 116659797,
          path: 'users/vocoder/video/Mac Miller - Self Care.mp4',
          upload_date: '2018-07-13',
          subtitles: [
            {
              label: 'English',
              language: 'en',
              kind: 'subtitles',
              default: true
            }
          ],
          favorite: false
        }
      })),
      updateFile: vi.fn().mockName('updateFile').mockReturnValue(of({})),
      // The dialog's action row asks what the caller may do. canSnip() only got away
      // without this because allow_snip short-circuits ahead of it.
      hasPermission: vi.fn().mockName('hasPermission').mockReturnValue(true),
      generateThumbnail: vi.fn().mockName('generateThumbnail').mockReturnValue(of({success: true, method: 'source'})),
      openSnackBar: vi.fn()
    };

    configureTestBed({
      imports: [VideoInfoDialogComponent],
      providers: [
        DatePipe,
        { provide: PostsService, useValue: postsServiceStub },
        {
          provide: MAT_DIALOG_DATA,
          useValue: {
            file: {
              uid: 'uid-1',
              title: 'Mac Miller - Self Care',
              thumbnailURL: 'https://example.com/thumb.jpg',
              isAudio: false,
              duration: 347,
              url: 'https://www.youtube.com/watch?v=SsKT0s5J8ko',
              uploader: 'Mac Miller',
              size: 116659797,
              path: 'users/vocoder/video/Mac Miller - Self Care.mp4',
              upload_date: '2018-07-13',
              favorite: false
            }
          }
        }
      ],
      schemas: [NO_ERRORS_SCHEMA]
    })
      .compileComponents();
  }));

  beforeEach(() => {
    fixture = TestBed.createComponent(VideoInfoDialogComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('should fetch the full file payload on init', () => {
    expect(postsServiceStub.getFile).toHaveBeenCalledWith('uid-1', null, null);
    expect(component.new_file.subtitles?.length).toBe(1);
  });

  it('badges a video with its video codec and an audio file with its audio codec', () => {
    component.file = {...component.file, isAudio: false, vcodec: 'hevc', acodec: 'opus'};
    expect(component.codecBadge).toBe('HEVC');

    component.file = {...component.file, isAudio: true, vcodec: null, acodec: 'mp3'};
    expect(component.codecBadge).toBe('MP3');

    component.file = {...component.file, isAudio: false, vcodec: undefined};
    expect(component.codecBadge).toBeNull();
  });

  it('tells a file with no audio apart from one nobody has checked', () => {
    expect(component.describeCodec('av1')).toBe('AV1');
    expect(component.describeCodec(null)).toBe('None');
    expect(component.describeCodec(undefined)).toBe('Not checked yet');
  });

  it('should summarize detected subtitles', () => {
    expect(component.getSubtitleSummary()).toBe('English (default)');
  });

  it('should report when no subtitles are detected', () => {
    component.new_file.subtitles = [];

    expect(component.getSubtitleSummary()).toBe('None detected');
  });

  it('discards unsaved metadata when editing is canceled', () => {
    component.editing = true;
    component.new_file.title = 'Unsaved title';
    component.new_file.upload_date = '2026-01-01';

    component.cancelEditing();

    expect(component.editing).toBe(false);
    expect(component.new_file).toEqual(component.file);
    expect(component.upload_date.getFullYear()).toBe(2018);
    expect(postsServiceStub.updateFile).not.toHaveBeenCalled();
  });

  it('keeps unsaved metadata when favoriting a file during editing', () => {
    component.editing = true;
    component.new_file.title = 'Unsaved title';

    component.toggleFavorite();

    expect(postsServiceStub.updateFile).toHaveBeenCalledWith('uid-1', { favorite: true });
    expect(component.file.favorite).toBe(true);
    expect(component.new_file.favorite).toBe(true);
    expect(component.new_file.title).toBe('Unsaved title');
    expect(component.file.title).toBe('Mac Miller - Self Care');
  });

  it('prevents duplicate saves while a request is pending', () => {
    const response = new Subject();
    postsServiceStub.updateFile.mockReturnValue(response);
    component.editing = true;
    component.new_file.title = 'Updated title';

    component.saveChanges();
    component.saveChanges();
    expect(postsServiceStub.updateFile).toHaveBeenCalledTimes(1);
    expect(component.retrieving_file).toBe(true);
    expect(component.editing).toBe(true);

    response.next({});
    response.complete();
    expect(component.retrieving_file).toBe(false);
    expect(component.editing).toBe(false);
  });

  it('keeps failed edits available to retry', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    postsServiceStub.updateFile.mockReturnValue(throwError(() => new Error('offline')));
    component.editing = true;
    component.new_file.title = 'Updated title';

    component.saveChanges();

    expect(component.retrieving_file).toBe(false);
    expect(component.editing).toBe(true);
    expect(component.new_file.title).toBe('Updated title');
    expect(postsServiceStub.openSnackBar).toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('sends no timestamp when the box is left blank, so the backend picks its own', () => {
    // Number(null) is 0, and seeking to the first frame usually yields a black image.
    component.thumbnail_timestamp = null;

    component.generateThumbnail();

    expect(postsServiceStub.generateThumbnail).toHaveBeenCalledWith('uid-1', null);
    expect(component.generating_thumbnail).toBe(false);
  });

  it('sends the timestamp when one was typed', () => {
    component.thumbnail_timestamp = 12;

    component.generateThumbnail();

    expect(postsServiceStub.generateThumbnail).toHaveBeenCalledWith('uid-1', 12);
  });

  it('rejects a negative timestamp rather than passing it through', () => {
    component.thumbnail_timestamp = -4;

    component.generateThumbnail();

    expect(postsServiceStub.generateThumbnail).toHaveBeenCalledWith('uid-1', null);
  });

  it('reports a backend refusal instead of claiming success', () => {
    postsServiceStub.generateThumbnail.mockReturnValue(of({success: false}));

    component.generateThumbnail();

    expect(component.generating_thumbnail).toBe(false);
    expect(postsServiceStub.openSnackBar).toHaveBeenCalled();
  });

  it('clears the pending flag when the request fails outright', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    postsServiceStub.generateThumbnail.mockReturnValue(throwError(() => new Error('offline')));

    component.generateThumbnail();

    expect(component.generating_thumbnail).toBe(false);
    expect(postsServiceStub.openSnackBar).toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('hides the frame control when the original cover art was fetched', () => {
    // The timestamp has no say in that result, so offering it would be offering a control
    // that does nothing.
    postsServiceStub.generateThumbnail.mockReturnValue(of({success: true, method: 'source'}));

    component.generateThumbnail();

    expect(component.used_frame).toBe(false);
    expect(component.frame_seconds_used).toBeNull();
  });

  it('reveals the frame control, seeded with what was used, after falling back to a frame', () => {
    postsServiceStub.generateThumbnail.mockReturnValue(of({success: true, method: 'frame', seek_seconds: 12}));

    component.generateThumbnail();

    expect(component.used_frame).toBe(true);
    expect(component.frame_seconds_used).toBe(12);
    // Seeded so changing it is an adjustment rather than a guess from nothing.
    expect(component.thumbnail_timestamp).toBe(12);
  });

  it('keeps a timestamp the user already typed rather than overwriting it', () => {
    component.thumbnail_timestamp = 45;
    postsServiceStub.generateThumbnail.mockReturnValue(of({success: true, method: 'frame', seek_seconds: 45}));

    component.generateThumbnail();

    expect(component.thumbnail_timestamp).toBe(45);
  });

  it('offers to replace art only when the file already has some', () => {
    component.file.thumbnailPath = null;
    expect(component.hasThumbnail()).toBe(false);

    component.file.thumbnailPath = 'users/vocoder/video/Mac Miller - Self Care.webp';
    expect(component.hasThumbnail()).toBe(true);
  });

  it('only shows a file from someone else\'s library, reading it from there', () => {
    postsServiceStub.getFile.mockClear();
    component.data.library = 'bob';
    component.data.allow_snip = true;

    component.ngOnInit();
    fixture.detectChanges();
    const element: HTMLElement = fixture.nativeElement;

    expect(postsServiceStub.getFile).toHaveBeenCalledWith('uid-1', null, 'bob');
    expect(component.write_access).toBe(false);
    expect(component.canSnip()).toBe(false);
    expect(component.canGenerateThumbnail()).toBe(false);
    expect(element.querySelector('.favorite-button')).toBeNull();
    expect(element.querySelector('.dialog-actions').textContent).not.toContain('Edit details');
    expect(element.querySelector('.dialog-subtitle').textContent).toContain('shared with you');
  });
});
