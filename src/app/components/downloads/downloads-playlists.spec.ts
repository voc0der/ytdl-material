import { Clipboard } from '@angular/cdk/clipboard';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MatDialog } from '@angular/material/dialog';
import { Router } from '@angular/router';
import { of, Subject, throwError } from 'rxjs';
import { Download } from 'api-types';

import { PostsService } from 'app/posts.services';
import { PLAYER_NAVIGATOR_STORAGE_KEY } from 'app/media-library-navigation-state.service';
import { PlaylistDownloadProgressDialogComponent } from 'app/dialogs/playlist-download-progress-dialog/playlist-download-progress-dialog.component';
import { configureTestBed } from '../../../testing/test-bed';
import { DownloadsComponent } from './downloads.component';

type Chunk = Download & { options: Record<string, unknown> };

function chunk(uid: string, range: string, overrides: Partial<Chunk> = {}): Chunk {
  return {
    uid, title: `Saved playlist [Chunk 1/2: ${range}]`, url: 'https://example.com/playlist',
    type: 'video', timestamp_start: 1000, running: false, finished: false, paused: false,
    finished_step: true, step_index: 2, percent_complete: 0,
    ...overrides,
    options: { playlistBatchId: 'batch', playlistChunkRange: range, ...overrides.options }
  };
}

const progressItem = (index: number, expected: number, downloaded: number) => ({
  index, title: `Item ${index}`, expected_file_size: expected, downloaded_size: downloaded,
  percent_complete: expected ? downloaded / expected * 100 : 0, status: 'downloading'
});

