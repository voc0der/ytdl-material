import { ComponentFixture, TestBed, waitForAsync } from '@angular/core/testing';
import { MatDialog } from '@angular/material/dialog';
import { NEVER, of, throwError } from 'rxjs';

import { DownloadHistoryComponent } from './download-history.component';
import { PostsService } from 'app/posts.services';
import { configureTestBed } from '../../../testing/test-bed';

describe('DownloadHistoryComponent', () => {
  let component: DownloadHistoryComponent;
  let fixture: ComponentFixture<DownloadHistoryComponent>;
  let postsServiceStub: any;
  let dialogStub: any;

  const archive = (overrides: Record<string, unknown> = {}) => ({
    uid: 'archive-1',
    extractor: 'a site',
    id: 'aaa',
    type: 'video',
    title: 'A video',
    sub_id: null,
    timestamp: 1_700_000_000,
    ...overrides
  }) as any;

  // Ordered differently by date, by title and by source, so each order is told apart.
  const archives = [
    archive({ uid: 'archive-1', id: 'aaa', title: 'Zebras', timestamp: 300 }),
    archive({ uid: 'archive-2', id: 'bbb', title: 'Aardvarks', timestamp: 100, extractor: 'another site' }),
    archive({ uid: 'archive-3', id: 'ccc', title: null, timestamp: 200, type: 'audio' })
  ];

  beforeEach(waitForAsync(() => {
    postsServiceStub = {
      subscriptions: [{ id: 'sub-1', name: 'A channel', type: 'audio' }],
      getSubscriptionByID: vi.fn().mockName('getSubscriptionByID').mockReturnValue({ id: 'sub-1', name: 'A channel', type: 'audio' }),
      getArchives: vi.fn().mockName('getArchives').mockReturnValue(of({ archives })),
      deleteArchiveItems: vi.fn().mockName('deleteArchiveItems').mockReturnValue(of({ success: true })),
      downloadArchive: vi.fn().mockName('downloadArchive').mockReturnValue(of(new Blob(['a site aaa']))),
      importArchive: vi.fn().mockName('importArchive').mockReturnValue(of({ success: true })),
      openSnackBar: vi.fn().mockName('openSnackBar')
    };
    dialogStub = { open: vi.fn().mockName('open').mockReturnValue({ afterClosed: () => of(true) }) };

    configureTestBed({
      imports: [DownloadHistoryComponent],
      providers: [
        { provide: PostsService, useValue: postsServiceStub },
        { provide: MatDialog, useValue: dialogStub }
      ]
    }).compileComponents();
  }));

  beforeEach(() => {
    // Saving a blob needs an object URL, which jsdom does not hand out.
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test-url');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    fixture = TestBed.createComponent(DownloadHistoryComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('asks for the whole history when nothing is filtered', () => {
    expect(postsServiceStub.getArchives).toHaveBeenCalledWith(null, null);
    expect(component.archives_retrieved).toBe(true);
    expect(component.matching.length).toBe(3);
  });

  it('shows the newest first', () => {
    expect(component.matching.map(item => item.uid)).toEqual(['archive-1', 'archive-3', 'archive-2']);
  });

  it('reorders without asking the server again', () => {
    postsServiceStub.getArchives.mockClear();

    component.orderChanged('oldest');
    expect(component.matching.map(item => item.uid)).toEqual(['archive-2', 'archive-3', 'archive-1']);

    // The untitled one is ordered by its id, which is what its row shows in place of a title.
    component.orderChanged('title');
    expect(component.matching.map(item => item.uid)).toEqual(['archive-2', 'archive-3', 'archive-1']);

    // Within one source, by title again.
    component.orderChanged('source');
    expect(component.matching.map(item => item.uid)).toEqual(['archive-3', 'archive-1', 'archive-2']);

    expect(postsServiceStub.getArchives).not.toHaveBeenCalled();
  });

  it('searches the title, the id and the source', () => {
    component.filterChanged('bbb');
    expect(component.matching.map(item => item.uid)).toEqual(['archive-2']);

    component.filterChanged('another');
    expect(component.matching.map(item => item.uid)).toEqual(['archive-2']);

    component.filterChanged('zeb');
    expect(component.matching.map(item => item.uid)).toEqual(['archive-1']);
  });

  it('says when a filter is what leaves the list empty', () => {
    component.filterChanged('nothing matches this');

    expect(component.matching).toEqual([]);
    expect(component.filtered).toBe(true);
  });

  it('asks the server for one subscription, and for the type that subscription is', () => {
    component.subFilterSelectionChanged('sub-1');

    expect(component.type).toBe('audio');
    expect(postsServiceStub.getArchives).toHaveBeenCalledWith('audio', 'sub-1');
  });

  it('selects and clears everything the filters leave, not just the page', () => {
    component.filterChanged('');
    component.toggleAll();

    expect(component.selected_count).toBe(3);
    expect(component.all_selected).toBe(true);

    component.toggleAll();

    expect(component.selected_count).toBe(0);
  });

  it('only selects what a filter leaves', () => {
    component.filterChanged('zeb');
    component.toggleAll();

    expect(component.selected_count).toBe(1);
  });

  it('confirms before removing, and removes only what was selected', () => {
    component.toggleSelected(archives[0]);
    component.openDeleteSelectedArchivesDialog();

    expect(dialogStub.open).toHaveBeenCalled();
    expect(postsServiceStub.deleteArchiveItems).toHaveBeenCalledWith([
      expect.objectContaining({ uid: 'archive-1' })
    ]);
  });

  it('takes only the selected items out of the list while the removal is in flight', () => {
    component.toggleSelected(archives[0]);
    postsServiceStub.deleteArchiveItems.mockReturnValue(NEVER);

    component.deleteSelectedArchives();

    expect(component.archives.map(item => item.uid)).toEqual(['archive-2', 'archive-3']);
    expect(component.selected_count).toBe(0);
  });

  it('puts the history back from the server when the removal fails', () => {
    component.toggleSelected(archives[0]);
    postsServiceStub.deleteArchiveItems.mockReturnValue(throwError(() => new Error('nope')));

    component.deleteSelectedArchives();

    expect(component.archives.map(item => item.uid)).toEqual(['archive-1', 'archive-2', 'archive-3']);
    expect(postsServiceStub.openSnackBar).toHaveBeenCalled();
  });

  it('asks for nothing when nothing is selected', () => {
    component.openDeleteSelectedArchivesDialog();

    expect(dialogStub.open).not.toHaveBeenCalled();
    expect(postsServiceStub.deleteArchiveItems).not.toHaveBeenCalled();
  });

  it('drops a selection the server no longer lists', () => {
    component.toggleSelected(archives[0]);
    postsServiceStub.getArchives.mockReturnValue(of({ archives: [archives[1]] }));

    component.getArchives();

    expect(component.selected_count).toBe(0);
  });

  it('pages a history longer than one page', () => {
    postsServiceStub.getArchives.mockReturnValue(of({
      archives: Array.from({ length: 30 }, (_, index) => archive({ uid: `archive-${index}`, id: `id-${index}`, timestamp: index }))
    }));

    component.getArchives();

    expect(component.page_count).toBe(2);
    expect(component.pageItems.length).toBe(25);
    expect(component.range_start).toBe(1);
    expect(component.range_end).toBe(25);

    component.goToPage(1);

    expect(component.pageItems.length).toBe(5);
    expect(component.range_end).toBe(30);

    component.goToPage(5);

    expect(component.page_index).toBe(1);
  });

  it('exports the history the filters ask for', () => {
    component.subFilterSelectionChanged('sub-1');
    component.downloadArchive();

    expect(postsServiceStub.downloadArchive).toHaveBeenCalledWith('audio', 'sub-1');
  });

  it('imports under no subscription unless one was chosen', () => {
    component.subUploadFilterSelectionChanged('sub-1');

    expect(component.upload_type).toBe('audio');
  });

  it('keeps only files out of what was dropped', () => {
    component.dropped([
      { relativePath: 'archive.txt', fileEntry: { isFile: true } },
      { relativePath: 'a folder', fileEntry: { isFile: false } }
    ] as any);

    expect(component.files.length).toBe(1);

    component.clearDroppedFiles();

    expect(component.files).toEqual([]);
  });

  it('stays usable when the history cannot be loaded', () => {
    postsServiceStub.getArchives.mockReturnValue(throwError(() => new Error('nope')));

    component.getArchives();

    expect(component.archives_retrieved).toBe(true);
  });
});
