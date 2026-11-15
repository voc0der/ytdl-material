import { NgZone } from '@angular/core';
import { MatPaginatorIntl } from '@angular/material/paginator';
import { BehaviorSubject, Subject } from 'rxjs';
import { MediaLibraryNavigationStateService } from 'app/media-library-navigation-state.service';
import { MediaLibraryComponent } from './media-library.component';

// How the library lays out and scrolls its grid: inside a scroll container of its own, with
// cards that are drawn only near the viewport, and back to where it was after the player.
// Built without a template, with the grid's elements made by hand.
describe('Media library layout', () => {
  let posts: any;
  let library: MediaLibraryComponent;
  let frames: FrameRequestCallback[];
  const files = (count: number) => Array.from({ length: count }, (unused, index) => ({ uid: `file-${index + 1}`, duration: 12 })) as any[];
  const element = (rect: Partial<DOMRect>, fields: Record<string, unknown> = {}) => {
    const created = document.createElement('div');
    created.getBoundingClientRect = () => rect as DOMRect;
    for (const [name, value] of Object.entries(fields)) Object.defineProperty(created, name, { value, writable: true, configurable: true });
    return created;
  };

  beforeEach(() => {
    localStorage.clear();
    frames = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { frames.push(callback); return frames.length; });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
    posts = {
      card_size: 'medium', categories: [], config: { Extra: {} },
      files_changed: new BehaviorSubject(false), playlists_changed: new BehaviorSubject(false), library_changed: new Subject()
    };
    const zone = { run: fn => fn(), runOutsideAngular: fn => fn() } as unknown as NgZone;
    library = new MediaLibraryComponent(posts, {} as any, {} as any, zone, new MediaLibraryNavigationStateService(posts),
      {} as any, new MatPaginatorIntl());
  });

  afterEach(() => vi.restoreAllMocks());

  it('measures against a scroll container of its own rather than the window', () => {
    const container = element({ top: 100 }, { clientHeight: 600, scrollTop: 300 });
    const grid = element({ top: 150, width: 900 });
    (library as any).scrollListenerTarget = container;
    (library as any).videoGridContainerElement = grid;

    expect(library.getViewportHeight()).toBe(600);
    expect(library.getViewportScrollTop()).toBe(300);
    expect(library.getVideoGridDocumentTop()).toBe(350);
    expect(library.getVisibleGridTopOffset()).toBe(50);
    expect((library as any).getVisibleViewportTopBoundary()).toBe(100);
    expect((library as any).getElementDocumentTop(element({ top: 400 }))).toBe(600);
    expect((library as any).getElementDocumentTop({})).toBe(300);

    (library as any).setViewportScrollTop(-20);
    expect(container.scrollTop).toBe(0);
    Object.defineProperty(container, 'clientHeight', { value: 0 });
    expect(library.getViewportHeight()).toBe(library.getAutoCardRowHeight() * 4);
  });

  it('finds the card under a pointer, and only on its own grid', () => {
    const grid = document.createElement('div');
    const card = document.createElement('div');
    card.setAttribute('data-file-uid', 'file-1');
    const title = document.createElement('span');
    card.appendChild(title);
    grid.appendChild(card);
    const elsewhere = document.createElement('div');
    elsewhere.setAttribute('data-file-uid', 'file-9');
    (library as any).videoGridContainerElement = grid;

    const anchor = (target: EventTarget) => (library as any).getAnchorElementFromEventTarget(target);
    expect(anchor(title)).toBe(card);
    expect(anchor(elsewhere)).toBeNull();
    expect(anchor(document.createElement('p'))).toBeNull();
  });

  describe('where to come back to', () => {
    beforeEach(() => {
      library.autoPaginationEnabled = true;
      library.paged_data = files(4);
      vi.spyOn(library, 'getAutoPageColumns').mockReturnValue(2);
      (library as any).scrollListenerTarget = window;
      (library as any).videoGridContainerElement = element({ top: 100, width: 900 });
      (library as any).videoGridContainerElement.querySelectorAll = () => [];
    });

    it('takes the card clicked, or the row at the top of the viewport when no card is drawn', () => {
      vi.spyOn(library, 'getViewportScrollTop').mockReturnValue(500);
      const clicked = element({ top: 450 }, {});
      clicked.setAttribute('data-file-uid', 'file-3');
      expect((library as any).getVideoAnchorForElement(clicked)).toEqual({ anchorUid: 'file-3', anchorOffset: -450 });
      expect((library as any).getVideoAnchorForElement(element({ top: 0 }))).toBeNull();
      expect((library as any).getApproximateVideoAnchorForUid('file-99')).toBeNull();

      // Scrolled 10px into the grid's second row.
      library.videoRows = [];
      const row_height = library.getAutoCardRowHeight();
      (library as any).videoGridContainerElement.getBoundingClientRect = () => ({ top: -(row_height + 10), width: 900 });
      expect((library as any).getVisibleVideoAnchor()).toEqual({ anchorUid: 'file-3', anchorOffset: 10 });
    });

    it('waits for the right tab, loads more to find the card, and settles on it over a few frames', () => {
      const load_more = vi.spyOn(library, 'loadMoreAutoFiles').mockImplementation(() => {});
      const restore = () => (library as any).restorePendingScrollPosition();
      const snapshot = (fields: Record<string, unknown>) => ({ activeLibraryTab: 0, anchorOffset: 10, scrollTop: 0, ...fields });

      (library as any).pendingScrollRestoreSnapshot = null;
      restore();
      (library as any).pendingScrollRestoreSnapshot = snapshot({ activeLibraryTab: 1, anchorUid: 'file-3' });
      restore();
      expect(load_more).not.toHaveBeenCalled();

      library.file_count = 10;
      (library as any).pendingScrollRestoreSnapshot = snapshot({ anchorUid: 'file-9' });
      restore();
      expect(load_more).toHaveBeenCalledTimes(1);

      const scroll = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
      (library as any).pendingScrollRestoreSnapshot = snapshot({ anchorUid: 'file-3' });
      restore();
      expect(scroll).toHaveBeenLastCalledWith({ top: library.getVideoGridDocumentTop() + library.getAutoCardRowHeight() + 10 });
      expect((library as any).pendingScrollRestoreAttempts).toBe(1);
      expect(frames.length).toBe(1);
    });
  });

  it('keeps the playlists it had when coming back, even with no files to show', () => {
    (library as any).pendingNavigationRestoreState = { snapshot: { routeKey: '/' }, files: [], playlistLibraryItems: [{ id: 'mix' }],
      playlistLibraryReceived: true, filesInvalidated: false, playlistsInvalidated: false };
    expect((library as any).restoreLibraryFromNavigationState()).toBe(false);
    expect(library.playlistLibraryItems).toEqual([{ id: 'mix' }]);
    expect(library.playlistLibraryReceived).toBe(true);
  });

  describe('drawing only the rows near the viewport', () => {
    beforeEach(() => {
      library.autoPaginationEnabled = true;
      library.normal_files_received = true;
      library.paged_data = files(40);
      library.file_count = 40;
      vi.spyOn(library, 'getAutoPageColumns').mockReturnValue(4);
      library.videoRows = (library as any).buildMediaRows(library.paged_data, 4);
      vi.spyOn(library, 'getViewportHeight').mockReturnValue(400);
    });

    it('draws nothing when there are no rows', () => {
      library.videoRows = [];
      library.updateRenderedVideoRows();
      expect([library.visibleVideoRowStart, library.visibleVideoRowEnd, library.renderedVideoRows]).toEqual([0, 0, []]);
    });

    it('draws the first rows while the grid is still below the viewport, and the last once it is above', () => {
      const top = vi.spyOn(library, 'getVideoGridDocumentTop').mockReturnValue(5000);
      vi.spyOn(library, 'getViewportScrollTop').mockReturnValue(0);
      library.updateRenderedVideoRows();
      expect(library.visibleVideoRowStart).toBe(0);
      expect(library.renderedVideoRows.length).toBeGreaterThan(0);

      top.mockReturnValue(-50000);
      library.updateRenderedVideoRows();
      expect(library.visibleVideoRowEnd).toBe(10);
      expect(library.renderedVideoRows.at(-1)).toBe(library.videoRows.at(-1));
    });

    it('updates on the next frame, once, however often it is asked', () => {
      const update = vi.spyOn(library, 'updateRenderedVideoRows');
      library.scheduleVirtualVideoWindowUpdate();
      library.scheduleVirtualVideoWindowUpdate();
      expect(frames.length).toBe(1);
      frames[0](0);
      expect(update).toHaveBeenCalledTimes(1);
    });

    it('loads no more while plenty of rows are left below', () => {
      library.file_count = 100;
      library.visibleVideoRowEnd = 1;
      library.maybeLoadMoreAutoFiles();
      expect((library as any).autoLoadQueued).toBe(false);
    });
  });

  describe('watching the grid', () => {
    it('follows the scroll of the nearest parent that scrolls, and stops cleanly', () => {
      const parent = document.createElement('div');
      parent.style.overflowY = 'auto';
      const grid = document.createElement('div');
      parent.appendChild(grid);
      document.body.appendChild(parent);
      try {
        (library as any).videoGridContainerElement = grid;
        (library as any).refreshScrollListener();
        expect((library as any).scrollListenerTarget).toBe(parent);

        (library as any).virtualRowUpdateFrameId = 7;
        (library as any).unbindScrollListener();
        expect(window.cancelAnimationFrame).toHaveBeenCalledWith(7);
        expect((library as any).virtualRowUpdateFrameId).toBeNull();
      } finally {
        parent.remove();
      }
    });

    it('relays out the grid when it is resized', () => {
      const observed: Element[] = [];
      let resized: () => void;
      vi.stubGlobal('ResizeObserver', class {
        constructor(callback: () => void) { resized = callback; }
        observe(target: Element) { observed.push(target); }
        disconnect() {}
      });
      const relayout = vi.spyOn(library, 'refreshVideoRowsForCurrentLayout').mockImplementation(() => {});
      const grid = document.createElement('div');
      (library as any).videoGridContainerElement = grid;
      try {
        (library as any).refreshVideoGridResizeObserver();
        expect(observed).toEqual([grid]);
        resized();
        expect(relayout).toHaveBeenCalled();
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('does nothing without a grid, or with nothing waiting for a press to end', () => {
      (library as any).videoGridContainerElement = null;
      (library as any).refreshGridPressListeners();
      expect((library as any).gridPressElement).toBeNull();
      expect(() => (library as any).flushDeferredGridRefreshes()).not.toThrow();
    });

    it('lays the grid out again on a resize only while it pages itself', () => {
      const relayout = vi.spyOn(library, 'refreshVideoRowsForCurrentLayout').mockImplementation(() => {});
      library.autoPaginationEnabled = false;
      library.onWindowResize();
      expect(relayout).not.toHaveBeenCalled();
      library.autoPaginationEnabled = true;
      library.onWindowResize();
      expect(relayout).toHaveBeenCalledTimes(1);
      expect(library.loading_files.length).toBe(library.getLoadingPlaceholderCount());
    });
  });

  it('sizes cards and columns for each card size', () => {
    library.setNarrowScreen(false);
    library.setNarrowScreen(false);
    const sizes = ['small', 'large', 'unknown'].map(card_size => {
      posts.card_size = card_size;
      return [library.cardColumnClass, library.getAutoCardWidth(), library.getAutoCardRowHeight()];
    });
    expect(sizes).toEqual([['col-2 small-col', 150, 166], ['col-12 large-col', 300, 266], ['', 200, 216]]);
  });

  it('filters by category without a category list to check against', () => {
    posts.categories = null;
    library.selectedFilters = ['category:science', 'video_only'];
    expect(library.getCategoryFilterOptions()).toEqual([]);
    expect(library.getVisibleCategoryFilterKeySet()).toBeNull();
    expect(library.getCategoryFilterUids()).toEqual(['science']);
    expect(library.getFileTypeFilter()).toBe('video_only');
  });

  it('reloads the files when the sort changes on the files tab', () => {
    const reload = vi.spyOn(library, 'getAllFiles').mockImplementation(() => {});
    library.activeLibraryTab = 0;
    library.sortOptionChanged({ by: 'title', order: 1 } as any);
    expect(reload).toHaveBeenCalled();
    expect(library.descendingMode).toBe(false);
  });

  it('queues one full refresh, and a normal one wins over a cached one', () => {
    (library as any).queueFullFileRefresh(true);
    (library as any).queueFullFileRefresh(false);
    expect((library as any).queuedFullFileRefreshCacheMode).toBe(false);
  });

  it('reads a duration written as hours, minutes and seconds', () => {
    expect(library.durationStringToNumber('1:02:03')).toBe(3723);
  });

  it('keeps the page size it already has', () => {
    library.autoPaginationEnabled = false;
    library.pageSize = 25;
    const reload = vi.spyOn(library, 'getAllFiles');
    library.pageSizeOptionChanged(25);
    expect(reload).not.toHaveBeenCalled();
  });
});
