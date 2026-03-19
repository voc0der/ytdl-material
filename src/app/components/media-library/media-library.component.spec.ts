import { NO_ERRORS_SCHEMA, NgZone } from '@angular/core';
import { ComponentFixture, TestBed, fakeAsync, flushMicrotasks, waitForAsync } from '@angular/core/testing';
import { Router } from '@angular/router';
import { BehaviorSubject, of } from 'rxjs';
import { MatDialog } from '@angular/material/dialog';
import { PostsService } from 'app/posts.services';
import {
  MediaLibraryNavigationStateService,
  PLAYER_NAVIGATOR_STORAGE_KEY
} from 'app/media-library-navigation-state.service';

import { MediaLibraryComponent } from './media-library.component';

describe('MediaLibraryComponent', () => {
  let component: MediaLibraryComponent;
  let fixture: ComponentFixture<MediaLibraryComponent>;
  let dialogStub: any;
  let postsServiceStub: any;
  let routerStub: any;
  let navigationStateService: MediaLibraryNavigationStateService;

  beforeEach(waitForAsync(() => {
    localStorage.clear();
    sessionStorage.clear();

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
      removePlaylist: jasmine.createSpy('removePlaylist').and.returnValue(of({
        success: true,
        playlist_removed: true,
        failed_file_count: 0
      })),
      openSnackBar: jasmine.createSpy('openSnackBar'),
      getAllFiles: jasmine.createSpy('getAllFiles').and.returnValue(of({files: [], file_count: 0})),
      getPlaylists: jasmine.createSpy('getPlaylists').and.returnValue(of({playlists: []})),
      files_changed: new BehaviorSubject(false),
      playlists_changed: new BehaviorSubject(false)
    };
    routerStub = {
      url: '/home',
      navigate: jasmine.createSpy('navigate'),
      createUrlTree: jasmine.createSpy('createUrlTree').and.returnValue('/player'),
      serializeUrl: jasmine.createSpy('serializeUrl').and.returnValue('/player')
    };
    dialogStub = {
      open: jasmine.createSpy('open')
    };

    TestBed.configureTestingModule({
      declarations: [ MediaLibraryComponent ],
      providers: [
        { provide: PostsService, useValue: postsServiceStub },
        { provide: Router, useValue: routerStub },
        { provide: MatDialog, useValue: dialogStub }
      ],
      schemas: [NO_ERRORS_SCHEMA]
    })
    .compileComponents();
  }));

  beforeEach(() => {
    fixture = TestBed.createComponent(MediaLibraryComponent);
    component = fixture.componentInstance;
    navigationStateService = TestBed.inject(MediaLibraryNavigationStateService);
    navigationStateService.clearPendingRestoreState();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('should migrate legacy stored page size preferences', () => {
    localStorage.setItem(component.legacyPageSizeStorageKey, `${component.autoPageSizeOption}`);

    fixture = TestBed.createComponent(MediaLibraryComponent);
    component = fixture.componentInstance;

    expect(component.autoPaginationEnabled).toBeTrue();
    expect(localStorage.getItem(component.pageSizeStorageKey)).toBe(`${component.autoPageSizeOption}`);
  });

  it('should request the first auto-pagination batch from the server', () => {
    spyOn(component, 'getAutoPageBatchSize').and.returnValue(12);
    spyOn(component, 'getAutoPageColumns').and.returnValue(3);
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
      [0, 12],
      null,
      'both',
      false,
      null
    );
    expect(component.paged_data.length).toBe(2);
    expect(component.file_count).toBe(40);
  });

  it('should append the next auto-pagination batch without duplicating files', () => {
    spyOn(component, 'getAutoPageBatchSize').and.returnValue(12);
    spyOn(component, 'getAutoPageColumns').and.returnValue(2);
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
      [2, 14],
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
    spyOn(component, 'getAutoPageBatchSize').and.returnValue(12);

    component.pageSizeOptionChanged(component.autoPageSizeOption);

    expect(component.autoPaginationEnabled).toBeTrue();
    expect(component.manualPageIndex).toBe(0);
    expect(localStorage.setItem).toHaveBeenCalledWith(component.pageSizeStorageKey, 'auto');
    expect(component.getAllFiles).toHaveBeenCalled();
  });

  it('should calculate an auto batch size that fills full rows', () => {
    postsServiceStub.card_size = 'medium';
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 });
    (component as any).videoGridContainerElement = {
      getBoundingClientRect: () => ({ top: 240, width: 941 })
    };

    expect(component.getAutoPageColumns()).toBe(4);
    expect(component.getAutoPageBatchSize()).toBe(20);
  });

  it('should window auto-loaded video rows instead of rendering every loaded row', () => {
    component.autoPaginationEnabled = true;
    component.normal_files_received = true;
    component.paged_data = Array.from({length: 12}, (_, index) => ({
      uid: `file-${index + 1}`,
      duration: 12
    })) as any;
    spyOn(component, 'getAutoPageColumns').and.returnValue(2);
    spyOn(component, 'getAutoCardRowHeight').and.returnValue(200);
    spyOn(component, 'getViewportHeight').and.returnValue(400);
    spyOn(component, 'getViewportScrollTop').and.returnValue(0);
    spyOn(component, 'getVideoGridDocumentTop').and.returnValue(0);

    component.rebuildVideoRows();

    expect(component.videoRows.length).toBe(6);
    expect(component.renderedVideoRows.length).toBe(4);
    expect(component.virtualizedTopSpacerHeight).toBe(0);
    expect(component.virtualizedBottomSpacerHeight).toBe(400);
  });

  it('should prefetch another auto batch when the visible window reaches the loaded tail', fakeAsync(() => {
    component.autoPaginationEnabled = true;
    component.normal_files_received = true;
    component.file_count = 20;
    component.paged_data = Array.from({length: 6}, (_, index) => ({
      uid: `file-${index + 1}`,
      duration: 12
    })) as any;
    spyOn(component, 'getAutoPageColumns').and.returnValue(2);
    spyOn(component, 'getAutoCardRowHeight').and.returnValue(200);
    spyOn(component, 'getViewportHeight').and.returnValue(800);
    spyOn(component, 'getViewportScrollTop').and.returnValue(0);
    spyOn(component, 'getVideoGridDocumentTop').and.returnValue(0);
    const load_more_spy = spyOn(component, 'loadMoreAutoFiles');

    component.rebuildVideoRows();
    flushMicrotasks();

    expect(load_more_spy).toHaveBeenCalled();
  }));

  it('should restore cached library state without refetching files', () => {
    navigationStateService.savePendingRestoreState({
      snapshot: {
        routeKey: '/home',
        activeLibraryTab: 0,
        sortProperty: 'registered',
        descendingMode: true,
        selectedFilters: ['favorited'],
        searchText: 'cats',
        playlistSearchText: '',
        autoPaginationEnabled: true,
        pageSize: 10,
        manualPageIndex: 0,
        subId: null,
        fileCount: 2,
        loadedCount: 2,
        anchorUid: 'file-2',
        anchorOffset: 24,
        scrollTop: 320
      },
      files: [
        { uid: 'file-1', duration: 12 } as any,
        { uid: 'file-2', duration: 18 } as any
      ],
      playlistLibraryItems: [],
      playlistLibraryReceived: false
    });
    postsServiceStub.getAllFiles.calls.reset();

    fixture.detectChanges();

    expect(postsServiceStub.getAllFiles).not.toHaveBeenCalled();
    expect(component.autoPaginationEnabled).toBeTrue();
    expect(component.search_text).toBe('cats');
    expect(component.selectedFilters).toEqual(['favorited']);
    expect(component.paged_data.map(file => file.uid)).toEqual(['file-1', 'file-2']);
    expect(component.normal_files_received).toBeTrue();
  });

  it('should capture the visible anchor from rendered card positions', () => {
    const manualComponent = new MediaLibraryComponent(
      postsServiceStub,
      routerStub,
      dialogStub,
      TestBed.inject(NgZone),
      navigationStateService
    );
    manualComponent.autoPaginationEnabled = true;
    manualComponent.normal_files_received = true;
    manualComponent.paged_data = Array.from({length: 4}, (_, index) => ({
      uid: `file-${index + 1}`,
      duration: 12
    })) as any;
    spyOn(manualComponent, 'getAutoPageColumns').and.returnValue(2);
    spyOn(manualComponent, 'getViewportScrollTop').and.returnValue(500);

    const anchor_slots = [
      {
        getAttribute: () => 'file-1',
        getBoundingClientRect: () => ({ top: -220, bottom: -20 })
      },
      {
        getAttribute: () => 'file-2',
        getBoundingClientRect: () => ({ top: -220, bottom: -20 })
      },
      {
        getAttribute: () => 'file-3',
        getBoundingClientRect: () => ({ top: 60, bottom: 260 })
      },
      {
        getAttribute: () => 'file-4',
        getBoundingClientRect: () => ({ top: 60, bottom: 260 })
      }
    ] as any;

    (manualComponent as any).scrollListenerTarget = window;
    (manualComponent as any).videoGridContainerElement = {
      querySelectorAll: () => anchor_slots
    };

    const anchor = (manualComponent as any).getVisibleVideoAnchor();

    expect(anchor.anchorUid).toBe('file-3');
    expect(anchor.anchorOffset).toBe(-60);
  });

  it('should correct restored scroll using the rendered anchor element position', () => {
    const manualComponent = new MediaLibraryComponent(
      postsServiceStub,
      routerStub,
      dialogStub,
      TestBed.inject(NgZone),
      navigationStateService
    );
    manualComponent.autoPaginationEnabled = true;
    manualComponent.normal_files_received = true;
    manualComponent.file_count = 4;
    manualComponent.paged_data = Array.from({length: 4}, (_, index) => ({
      uid: `file-${index + 1}`,
      duration: 12
    })) as any;
    spyOn(manualComponent, 'getAutoPageColumns').and.returnValue(2);
    spyOn(manualComponent, 'getViewportScrollTop').and.returnValue(500);
    spyOn(manualComponent, 'scheduleVirtualVideoWindowUpdate');
    const set_scroll_spy = spyOn<any>(manualComponent, 'setViewportScrollTop');

    const anchor_element = {
      getAttribute: () => 'file-3',
      getBoundingClientRect: () => ({ top: 140, bottom: 340 })
    } as any;

    (manualComponent as any).scrollListenerTarget = window;
    (manualComponent as any).videoGridContainerElement = {
      querySelectorAll: () => [anchor_element]
    };
    (manualComponent as any).pendingScrollRestoreSnapshot = {
      routeKey: '/home',
      activeLibraryTab: 0,
      sortProperty: 'registered',
      descendingMode: true,
      selectedFilters: [],
      searchText: '',
      playlistSearchText: '',
      autoPaginationEnabled: true,
      pageSize: 10,
      manualPageIndex: 0,
      subId: null,
      fileCount: 4,
      loadedCount: 4,
      anchorUid: 'file-3',
      anchorOffset: 24,
      scrollTop: 320
    };

    (manualComponent as any).restorePendingScrollPosition();

    expect(set_scroll_spy).toHaveBeenCalledWith(664);
    expect((manualComponent as any).pendingScrollRestoreSnapshot).toBeNull();
  });

  it('should keep the clicked file uid as the anchor when the rendered lookup misses', () => {
    const manualComponent = new MediaLibraryComponent(
      postsServiceStub,
      routerStub,
      dialogStub,
      TestBed.inject(NgZone),
      navigationStateService
    );
    manualComponent.autoPaginationEnabled = true;
    manualComponent.normal_files_received = true;
    manualComponent.paged_data = Array.from({length: 4}, (_, index) => ({
      uid: `file-${index + 1}`,
      duration: 12
    })) as any;
    spyOn(manualComponent, 'getAutoPageColumns').and.returnValue(2);
    spyOn(manualComponent, 'getViewportScrollTop').and.returnValue(500);
    spyOn(manualComponent, 'getVideoGridDocumentTop').and.returnValue(100);

    (manualComponent as any).scrollListenerTarget = window;
    (manualComponent as any).videoGridContainerElement = {
      querySelectorAll: () => [{
        getAttribute: () => 'file-1',
        getBoundingClientRect: () => ({ top: 0, bottom: 200 })
      }]
    };

    const anchor = (manualComponent as any).getNavigationRestoreAnchor('file-3', null);

    expect(anchor.anchorUid).toBe('file-3');
  });

  it('should rebuild cached auto rows when the grid container becomes available', () => {
    component.autoPaginationEnabled = true;
    component.normal_files_received = true;
    component.paged_data = Array.from({length: 8}, (_, index) => ({
      uid: `file-${index + 1}`,
      duration: 12
    })) as any;
    const column_spy = spyOn(component, 'getAutoPageColumns').and.returnValues(4, 2);

    component.rebuildVideoRows();
    expect(component.videoRows[0].items.length).toBe(4);

    component.videoGridContainer = {
      nativeElement: document.createElement('div')
    } as any;

    expect(column_spy).toHaveBeenCalledTimes(2);
    expect(component.videoRows[0].items.length).toBe(2);
  });

  it('should cache the current library view before navigating to the player', () => {
    component.normal_files_received = true;
    component.file_count = 2;
    component.search_text = 'cats';
    component.search_mode = true;
    component.autoPaginationEnabled = true;
    component.selectedFilters = ['favorited'];
    component.paged_data = [
      { uid: 'file-1', duration: 12, isAudio: false } as any,
      { uid: 'file-2', duration: 18, isAudio: false } as any
    ];
    spyOn(component, 'getViewportScrollTop').and.returnValue(500);
    (component as any).scrollListenerTarget = window;
    (component as any).videoGridContainerElement = {
      querySelectorAll: () => [{
        getAttribute: () => 'file-1',
        getBoundingClientRect: () => ({ top: 140, bottom: 340 })
      }]
    };

    component.navigateToFile(component.paged_data[0], false);

    expect(sessionStorage.getItem(PLAYER_NAVIGATOR_STORAGE_KEY)).toBe('/home');
    expect(routerStub.navigate).toHaveBeenCalled();
    const restored = navigationStateService.consumePendingRestoreState('/home', null);
    expect(restored.snapshot.searchText).toBe('cats');
    expect(restored.snapshot.selectedFilters).toEqual(['favorited']);
    expect(restored.snapshot.anchorUid).toBe('file-1');
    expect(restored.files.map(file => file.uid)).toEqual(['file-1', 'file-2']);
  });

  it('should not save restore state when opening the player in a new tab', () => {
    component.normal_files_received = true;
    component.paged_data = [
      { uid: 'file-1', duration: 12, isAudio: false } as any
    ];
    const window_open_spy = spyOn(window, 'open');

    component.navigateToFile(component.paged_data[0], true);

    expect(window_open_spy).toHaveBeenCalled();
    expect(sessionStorage.getItem(PLAYER_NAVIGATOR_STORAGE_KEY)).toBeNull();
    expect(navigationStateService.consumePendingRestoreState('/home', null)).toBeNull();
    expect(routerStub.navigate).not.toHaveBeenCalled();
  });

  it('removes only the playlist when the default delete action is chosen', () => {
    const playlist = {
      id: 'playlist-1',
      name: 'Playlist 1',
      uids: ['file-1', 'file-2']
    } as any;
    component.playlists = [playlist];
    component.playlistLibraryItems = [playlist];
    dialogStub.open.and.returnValue({ afterClosed: () => of('playlist_only') });
    const get_all_files_spy = spyOn(component, 'getAllFiles');
    const get_all_playlists_spy = spyOn(component, 'getAllPlaylists');

    component.deletePlaylist({ file: playlist, index: 0 });

    expect(postsServiceStub.removePlaylist).toHaveBeenCalledWith('playlist-1', false);
    expect(get_all_files_spy).not.toHaveBeenCalled();
    expect(component.playlists).toEqual([]);
    expect(component.playlistLibraryItems).toEqual([]);
    expect(postsServiceStub.openSnackBar).toHaveBeenCalledWith('Playlist successfully removed.');
    expect(get_all_playlists_spy).toHaveBeenCalled();
  });

  it('refreshes files and reports partial failures when deleting playlist files too', () => {
    const playlist = {
      id: 'playlist-1',
      name: 'Playlist 1',
      uids: ['file-1', 'file-2']
    } as any;
    component.playlists = [playlist];
    component.playlistLibraryItems = [playlist];
    postsServiceStub.removePlaylist.and.returnValue(of({
      success: false,
      playlist_removed: true,
      failed_file_count: 2
    }));
    dialogStub.open.and.returnValue({ afterClosed: () => of('playlist_and_files') });
    const get_all_files_spy = spyOn(component, 'getAllFiles');
    spyOn(component, 'getAllPlaylists');

    component.deletePlaylist({ file: playlist, index: 0 });

    expect(postsServiceStub.removePlaylist).toHaveBeenCalledWith('playlist-1', true);
    expect(get_all_files_spy).toHaveBeenCalled();
    expect(postsServiceStub.openSnackBar).toHaveBeenCalledWith('Playlist removed, but 2 file(s) could not be deleted.');
  });
});