describe('Playlist batches on the downloads page', () => {
  let fixture: ComponentFixture<DownloadsComponent>;
  let component: DownloadsComponent;
  let posts: any;
  let router: any;
  let dialog: any;

  const rowButton = (label: string): HTMLButtonElement | null =>
    fixture.nativeElement.querySelector(`.download-actions button[aria-label="${label}"]`);
  const rowState = () => fixture.nativeElement.querySelector('.download-row').dataset.state;

  function load(downloads: Download[]): Download {
    posts.getCurrentDownloads.mockReturnValue(of({ downloads, total_count: downloads.length }));
    component.getCurrentDownloads();
    fixture.detectChanges();
    return component.downloads.find(download => download.uid === 'playlist-batch:batch') ?? component.downloads[0];
  }

  beforeEach(async () => {
    localStorage.removeItem('downloads_page_size');
    sessionStorage.removeItem(PLAYER_NAVIGATOR_STORAGE_KEY);
    posts = {
      initialized: false,
      service_initialized: new Subject<boolean>(),
      config: { Extra: { enable_downloads_manager: true } },
      getCurrentDownloads: vi.fn(),
      pauseDownload: vi.fn().mockReturnValue(of({ success: true })),
      resumeDownload: vi.fn().mockReturnValue(of({ success: true })),
      cancelDownload: vi.fn().mockReturnValue(of({ success: true })),
      clearDownload: vi.fn().mockReturnValue(of({ success: true })),
      restartDownload: vi.fn().mockReturnValue(of({ success: true })),
      openSnackBar: vi.fn()
    };
    router = { url: '/downloads', navigate: vi.fn() };
    dialog = { open: vi.fn(), openDialogs: [] };
    dialog.open.mockImplementation((_component, { data }) => {
      const closed = new Subject<void>();
      const instance = new PlaylistDownloadProgressDialogComponent(data);
      instance.ngOnInit();
      const ref = {
        componentInstance: instance,
        afterClosed: () => closed,
        close: vi.fn(() => {
          dialog.openDialogs = dialog.openDialogs.filter(open => open !== ref);
          closed.next();
          closed.complete();
        })
      };
      dialog.openDialogs.push(ref);
      return ref;
    });

    await configureTestBed({
      imports: [DownloadsComponent],
      providers: [
        { provide: PostsService, useValue: posts },
        { provide: Router, useValue: router },
        { provide: MatDialog, useValue: dialog },
        { provide: Clipboard, useValue: { copy: vi.fn() } }
      ]
    }).compileComponents();
    fixture = TestBed.createComponent(DownloadsComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('groups chunks while preserving standalone downloads and the source records', () => {
    const first = chunk('first', '1-2', { options: { playlistChunkIndex: 0, playlistChunkCount: 2 } });
    const second = chunk('second', '3-4', { timestamp_start: 2000 });
    const single = { ...chunk('single', '1-2'), options: {} };
    const otherBatch = chunk('other-batch', '1-2', { options: { playlistBatchId: 'other' } });

    const aggregate = load([second, first, single, otherBatch]);

    expect(component.downloads).toHaveLength(3);
    expect(fixture.nativeElement.querySelectorAll('.download-row')).toHaveLength(3);
    expect(aggregate.title).toBe('Saved playlist');
    expect(aggregate.timestamp_start).toBe(1000);
    expect(aggregate['batch_download_uids']).toEqual(['first', 'second']);
    expect(aggregate['options']).toEqual({ playlistBatchId: 'batch' });
    expect(first.options.playlistChunkRange).toBe('1-2');
    expect(first.options.playlistChunkCount).toBe(2);
  });

  it('offers Resume when completed chunks are followed by paused chunks', () => {
    load([
      chunk('done', '1-2', { finished: true, step_index: 3, percent_complete: 100 }),
      chunk('paused', '3-4', { paused: true, percent_complete: 25 })
    ]);

    expect(rowState()).toBe('paused');
    expect(rowButton('Pause')).toBeNull();
    expect(rowButton('Cancel')).toBeNull();
    expect(rowButton('Resume')).not.toBeNull();
    rowButton('Resume')!.click();
    expect(posts.resumeDownload.mock.calls).toEqual([['paused']]);
  });

  it('offers both Pause and Resume when unfinished chunks have different states', () => {
    load([
      chunk('running', '1-2', { running: true }),
      chunk('paused', '3-4', { paused: true }),
      chunk('done', '5-6', { finished: true, step_index: 3 })
    ]);

    expect(rowState()).toBe('running');
    expect(rowButton('Resume')).not.toBeNull();
    rowButton('Resume')!.click();
    rowButton('Pause')!.click();
    rowButton('Cancel')!.click();
    expect(posts.resumeDownload.mock.calls).toEqual([['paused']]);
    expect(posts.pauseDownload.mock.calls).toEqual([['running']]);
    expect(posts.cancelDownload.mock.calls).toEqual([['running']]);
  });

  it('keeps remaining chunks active after an earlier chunk is cancelled', () => {
    load([
      chunk('cancelled', '1-2', { finished: true, cancelled: true, error: 'Cancelled', error_type: 'cancelled' }),
      chunk('running', '3-4', { running: true })
    ]);

    expect(rowState()).toBe('running');
    expect(rowButton('Cancel')).not.toBeNull();
    rowButton('Cancel')!.click();
    expect(posts.cancelDownload.mock.calls).toEqual([['running']]);
  });

  it.each([0, 2000])('shows a real failure even when a cancelled chunk has timestamp %i', timestamp => {
    load([
      chunk('cancelled', '1-2', { timestamp_start: timestamp, finished: true, cancelled: true, error: 'Cancelled', error_type: 'cancelled' }),
      chunk('failed', '3-4', { finished: true, error: 'Network error', error_type: 'network' })
    ]);

    expect(rowState()).toBe('failed');
    expect(fixture.nativeElement.querySelector('.download-error').textContent).toContain('Network error');
    component.retryFailedDownloads();
    expect(posts.restartDownload.mock.calls).toEqual([['failed']]);
  });

  it('marks an entirely cancelled batch as cancelled', () => {
    const cancelled = { finished: true, cancelled: true, error: 'Cancelled', error_type: 'cancelled' };
    load([chunk('first', '1-2', cancelled), chunk('second', '3-4', cancelled)]);

    expect(rowState()).toBe('cancelled');
    expect(component.failed_download_exists).toBe(false);
    expect(rowButton('Pause')).toBeNull();
    expect(rowButton('Resume')).toBeNull();
    rowButton('Clear')!.click();
    expect(posts.clearDownload.mock.calls).toEqual([['first'], ['second']]);
  });

  it('recognizes cancellation before its separate cancelled flag arrives', () => {
    load([
      chunk('cancelled', '1-2', { finished: true, error: 'Cancelled', error_type: 'cancelled' }),
      chunk('done', '3-4', { finished: true })
    ]);

    expect(rowState()).toBe('cancelled');
    expect(component.failed_download_exists).toBe(false);
  });

  it('counts actual chunk failures without including cancellations', () => {
    const aggregate = load([
      chunk('disk', '1-2', { finished: true, error: 'Disk full', error_type: 'download_failed' }),
      chunk('network', '3-4', { finished: true, error: 'Network error', error_type: 'network' }),
      chunk('cancelled', '5-6', { finished: true, cancelled: true, error: 'Cancelled', error_type: 'cancelled' })
    ]);

    expect(rowState()).toBe('failed');
    expect(aggregate.error).toBe('2 chunk(s) failed. Disk full');
    expect(aggregate.error_type).toBe('download_failed');
    component.retryFailedDownloads();
    expect(posts.restartDownload.mock.calls).toEqual([['disk'], ['network']]);
  });

  it('opens the completed playlist rather than an individual chunk file', () => {
    const aggregate = load([
      chunk('first', '1-2', { finished: true, container: { uid: 'file' }, options: { playlistChunkTitle: ' Full playlist ' } }),
      chunk('second', '3-4', { finished: true, container: { id: 'playlist' } })
    ]);

    expect(rowState()).toBe('finished');
    expect(aggregate.title).toBe('Full playlist');
    expect(aggregate.percent_complete).toBe(100);
    rowButton('Watch content')!.click();
    expect(router.navigate).toHaveBeenCalledWith(['/player', { playlist_id: 'playlist', type: 'video' }]);
    expect(sessionStorage.getItem(PLAYER_NAVIGATOR_STORAGE_KEY)).toBe('/downloads');
  });

  it('orders playlist items globally and weights progress by their file sizes', () => {
    const aggregate = load([
      chunk('second', '2', { playlist_item_progress: [progressItem(1, 300, 0)] }),
      chunk('first', '1', { playlist_item_progress: [progressItem(1, 100, 100)] })
    ]);

    expect(aggregate.playlist_item_progress!.map(item => item.index)).toEqual([1, 2]);
    expect(aggregate.percent_complete).toBe(25);
    expect(fixture.nativeElement.querySelector('.download-percent').textContent).toContain('25.00%');
    expect(aggregate.playlist_item_progress!.every(item => !('sort_global_index' in item))).toBe(true);
  });

  it('uses item percentages when file sizes are unavailable', () => {
    const aggregate = load([
      chunk('first', '1', { playlist_item_progress: [{ ...progressItem(1, 0, 0), percent_complete: 20 }] }),
      chunk('second', '2', { playlist_item_progress: [{ ...progressItem(1, 0, 0), percent_complete: 80 }] })
    ]);
    expect(aggregate.percent_complete).toBe(50);
  });

  it('uses chunk percentages when item progress has not arrived', () => {
    const aggregate = load([chunk('first', '1', { percent_complete: 20 }), chunk('second', '2', { percent_complete: 80 })]);
    expect(aggregate.percent_complete).toBe(50);
    expect(component.hasPlaylistItemProgress(aggregate)).toBe(false);
    component.showPlaylistProgress(aggregate);
    expect(dialog.open).not.toHaveBeenCalled();
  });

  it.each([
    ['Pause', 'pauseDownload', { running: true }],
    ['Resume', 'resumeDownload', { paused: true }],
    ['Cancel', 'cancelDownload', { running: true }],
    ['Clear', 'clearDownload', { finished: true }],
    ['Restart', 'restartDownload', { finished: true }]
  ] as const)('attempts every eligible chunk and reports a partial %s failure', (label, method, state) => {
    load([chunk('first', '1-2', state), chunk('second', '3-4', state)]);
    posts[method].mockReturnValueOnce(throwError(() => new Error('offline')));

    rowButton(label)!.click();

    expect(posts[method].mock.calls).toEqual([['first'], ['second']]);
    expect(posts.openSnackBar).toHaveBeenCalledTimes(1);
    expect(posts.openSnackBar.mock.calls[0][0]).toContain('Failed to');
  });

  it('keeps an open progress dialog current as chunks change or disappear', () => {
    load([
      chunk('first', '1-2', { playlist_item_progress: [progressItem(1, 100, 25)] }),
      chunk('second', '3-4', { playlist_item_progress: [progressItem(1, 100, 50)] })
    ]);
    fixture.nativeElement.querySelector('.download-items').click();
    const ref = component.playlist_progress_dialog_ref!;
    expect(ref.componentInstance.overall_percent).toBe('37.50');

    const remaining = chunk('second', '3-4', {
      percent_complete: 75, playlist_item_progress: [progressItem(1, 100, 75)]
    });
    load([remaining]);

    expect(ref.componentInstance.download!.uid).toBe('second');
    expect(ref.componentInstance.overall_percent).toBe('75.00');
    expect(dialog.open).toHaveBeenCalledTimes(1);
    ref.close();
    expect(component.playlist_progress_dialog_ref).toBeNull();
    expect(component.playlist_progress_dialog_key).toBeNull();
  });

  it('closes the previous progress dialog when another is opened and on teardown', () => {
    const aggregate = load([
      chunk('first', '1', { playlist_item_progress: [progressItem(1, 100, 0)] }),
      chunk('second', '2', { playlist_item_progress: [progressItem(1, 100, 0)] })
    ]);
    component.showPlaylistProgress(aggregate);
    const first = component.playlist_progress_dialog_ref!;
    component.showPlaylistProgress(aggregate);
    const second = component.playlist_progress_dialog_ref!;

    expect(first.close).toHaveBeenCalledTimes(1);
    expect(component.playlist_progress_dialog_key).toBe('playlist-batch:batch');
    expect(second).not.toBe(first);
    fixture.destroy();
    expect(second.close).toHaveBeenCalledTimes(1);
  });

  it('removes obsolete errors after a restart without replacing the underlying record', () => {
    load([chunk('first', '1-2', { finished: true, error: 'Old failure', error_type: 'network' })]);
    const original = component.raw_downloads[0];
    load([chunk('first', '1-2', { running: true })]);

    expect(component.raw_downloads[0]).toBe(original);
    expect(original.error).toBeUndefined();
    expect(original.error_type).toBeUndefined();
    expect(rowState()).toBe('running');
    expect(component.failed_download_exists).toBe(false);
  });
});
