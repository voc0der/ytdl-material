import { NO_ERRORS_SCHEMA } from '@angular/core';
import { ComponentFixture, TestBed, waitForAsync } from '@angular/core/testing';
import { Router } from '@angular/router';
import { of } from 'rxjs';
import { MatDialog } from '@angular/material/dialog';
import { PostsService } from 'app/posts.services';

import { RecentVideosComponent } from './recent-videos.component';

describe('RecentVideosComponent', () => {
  let component: RecentVideosComponent;
  let fixture: ComponentFixture<RecentVideosComponent>;
  let postsServiceStub: any;

  beforeEach(waitForAsync(() => {
    localStorage.clear();

    postsServiceStub = {
      initialized: false,
      service_initialized: of(true),
      config: {
        Downloader: {
          use_youtubedl_archive: false
        },
        Extra: {
          download_only_mode: false
        }
      },
      card_size: 'medium',
      locale: 'en',
      theme: {
        ghost_primary: '#000',
        ghost_secondary: '#111'
      },
      path: '/api/',
      isLoggedIn: false,
      token: '',
      auth_token: '',
      getAllFiles: jasmine.createSpy('getAllFiles').and.returnValue(of({files: [], file_count: 0})),
      getPlaylists: jasmine.createSpy('getPlaylists').and.returnValue(of({playlists: []})),
      files_changed: { subscribe: () => ({ unsubscribe() {} }) },
      playlists_changed: { subscribe: () => ({ unsubscribe() {} }) }
    };

    TestBed.configureTestingModule({
      declarations: [ RecentVideosComponent ],
      providers: [
        { provide: PostsService, useValue: postsServiceStub },
        { provide: Router, useValue: {} },
        { provide: MatDialog, useValue: {} }
      ],
      schemas: [NO_ERRORS_SCHEMA]
    })
    .compileComponents();
  }));

  beforeEach(() => {
    fixture = TestBed.createComponent(RecentVideosComponent);
    component = fixture.componentInstance;
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('should request the first auto-pagination batch from the server', () => {
    postsServiceStub.getAllFiles.and.returnValue(of({
      files: [
        { uid: 'file-1', duration: 12 },
        { uid: 'file-2', duration: 18 }
      ],
      file_count: 40
    }));
    component.autoPaginationEnabled = true;

    component.getAllFiles();

    expect(postsServiceStub.getAllFiles).toHaveBeenCalledWith(
      { by: 'registered', order: -1 },
      [0, component.autoPageBatchSize],
      null,
      'both',
      false,
      null
    );
    expect(component.paged_data.length).toBe(2);
    expect(component.file_count).toBe(40);
  });

  it('should append the next auto-pagination batch without duplicating files', () => {
    component.autoPaginationEnabled = true;
    component.normal_files_received = true;
    component.file_count = 50;
    component.paged_data = [
      { uid: 'file-1', duration: 12 } as any,
      { uid: 'file-2', duration: 18 } as any
    ];
    postsServiceStub.getAllFiles.calls.reset();
    postsServiceStub.getAllFiles.and.returnValue(of({
      files: [
        { uid: 'file-2', duration: 18 },
        { uid: 'file-3', duration: 24 }
      ],
      file_count: 50
    }));

    component.loadMoreAutoFiles();

    expect(postsServiceStub.getAllFiles).toHaveBeenCalledWith(
      { by: 'registered', order: -1 },
      [2, 2 + component.autoPageBatchSize],
      null,
      'both',
      false,
      null
    );
    expect(component.paged_data.map(file => file.uid)).toEqual(['file-1', 'file-2', 'file-3']);
  });

  it('should persist auto page size selection and reset paging', () => {
    spyOn(localStorage, 'setItem');
    component.manualPageIndex = 4;
    spyOn(component, 'getAllFiles');

    component.pageSizeOptionChanged(component.autoPageSizeOption);

    expect(component.autoPaginationEnabled).toBeTrue();
    expect(component.manualPageIndex).toBe(0);
    expect(localStorage.setItem).toHaveBeenCalledWith(component.pageSizeStorageKey, 'auto');
    expect(component.getAllFiles).toHaveBeenCalled();
  });
});
