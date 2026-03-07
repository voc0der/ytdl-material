import { NO_ERRORS_SCHEMA } from '@angular/core';
import { ComponentFixture, TestBed, waitForAsync } from '@angular/core/testing';
import { MatDialog } from '@angular/material/dialog';
import { ActivatedRoute, Router, convertToParamMap } from '@angular/router';
import { PostsService } from '../posts.services';
import { IMedia, PlayerComponent } from './player.component';

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
});
