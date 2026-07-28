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
      getCurrentDownloads: jasmine.createSpy('getCurrentDownloads').and.returnValue(of({downloads: []})),
      pauseDownload: jasmine.createSpy('pauseDownload').and.returnValue(of({success: true})),
      resumeDownload: jasmine.createSpy('resumeDownload').and.returnValue(of({success: true})),
      restartDownload: jasmine.createSpy('restartDownload').and.returnValue(of({success: true})),
      openSnackBar: jasmine.createSpy('openSnackBar')
    };
    router_mock = {
      navigate: jasmine.createSpy('navigate'),
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
    expect(component.shouldShowPercentComplete(download)).toBeFalse();
  });

  it('keeps step text when percent is missing during step 2', () => {
    const download = {
      uid: 'download-1b',
      error: null,
      finished: false,
      step_index: 2,
      percent_complete: null
    } as unknown as Download;

    expect(component.shouldShowPercentComplete(download)).toBeFalse();
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

    expect(component.shouldShowPercentComplete(download)).toBeTrue();
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
    posts_service_mock.getCurrentDownloads.and.returnValue(of({
      downloads: [
        {uid: 'download-1', error: 'Network error', cancelled: false},
        {uid: 'download-2', error: null, cancelled: false}
      ]
    }));

    component.getCurrentDownloads();

    expect(component.failed_download_exists).toBeTrue();
  });

  it('does not overlap recurring downloads requests', fakeAsync(() => {
    const first_request = new Subject<any>();
    const second_request = new Subject<any>();
    posts_service_mock.getCurrentDownloads.and.returnValues(
      first_request.asObservable(),
      second_request.asObservable()
    );

    component.getCurrentDownloadsRecurring();
    expect(posts_service_mock.getCurrentDownloads).toHaveBeenCalledOnceWith(null, false, 0, 10);

    tick(component.downloads_check_interval * 3);
    expect(posts_service_mock.getCurrentDownloads).toHaveBeenCalledTimes(1);

    first_request.next({
      downloads: [{uid: 'running-download', finished: false, paused: false, timestamp_start: 1}]
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
    posts_service_mock.getCurrentDownloads.and.returnValues(
      failed_request.asObservable(),
      recovered_request.asObservable(),
      next_request.asObservable()
    );

    component.getCurrentDownloadsRecurring();
    failed_request.error(new Error('Bad Gateway'));

    expect(component.downloads_retrieved).toBeTrue();
    expect(component.downloads_load_error).toBeTrue();
    tick(component.downloads_error_retry_interval - 1);
    expect(posts_service_mock.getCurrentDownloads).toHaveBeenCalledTimes(1);

    tick(1);
    expect(posts_service_mock.getCurrentDownloads).toHaveBeenCalledTimes(2);

    recovered_request.next({
      downloads: [{uid: 'running-download', finished: false, paused: false, timestamp_start: 1}]
    });
    expect(component.downloads_load_error).toBeFalse();
    recovered_request.complete();
    tick(component.downloads_check_interval - 1);
    expect(posts_service_mock.getCurrentDownloads).toHaveBeenCalledTimes(2);

    tick(1);
    expect(posts_service_mock.getCurrentDownloads).toHaveBeenCalledTimes(3);
    component.ngOnDestroy();
  }));

  it('cancels an in-flight downloads request when destroyed', fakeAsync(() => {
    const pending_request = new Subject<any>();
    posts_service_mock.getCurrentDownloads.and.returnValue(pending_request.asObservable());

    component.getCurrentDownloadsRecurring();
    expect(pending_request.observers.length).toBe(1);

    component.ngOnDestroy();
    expect(pending_request.observers.length).toBe(0);

    tick(component.downloads_max_error_retry_interval);
    expect(posts_service_mock.getCurrentDownloads).toHaveBeenCalledTimes(1);
  }));

  it('uses a slower poll interval when the downloads page has no active work', fakeAsync(() => {
    const next_request = new Subject<any>();
    posts_service_mock.getCurrentDownloads.and.returnValues(
      of({downloads: [], total_count: 0, page: 0, page_size: 10}),
      next_request.asObservable()
    );

    component.getCurrentDownloadsRecurring();
    tick(component.downloads_idle_check_interval - 1);
    expect(posts_service_mock.getCurrentDownloads).toHaveBeenCalledTimes(1);

    tick(1);
    expect(posts_service_mock.getCurrentDownloads).toHaveBeenCalledTimes(2);
    component.ngOnDestroy();
  }));

  it('cancels a scheduled downloads poll when destroyed', fakeAsync(() => {
    posts_service_mock.getCurrentDownloads.and.returnValue(of({downloads: []}));

    component.getCurrentDownloadsRecurring();
    expect(posts_service_mock.getCurrentDownloads).toHaveBeenCalledTimes(1);

    component.ngOnDestroy();
    tick(component.downloads_idle_check_interval);

    expect(posts_service_mock.getCurrentDownloads).toHaveBeenCalledTimes(1);
  }));

  it('requests and applies the selected server downloads page', () => {
    posts_service_mock.getCurrentDownloads.and.returnValue(of({
      downloads: [{uid: 'page-download', timestamp_start: 1}],
      total_count: 47,
      page: 1,
      page_size: 20
    }));
    component.pageIndex = 2;
    component.pageSize = 20;

    component.getCurrentDownloads();

    expect(posts_service_mock.getCurrentDownloads).toHaveBeenCalledOnceWith(null, false, 2, 20);
    expect(component.downloads_total_count).toBe(47);
    expect(component.pageIndex).toBe(1);
    expect(component.pageSize).toBe(20);
    expect(component.dataSource.data.map(download => download.uid)).toEqual(['page-download']);
    expect(component.dataSource.paginator).toBeNull();
  });

  it('cancels a stale page request and immediately loads a newly selected page', fakeAsync(() => {
    const first_page_request = new Subject<any>();
    const selected_page_request = new Subject<any>();
    posts_service_mock.getCurrentDownloads.and.returnValues(
      first_page_request.asObservable(),
      selected_page_request.asObservable()
    );

    component.getCurrentDownloadsRecurring();
    expect(first_page_request.observers.length).toBe(1);

    component.pageChangeEvent({pageIndex: 3, pageSize: 20} as any);

    expect(first_page_request.observers.length).toBe(0);
    expect(posts_service_mock.getCurrentDownloads).toHaveBeenCalledTimes(2);
    expect(posts_service_mock.getCurrentDownloads.calls.mostRecent().args).toEqual([null, false, 3, 20]);
    component.ngOnDestroy();
  }));

  it('keeps exact-UID downloads requests unpaginated', () => {
    component.uids = ['download-a', 'download-b'];
    posts_service_mock.getCurrentDownloads.and.returnValue(of({
      downloads: [],
      total_count: 0,
      page: 0,
      page_size: 2
    }));

    component.getCurrentDownloads();

    expect(posts_service_mock.getCurrentDownloads).toHaveBeenCalledOnceWith(component.uids);
  });

  it('navigates lean playlist summaries by container id', () => {
    component.watchContent({
      uid: 'playlist-download',
      type: 'video',
      container: {id: 'playlist-id'}
    } as unknown as Download);

    expect(router_mock.navigate).toHaveBeenCalledOnceWith([
      '/player',
      {playlist_id: 'playlist-id', type: 'video'}
    ]);
  });

  it('retries failed downloads only', () => {
    component.raw_downloads = [
      {uid: 'failed-1', error: 'Network error', finished: true, cancelled: false},
      {uid: 'complete-1', error: null, finished: true, cancelled: false},
      {uid: 'cancelled-1', error: 'Cancelled', error_type: 'cancelled', finished: true, cancelled: true}
    ] as unknown as Download[];

    component.retryFailedDownloads();

    expect(posts_service_mock.restartDownload).toHaveBeenCalledOnceWith('failed-1');
  });

  it('shows a failure message when retrying failed downloads fails', () => {
    component.raw_downloads = [
      {uid: 'failed-1', error: 'Network error', finished: true, cancelled: false}
    ] as unknown as Download[];
    posts_service_mock.restartDownload.and.returnValue(of({success: false}));

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

    expect(pause_action.show(interrupted_download)).toBeFalse();
    expect(resume_action.show(interrupted_download)).toBeTrue();
  });

  it('resumes paused downloads even when their queue step needs retrying', () => {
    const interrupted_download = {
      uid: 'paused-mid-step',
      finished: false,
      paused: true,
      finished_step: false
    } as unknown as Download;

    component.resumeDownload(interrupted_download);

    expect(posts_service_mock.resumeDownload).toHaveBeenCalledOnceWith('paused-mid-step');
    expect(posts_service_mock.pauseDownload).not.toHaveBeenCalled();
  });

  it('persists the downloads page size', () => {
    component.pageChangeEvent({pageSize: 20} as any);

    const restored_component = new DownloadsComponent(posts_service_mock, router_mock, dialog_mock, clipboard_mock);

    expect(localStorage.getItem(component.pageSizeStorageKey)).toBe('20');
    expect(restored_component.pageSize).toBe(20);
  });

  it('merges chunked playlist progress with global sequential indices', () => {
    const chunk_1 = {
      uid: 'chunk-1',
      options: {playlistChunkRange: '1-3'},
      playlist_item_progress: [
        {index: 1, title: 'A', expected_file_size: 1, downloaded_size: 1, percent_complete: 100, status: 'complete', progress_path_index: 0},
        {index: 2, title: 'B', expected_file_size: 1, downloaded_size: 0, percent_complete: 10, status: 'downloading', progress_path_index: 1},
        {index: 3, title: 'C', expected_file_size: 1, downloaded_size: 0, percent_complete: 0, status: 'pending', progress_path_index: 2}
      ]
    };
    const chunk_2 = {
      uid: 'chunk-2',
      options: {playlistChunkRange: '4-6'},
      playlist_item_progress: [
        {index: 1, title: 'D', expected_file_size: 1, downloaded_size: 0, percent_complete: 0, status: 'pending', progress_path_index: 0},
        {index: 2, title: 'E', expected_file_size: 1, downloaded_size: 0, percent_complete: 0, status: 'pending', progress_path_index: 1},
        {index: 3, title: 'F', expected_file_size: 1, downloaded_size: 0, percent_complete: 0, status: 'pending', progress_path_index: 2}
      ]
    };

    const merged = (component as any).mergeBatchPlaylistProgress([chunk_2 as any, chunk_1 as any]);

    expect(Array.isArray(merged)).toBeTrue();
    expect(merged.map(item => item.index)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(merged.map(item => item.title)).toEqual(['A', 'B', 'C', 'D', 'E', 'F']);
  });
});
