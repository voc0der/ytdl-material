import { DownloadsComponent } from './downloads.component';
import { Download } from 'api-types';
import { of } from 'rxjs';

describe('DownloadsComponent', () => {
  let component: DownloadsComponent;

  beforeEach(() => {
    const posts_service_mock: any = {
      config: { Extra: { enable_downloads_manager: true } },
      initialized: true,
      service_initialized: of(true),
      getCurrentDownloads: () => of({downloads: []}),
      openSnackBar: () => {}
    };
    const router_mock: any = { navigate: () => {} };
    const dialog_mock: any = { open: () => ({}), openDialogs: [] };
    const clipboard_mock: any = { copy: () => true };

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
