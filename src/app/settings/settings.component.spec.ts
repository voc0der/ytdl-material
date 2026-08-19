import { ComponentFixture, TestBed, waitForAsync } from '@angular/core/testing';
import { EventEmitter } from '@angular/core';
import { of, throwError } from 'rxjs';

import { SettingsComponent } from './settings.component';
import { configureTestBed } from '../../testing/test-bed';

describe('SettingsComponent', () => {
  let component: SettingsComponent;
  let fixture: ComponentFixture<SettingsComponent>;

  beforeEach(waitForAsync(() => {
    configureTestBed({
      declarations: [SettingsComponent]
    })
      .compileComponents();
  }));

  beforeEach(() => {
    fixture = TestBed.createComponent(SettingsComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});

describe('SettingsComponent.deleteOrphanFiles', () => {
  let component: SettingsComponent;
  let posts_service_mock: any;
  let dialog_mock: any;
  let done_emitter: EventEmitter<boolean>;

  beforeEach(() => {
    done_emitter = new EventEmitter<boolean>();

    posts_service_mock = {
      initialized: false,
      service_initialized: of(false),
      config: null,
      openSnackBar: vi.fn().mockName('openSnackBar'),
      deleteOrphanFiles: vi.fn().mockName('deleteOrphanFiles').mockReturnValue(of({ deleted_count: 3, failed_count: 0 }))
    };

    dialog_mock = {
      open: vi.fn().mockName('open').mockReturnValue({
        close: vi.fn().mockName('close')
      })
    };

    const snack_bar_mock: any = { open: () => { } };
    const sanitizer_mock: any = {};
    const router_mock: any = { navigate: () => { } };
    const route_mock: any = { snapshot: { paramMap: { get: () => null } } };

    component = new SettingsComponent(posts_service_mock, snack_bar_mock, sanitizer_mock, dialog_mock, router_mock, route_mock);
  });

  it('opens a confirm dialog', () => {
    component.deleteOrphanFiles();
    expect(dialog_mock.open).toHaveBeenCalled();
  });

  it('calls deleteOrphanFiles on the service when confirmed', () => {
    component.deleteOrphanFiles();
    const dialog_data = vi.mocked(dialog_mock.open).mock.lastCall[1].data;
    dialog_data.doneEmitter.emit(true);
    expect(posts_service_mock.deleteOrphanFiles).toHaveBeenCalled();
  });

  it('does not call the service when the dialog is cancelled', () => {
    component.deleteOrphanFiles();
    const dialog_data = vi.mocked(dialog_mock.open).mock.lastCall[1].data;
    dialog_data.doneEmitter.emit(false);
    expect(posts_service_mock.deleteOrphanFiles).not.toHaveBeenCalled();
  });

  it('shows a snackbar with the deleted count on success', () => {
    posts_service_mock.deleteOrphanFiles.mockReturnValue(of({ deleted_count: 5, failed_count: 0 }));
    component.deleteOrphanFiles();
    const dialog_data = vi.mocked(dialog_mock.open).mock.lastCall[1].data;
    dialog_data.doneEmitter.emit(true);
    expect(posts_service_mock.openSnackBar).toHaveBeenCalled();
    const message: string = vi.mocked(posts_service_mock.openSnackBar).mock.lastCall[0];
    expect(message).toContain('5');
  });

  it('includes the failed count in the snackbar when some deletions failed', () => {
    posts_service_mock.deleteOrphanFiles.mockReturnValue(of({ deleted_count: 2, failed_count: 1 }));
    component.deleteOrphanFiles();
    const dialog_data = vi.mocked(dialog_mock.open).mock.lastCall[1].data;
    dialog_data.doneEmitter.emit(true);
    const message: string = vi.mocked(posts_service_mock.openSnackBar).mock.lastCall[0];
    expect(message).toContain('1');
  });

  it('shows an error snackbar when the API call fails', () => {
    posts_service_mock.deleteOrphanFiles.mockReturnValue(throwError(() => new Error('server error')));
    component.deleteOrphanFiles();
    const dialog_data = vi.mocked(dialog_mock.open).mock.lastCall[1].data;
    dialog_data.doneEmitter.emit(true);
    expect(posts_service_mock.openSnackBar).toHaveBeenCalled();
    const message: string = vi.mocked(posts_service_mock.openSnackBar).mock.lastCall[0];
    expect(message.toLowerCase()).toContain('failed');
  });
});

describe('SettingsComponent downloader + yt-dlp channel selection', () => {
  let component: SettingsComponent;

  const buildComponent = (): SettingsComponent => {
    const posts_service_mock: any = {
      initialized: false,
      service_initialized: of(false),
      config: null,
      openSnackBar: vi.fn().mockName('openSnackBar')
    };
    const snack_bar_mock: any = { open: () => { } };
    const sanitizer_mock: any = {};
    const dialog_mock: any = { open: () => ({ close: () => { } }) };
    const router_mock: any = { navigate: () => { } };
    const route_mock: any = { snapshot: { paramMap: { get: () => null } } };

    return new SettingsComponent(posts_service_mock, snack_bar_mock, sanitizer_mock, dialog_mock, router_mock, route_mock);
  };

  beforeEach(() => {
    component = buildComponent();
    component.new_config = { Advanced: { default_downloader: 'yt-dlp', ytdlp_update_channel: 'stable' } };
    component.initial_config = { Advanced: { default_downloader: 'yt-dlp', ytdlp_update_channel: 'stable' } };
    component.downloaderInfo = {
      'yt-dlp': { downloader: 'yt-dlp', version: '2026.07.04', binary_exists: true, loaded: true }
    };
  });

  it('represents stable yt-dlp as a bare value', () => {
    expect(component.selectedDownloader).toBe('yt-dlp');
  });

  it('encodes the non-stable channels into the selected value', () => {
    for (const channel of ['nightly', 'master']) {
      component.new_config['Advanced']['ytdlp_update_channel'] = channel;
      expect(component.selectedDownloader).toBe(`yt-dlp@${channel}`);
    }
  });

  it('treats a missing or blank channel as stable', () => {
    for (const channel of [undefined, null, '', '   ']) {
      component.new_config['Advanced']['ytdlp_update_channel'] = channel;
      expect(component.selectedDownloader).toBe('yt-dlp');
    }
  });

  it('normalizes case and whitespace so an env value like NIGHTLY displays correctly', () => {
    for (const channel of ['NIGHTLY', '  nightly  ', 'Nightly']) {
      component.new_config['Advanced']['ytdlp_update_channel'] = channel;
      expect(component.selectedDownloader).toBe('yt-dlp@nightly');
    }
  });

  it('matches no option for an unrecognized channel rather than claiming stable', () => {
    // The backend skips updating entirely in this state, so showing 'stable' would be a
    // lie. An unmatched value leaves the select empty until the user picks a real channel.
    component.new_config['Advanced']['ytdlp_update_channel'] = 'nightlyy';
    expect(component.selectedDownloader).toBe('yt-dlp@nightlyy');
    expect(component.selectedDownloader).not.toBe('yt-dlp');
  });

  it('annotates no channel with a version when the installed channel is unrecognized', () => {
    component.initial_config['Advanced']['ytdlp_update_channel'] = 'nightlyy';
    for (const channel of ['stable', 'nightly', 'master']) {
      expect(component.getDownloaderLabel('yt-dlp', channel)).toBe(`yt-dlp ${channel}`);
    }
  });

  it('writes both the fork and the channel when a channel option is picked', () => {
    component.selectedDownloader = 'yt-dlp@nightly';
    expect(component.new_config['Advanced']['default_downloader']).toBe('yt-dlp');
    expect(component.new_config['Advanced']['ytdlp_update_channel']).toBe('nightly');
  });

  it('resets to stable when the bare yt-dlp option is picked', () => {
    component.new_config['Advanced']['ytdlp_update_channel'] = 'nightly';
    component.selectedDownloader = 'yt-dlp';
    expect(component.new_config['Advanced']['ytdlp_update_channel']).toBe('stable');
  });

  it('leaves the stored channel alone for the other forks', () => {
    component.new_config['Advanced']['ytdlp_update_channel'] = 'nightly';
    component.selectedDownloader = 'youtube-dl';
    expect(component.new_config['Advanced']['default_downloader']).toBe('youtube-dl');
    expect(component.new_config['Advanced']['ytdlp_update_channel']).toBe('nightly');
    expect(component.selectedDownloader).toBe('youtube-dl');
  });

  it('annotates only the installed channel with the version', () => {
    expect(component.getDownloaderLabel('yt-dlp', 'stable')).toBe('yt-dlp stable (2026.07.04)');
    expect(component.getDownloaderLabel('yt-dlp', 'nightly')).toBe('yt-dlp nightly');
    expect(component.getDownloaderLabel('yt-dlp', 'master')).toBe('yt-dlp master');
  });

  it('follows the saved config, not an unsaved selection, when annotating', () => {
    component.initial_config['Advanced']['ytdlp_update_channel'] = 'nightly';
    component.new_config['Advanced']['ytdlp_update_channel'] = 'stable';
    expect(component.getDownloaderLabel('yt-dlp', 'nightly')).toBe('yt-dlp nightly (2026.07.04)');
    expect(component.getDownloaderLabel('yt-dlp', 'stable')).toBe('yt-dlp stable');
  });

  it('keeps the unchannelled label format for the other forks', () => {
    component.downloaderInfo['youtube-dl'] = {
      downloader: 'youtube-dl', version: '2021.12.17', binary_exists: true, loaded: true
    };
    expect(component.getDownloaderLabel('youtube-dl')).toBe('youtube-dl (2021.12.17)');
    expect(component.getDownloaderLabel('youtube-dlc')).toBe('youtube-dlc');
  });
});
