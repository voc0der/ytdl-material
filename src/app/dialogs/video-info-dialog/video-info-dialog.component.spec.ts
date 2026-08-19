import { NO_ERRORS_SCHEMA } from '@angular/core';
import { ComponentFixture, TestBed, waitForAsync } from '@angular/core/testing';
import { MAT_DIALOG_DATA } from '@angular/material/dialog';
import { of } from 'rxjs';

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
      updateFile: vi.fn().mockName('updateFile').mockReturnValue(of({}))
    };

    configureTestBed({
      declarations: [VideoInfoDialogComponent],
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
});
