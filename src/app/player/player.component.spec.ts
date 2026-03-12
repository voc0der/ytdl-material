import { NO_ERRORS_SCHEMA } from '@angular/core';
import { ComponentFixture, TestBed, waitForAsync } from '@angular/core/testing';
import { MatDialog } from '@angular/material/dialog';
import { ActivatedRoute, Router, convertToParamMap } from '@angular/router';
import { VgApiService } from '@videogular/ngx-videogular/core';
import { PostsService } from '../posts.services';
import { IChapter, IMedia, PlayerComponent } from './player.component';

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
});
