import { DownloadsComponent } from './downloads.component';
import { Download } from 'api-types';
import { fakeAsync, tick } from '@angular/core/testing';
import { of, Subject } from 'rxjs';

describe('DownloadsComponent', () => {
  let component: DownloadsComponent;
  let posts_service_mock: any;
  let router_mock: any;
  let dialog_mock: any;
  let clipboard_mock: any;

  beforeEach(() => {
    localStorage.removeItem('downloads_page_size');

    posts_service_mock = {
      config: { Extra: { enable_downloads_manager: true } },
      initialized: true,
      service_initialized: of(true),
      getCurrentDownloads: vi.fn().mockName('getCurrentDownloads').mockReturnValue(of({ downloads: [] })),
      pauseDownload: vi.fn().mockName('pauseDownload').mockReturnValue(of({ success: true })),
      resumeDownload: vi.fn().mockName('resumeDownload').mockReturnValue(of({ success: true })),
      restartDownload: vi.fn().mockName('restartDownload').mockReturnValue(of({ success: true })),
      openSnackBar: vi.fn().mockName('openSnackBar')
    };
    router_mock = {
      navigate: vi.fn().mockName('navigate'),
      url: '/downloads'
    };
    dialog_mock = { open: () => ({}), openDialogs: [] };
    clipboard_mock = { copy: () => true };

    component = new DownloadsComponent(posts_service_mock, router_mock, dialog_mock, clipboard_mock);
  });

  it('should create component instance', () => {
    expect(component).toBeTruthy();
  });

  it('does not coerce null percent to 0.00', () => {
    const download = {
      uid: 'download-1',
      error: null,
      finished: false,
      step_index: 1,
      percent_complete: null
    } as unknown as Download;

    expect(component.getNormalizedPercent(download)).toBeNull();
    expect(component.shouldShowPercentComplete(download)).toBe(false);
  });

  it('keeps step text when percent is missing during step 2', () => {
    const download = {
      uid: 'download-1b',
      error: null,
      finished: false,
      step_index: 2,
      percent_complete: null
    } as unknown as Download;

    expect(component.shouldShowPercentComplete(download)).toBe(false);
    expect(component.getNormalizedPercent(download)).toBeNull();
  });

  it('shows percent once a real numeric value exists', () => {
    const download = {
      uid: 'download-2',
      error: null,
      finished: false,
      step_index: 2,
      percent_complete: '12.34'
    } as unknown as Download;

    expect(component.shouldShowPercentComplete(download)).toBe(true);
    expect(component.getNormalizedPercent(download)).toBe('12.34');
  });

  it('clamps percent to 100.00 for display', () => {
    const download = {
      uid: 'download-3',
      error: null,
      finished: false,
      step_index: 2,
      percent_complete: 123.456
    } as unknown as Download;

    expect(component.getNormalizedPercent(download)).toBe('100.00');
  });

  it('tracks whether failed downloads can be retried', () => {
    posts_service_mock.getCurrentDownloads.mockReturnValue(of({
      downloads: [
        { uid: 'download-1', error: 'Network error', cancelled: false },
        { uid: 'download-2', error: null, cancelled: false }
      ]
    }));

    component.getCurrentDownloads();

    expect(component.failed_download_exists).toBe(true);
  });

  it('does not overlap recurring downloads requests', fakeAsync(() => {
    const first_request = new Subject<any>();
    const second_request = new Subject<any>();
    posts_service_mock.getCurrentDownloads.mockReturnValueOnce(first_request.asObservable()).mockReturnValueOnce(second_request.asObservable());

    component.getCurrentDownloadsRecurring();
    expect(posts_service_mock.getCurrentDownloads).toHaveBeenCalledTimes(1);
    expect(posts_service_mock.getCurrentDownloads).toHaveBeenCalledWith(null, false, 0, 20);

    tick(component.downloads_check_interval * 3);
    expect(posts_service_mock.getCurrentDownloads).toHaveBeenCalledTimes(1);

    first_request.next({
      downloads: [{ uid: 'running-download', finished: false, paused: false, timestamp_start: 1 }]
    });
    first_request.complete();
    tick(component.downloads_check_interval - 1);
    expect(posts_service_mock.getCurrentDownloads).toHaveBeenCalledTimes(1);

    tick(1);
    expect(posts_service_mock.getCurrentDownloads).toHaveBeenCalledTimes(2);
    component.ngOnDestroy();
  }));

  it('backs off after an error and returns to the normal interval after recovery', fakeAsync(() => {
    const failed_request = new Subject<any>();
    const recovered_request = new Subject<any>();
    const next_request = new Subject<any>();
    posts_service_mock.getCurrentDownloads.mockReturnValueOnce(failed_request.asObservable()).mockReturnValueOnce(recovered_request.asObservable()).mockReturnValueOnce(next_request.asObservable());

    component.getCurrentDownloadsRecurring();
    failed_request.error(new Error('Bad Gateway'));

    expect(component.downloads_retrieved).toBe(true);
    expect(component.downloads_load_error).toBe(true);
    tick(component.downloads_error_retry_interval - 1);
    expect(posts_service_mock.getCurrentDownloads).toHaveBeenCalledTimes(1);

    tick(1);
    expect(posts_service_mock.getCurrentDownloads).toHaveBeenCalledTimes(2);

    recovered_request.next({
      downloads: [{ uid: 'running-download', finished: false, paused: false, timestamp_start: 1 }]
    });
    expect(component.downloads_load_error).toBe(false);
    recovered_request.complete();
    tick(component.downloads_check_interval - 1);
    expect(posts_service_mock.getCurrentDownloads).toHaveBeenCalledTimes(2);

    tick(1);
    expect(posts_service_mock.getCurrentDownloads).toHaveBeenCalledTimes(3);
    component.ngOnDestroy();
  }));

  it('cancels an in-flight downloads request when destroyed', fakeAsync(() => {
    const pending_request = new Subject<any>();
    posts_service_mock.getCurrentDownloads.mockReturnValue(pending_request.asObservable());

    component.getCurrentDownloadsRecurring();
    expect(pending_request.observers.length).toBe(1);

    component.ngOnDestroy();
    expect(pending_request.observers.length).toBe(0);

    tick(component.downloads_max_error_retry_interval);
    expect(posts_service_mock.getCurrentDownloads).toHaveBeenCalledTimes(1);
  }));

  it('uses a slower poll interval when the downloads page has no active work', fakeAsync(() => {
    const next_request = new Subject<any>();
    posts_service_mock.getCurrentDownloads.mockReturnValueOnce(of({ downloads: [], total_count: 0, page: 0, page_size: 10 })).mockReturnValueOnce(next_request.asObservable());

    component.getCurrentDownloadsRecurring();
    tick(component.downloads_idle_check_interval - 1);
    expect(posts_service_mock.getCurrentDownloads).toHaveBeenCalledTimes(1);

    tick(1);
    expect(posts_service_mock.getCurrentDownloads).toHaveBeenCalledTimes(2);
    component.ngOnDestroy();
  }));

  it('cancels a scheduled downloads poll when destroyed', fakeAsync(() => {
    posts_service_mock.getCurrentDownloads.mockReturnValue(of({ downloads: [] }));

    component.getCurrentDownloadsRecurring();
    expect(posts_service_mock.getCurrentDownloads).toHaveBeenCalledTimes(1);

    component.ngOnDestroy();
    tick(component.downloads_idle_check_interval);

    expect(posts_service_mock.getCurrentDownloads).toHaveBeenCalledTimes(1);
  }));

  it('requests and applies the selected server downloads page', () => {
    posts_service_mock.getCurrentDownloads.mockReturnValue(of({
      downloads: [{ uid: 'page-download', timestamp_start: 1 }],
      total_count: 47,
      page: 1,
      page_size: 20
    }));
    component.pageIndex = 2;
    component.pageSize = 20;

    component.getCurrentDownloads();

    expect(posts_service_mock.getCurrentDownloads).toHaveBeenCalledTimes(1);

    expect(posts_service_mock.getCurrentDownloads).toHaveBeenCalledWith(null, false, 2, 20);
    expect(component.downloads_total_count).toBe(47);
    expect(component.pageIndex).toBe(1);
    expect(component.pageSize).toBe(20);
    expect(component.downloads.map(download => download.uid)).toEqual(['page-download']);
  });

  it('cancels a stale page request and immediately loads a newly selected page', fakeAsync(() => {
    const first_page_request = new Subject<any>();
    const selected_page_request = new Subject<any>();
    posts_service_mock.getCurrentDownloads.mockReturnValueOnce(first_page_request.asObservable()).mockReturnValueOnce(selected_page_request.asObservable());

    component.downloads_total_count = 100;
    component.getCurrentDownloadsRecurring();
    expect(first_page_request.observers.length).toBe(1);

    component.goToPage(3);

    expect(first_page_request.observers.length).toBe(0);
    expect(posts_service_mock.getCurrentDownloads).toHaveBeenCalledTimes(2);
    expect(vi.mocked(posts_service_mock.getCurrentDownloads).mock.lastCall).toEqual([null, false, 3, 20]);
    component.ngOnDestroy();
  }));

  it('will not page past what the server said it has', () => {
    posts_service_mock.getCurrentDownloads.mockReturnValue(of({ downloads: [], total_count: 25, page: 1, page_size: 20 }));
    component.downloads_total_count = 25;
    component.pageSize = 20;

    component.goToPage(7);

    expect(component.pageIndex).toBe(1);
    expect(component.rangeStart).toBe(21);
    expect(component.rangeEnd).toBe(25);
  });

  it('keeps the first download of the page in view when the page size changes', () => {
    component.downloads_total_count = 100;
    component.pageSize = 10;
    component.pageIndex = 4;

    component.choosePageSize(20);

    expect(component.pageIndex).toBe(2);
    expect(vi.mocked(posts_service_mock.getCurrentDownloads).mock.lastCall).toEqual([null, false, 2, 20]);
  });

  it('navigates lean playlist summaries by container id', () => {
    component.watchContent({
      uid: 'playlist-download',
      type: 'video',
      container: { id: 'playlist-id' }
    } as unknown as Download);

    expect(router_mock.navigate).toHaveBeenCalledTimes(1);

    expect(router_mock.navigate).toHaveBeenCalledWith([
      '/player',
      { playlist_id: 'playlist-id', type: 'video' }
    ]);
  });

  it('retries failed downloads only', () => {
    component.raw_downloads = [
      { uid: 'failed-1', error: 'Network error', finished: true, cancelled: false },
      { uid: 'complete-1', error: null, finished: true, cancelled: false },
      { uid: 'cancelled-1', error: 'Cancelled', error_type: 'cancelled', finished: true, cancelled: true }
    ] as unknown as Download[];

    component.retryFailedDownloads();

    expect(posts_service_mock.restartDownload).toHaveBeenCalledTimes(1);

    expect(posts_service_mock.restartDownload).toHaveBeenCalledWith('failed-1');
  });

  it('shows a failure message when retrying failed downloads fails', () => {
    component.raw_downloads = [
      { uid: 'failed-1', error: 'Network error', finished: true, cancelled: false }
    ] as unknown as Download[];
    posts_service_mock.restartDownload.mockReturnValue(of({ success: false }));

    component.retryFailedDownloads();

    expect(posts_service_mock.openSnackBar).toHaveBeenCalled();
  });

  it('shows resume instead of pause for paused downloads interrupted mid-step', () => {
    const pause_action = component.downloadActions.find(action => action.icon === 'pause')!;
    const resume_action = component.downloadActions.find(action => action.icon === 'play_arrow')!;
    const interrupted_download = {
      uid: 'paused-mid-step',
      finished: false,
      paused: true,
      finished_step: false
    } as unknown as Download;

    expect(pause_action.show(interrupted_download)).toBe(false);
    expect(resume_action.show(interrupted_download)).toBe(true);
  });

  it('resumes paused downloads even when their queue step needs retrying', () => {
    const interrupted_download = {
      uid: 'paused-mid-step',
      finished: false,
      paused: true,
      finished_step: false
    } as unknown as Download;

    component.resumeDownload(interrupted_download);

    expect(posts_service_mock.resumeDownload).toHaveBeenCalledTimes(1);

    expect(posts_service_mock.resumeDownload).toHaveBeenCalledWith('paused-mid-step');
    expect(posts_service_mock.pauseDownload).not.toHaveBeenCalled();
  });

  it('persists the downloads page size', () => {
    component.choosePageSize(50);

    const restored_component = new DownloadsComponent(posts_service_mock, router_mock, dialog_mock, clipboard_mock);

    expect(localStorage.getItem(component.pageSizeStorageKey)).toBe('50');
    expect(restored_component.pageSize).toBe(50);
  });

  it('tells apart the states a row is worded and coloured by', () => {
    const download = (overrides: Record<string, unknown>) => ({ uid: 'state', ...overrides }) as unknown as Download;

    expect(component.state(download({ error: 'Network error', finished: true }))).toBe('failed');
    expect(component.state(download({ error: 'Cancelled', error_type: 'cancelled', cancelled: true }))).toBe('cancelled');
    expect(component.state(download({ finished: true }))).toBe('finished');
    expect(component.state(download({ paused: true }))).toBe('paused');
    expect(component.state(download({ step_index: 2 }))).toBe('running');
    expect(component.state(download({}))).toBe('queued');
    // `running` goes false between steps; a download in the middle of one is still running.
    expect(component.state(download({ step_index: 2, running: false }))).toBe('running');
  });

  it('says where a running download has got to, and calls a finished one complete', () => {
    expect(component.statusText({ uid: 'a', step_index: 2 } as unknown as Download)).toBe('Downloading file');
    expect(component.statusText({ uid: 'a2', step_index: 0 } as unknown as Download)).toBe('Queued');
    expect(component.statusText({ uid: 'b', finished: true } as unknown as Download)).toBe('Complete');
    expect(component.statusText({ uid: 'c', finished: true, error: 'boom' } as unknown as Download)).toBe('Failed');
  });

  it('shows only the first line of a failure in the row', () => {
    const download = { uid: 'd', error: '\n  ERROR: video unavailable\nTraceback...\n' } as unknown as Download;

    expect(component.errorSummary(download)).toBe('ERROR: video unavailable');
  });

  it('has no progress bar until there is a percentage to show', () => {
    expect(component.showProgressBar({ uid: 'e', step_index: 2, percent_complete: null } as unknown as Download)).toBe(false);
    expect(component.showProgressBar({ uid: 'f', step_index: 2, percent_complete: 40 } as unknown as Download)).toBe(true);
    expect(component.showProgressBar({ uid: 'g', finished: true } as unknown as Download)).toBe(false);
  });

  it('merges chunked playlist progress with global sequential indices', () => {
    const chunk_1 = {
      uid: 'chunk-1',
      options: { playlistChunkRange: '1-3' },
      playlist_item_progress: [
        { index: 1, title: 'A', expected_file_size: 1, downloaded_size: 1, percent_complete: 100, status: 'complete', progress_path_index: 0 },
        { index: 2, title: 'B', expected_file_size: 1, downloaded_size: 0, percent_complete: 10, status: 'downloading', progress_path_index: 1 },
        { index: 3, title: 'C', expected_file_size: 1, downloaded_size: 0, percent_complete: 0, status: 'pending', progress_path_index: 2 }
      ]
    };
    const chunk_2 = {
      uid: 'chunk-2',
      options: { playlistChunkRange: '4-6' },
      playlist_item_progress: [
        { index: 1, title: 'D', expected_file_size: 1, downloaded_size: 0, percent_complete: 0, status: 'pending', progress_path_index: 0 },
        { index: 2, title: 'E', expected_file_size: 1, downloaded_size: 0, percent_complete: 0, status: 'pending', progress_path_index: 1 },
        { index: 3, title: 'F', expected_file_size: 1, downloaded_size: 0, percent_complete: 0, status: 'pending', progress_path_index: 2 }
      ]
    };

    const merged = (component as any).mergeBatchPlaylistProgress([chunk_2 as any, chunk_1 as any]);

    expect(Array.isArray(merged)).toBe(true);
    expect(merged.map(item => item.index)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(merged.map(item => item.title)).toEqual(['A', 'B', 'C', 'D', 'E', 'F']);
  });
});
