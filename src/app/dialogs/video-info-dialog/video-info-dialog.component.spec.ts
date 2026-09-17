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
    expect(postsServiceStub.getFile).toHaveBeenCalledWith('uid-1');
    expect(component.new_file.subtitles?.length).toBe(1);
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
});
