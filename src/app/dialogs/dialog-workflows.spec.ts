import { EventEmitter } from '@angular/core';
import { MatDialogRef } from '@angular/material/dialog';
import { of, Subject, throwError } from 'rxjs';
import { InputDialogComponent } from '../input-dialog/input-dialog.component';
import { EditCategoryDialogComponent } from './edit-category-dialog/edit-category-dialog.component';
import { ShareMediaDialogComponent } from './share-media-dialog/share-media-dialog.component';
import { WebhookTemplateDialogComponent } from './webhook-template-dialog/webhook-template-dialog.component';
import { PlaylistDownloadProgressDialogComponent } from './playlist-download-progress-dialog/playlist-download-progress-dialog.component';

describe('Dialog workflows', () => {
  afterEach(() => vi.restoreAllMocks());

  it('submits input once it is nonempty, or delegates completion to the caller', () => {
    const close = vi.fn();
    const data = { inputTitle: 'Name', inputPlaceholder: 'New name', submitText: 'Save' };
    const component = new InputDialogComponent({ close } as unknown as MatDialogRef<InputDialogComponent>, data);
    component.ngOnInit();
    component.enterPressed();
    expect(close).not.toHaveBeenCalled();
    component.inputText = 'Mix';
    component.enterPressed();
    expect(close).toHaveBeenCalledWith('Mix');
    const doneEmitter = new EventEmitter<string>();
    const submitted = vi.fn();
    doneEmitter.subscribe(submitted);
    component.data = { ...data, doneEmitter };
    component.ngOnInit();
    component.inputText = 'New mix';
    component.enterPressed();
    expect(submitted).toHaveBeenCalledWith('New mix');
    expect(component.inputSubmitted).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('copies category rules, reorders and removes them, and saves without mutating the dialog input', () => {
    const category = { name: 'Science', rules: [{ property: 'uploader', value: 'Alice' }] };
    const saved = new Subject<any>();
    const posts: any = { updateCategory: vi.fn().mockReturnValue(saved), reloadCategories: vi.fn() };
    const component = new EditCategoryDialogComponent({ category }, posts);
    expect(component.categoryChanged()).toBe(true);
    component.addNewRule();
    expect(component.categoryChanged()).toBe(false);
    expect(category.rules).toHaveLength(1);
    component.swapRules(0, 1);
    expect(component.category.rules[1].value).toBe('Alice');
    component.removeRule(1);
    component.saveClicked();
    expect(component.updating).toBe(true);
    saved.next({ success: true });
    expect(component.updating).toBe(false);
    expect(component.categoryChanged()).toBe(true);
    expect(posts.reloadCategories).toHaveBeenCalledOnce();
    component.category.name = 'Changed';
    posts.updateCategory.mockReturnValue(throwError(() => new Error('offline')));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    component.saveClicked();
    expect(component.updating).toBe(false);
    expect(component.original_category.name).toBe('Science');
  });

  for (const enabled of [true, false]) {
    it(`updates sharing to ${enabled} only after a successful server response`, () => {
      const posts: any = { path: '/api/', enableSharing: vi.fn(), disableSharing: vi.fn(), openSnackBar: vi.fn() };
      const service = enabled ? posts.enableSharing : posts.disableSharing;
      const snack: any = { open: vi.fn() };
      const component = new ShareMediaDialogComponent({ uid: 'clip', uuid: 'alice', sharing_enabled: !enabled, current_timestamp: 1000 }, null, snack, posts);
      component.ngOnInit();
      service.mockReturnValue(of({ success: false }));
      component.sharingChanged({ checked: enabled });
      expect(component.sharing_enabled).toBe(!enabled);
      service.mockReturnValue(throwError(() => new Error('offline')));
      component.sharingChanged({ checked: enabled });
      expect(component.sharing_enabled).toBe(!enabled);
      service.mockReturnValue(of({ success: true }));
      component.sharingChanged({ checked: enabled });
      expect(component.sharing_enabled).toBe(enabled);
      expect(service).toHaveBeenCalledWith('clip', undefined);
      component.timestamp_enabled = true;
      component.timestampInputChanged({ target: { value: 5 } });
      expect(component.share_url).toMatch(/;uuid=alice;timestamp=5$/);
      component.timestampInputChanged({ target: { value: -1 } });
      expect(component.share_url).toBe(component.default_share_url);
      component.copiedToClipboard();
      expect(posts.openSnackBar).toHaveBeenLastCalledWith('Copied to clipboard!');
      component.openSnackBar('Message');
      expect(snack.open).toHaveBeenCalledWith('Message', '', { duration: 2000 });
    });
  }

  it('initializes webhook defaults, preserves edited templates and normalizes invalid values on save', () => {
    const close = vi.fn();
    const ref = { close } as unknown as MatDialogRef<WebhookTemplateDialogComponent>;
    const component = new WebhookTemplateDialogComponent(null, ref);
    expect(component.titleTemplate).toBe('{{event_name}}');
    expect(component.bodyTemplate).toBe('{{event_body}}');
    component.customEnabled = true;
    component.titleTemplate = 'Downloaded {{video_name}}';
    component.save();
    expect(close).toHaveBeenCalledWith({ customEnabled: true, titleTemplate: 'Downloaded {{video_name}}', bodyTemplate: '{{event_body}}' });
    const invalid = new WebhookTemplateDialogComponent({ customEnabled: false, titleTemplate: null, bodyTemplate: null }, ref);
    expect(invalid.titleTemplate).toBe('{{event_name}}');
    invalid.titleTemplate = null;
    invalid.bodyTemplate = null;
    invalid.save();
    expect(close).toHaveBeenLastCalledWith({ customEnabled: false, titleTemplate: '', bodyTemplate: '' });
  });

  it('sorts progress without changing the response, clamps percentages and labels each state', () => {
    const items = [{ index: 2, percent_complete: 120 }, { index: Number.NaN, percent_complete: -2 }, { index: 1, percent_complete: Number.NaN }];
    const component = new PlaylistDownloadProgressDialogComponent({ download: { percent_complete: 120, playlist_item_progress: items } } as any);
    component.ngOnInit();
    expect(component.playlist_item_progress.map(item => item.index)).toEqual([Number.NaN, 1, 2]);
    expect(items[0].index).toBe(2);
    expect(component.overall_percent).toBe('100.00');
    expect(items.map(item => component.getItemPercent(item as any))).toEqual([100, 0, 0]);
    for (const [status, label] of [['complete', 'Complete'], ['duplicate', 'Duplicate'], ['downloading', 'Downloading'], ['failed', 'Failed'], ['unknown', 'Pending']]) {
      expect(component.getItemStatusLabel({ status } as any)).toBe(label);
    }
    component.updateDownload({ finished: true, percent_complete: 0 } as any);
    expect(component.overall_percent).toBe('100.00');
    component.updateDownload({ percent_complete: Number.NaN } as any);
    expect(component.overall_percent).toBe('0.00');
    component.updateDownload(null);
    expect(component.playlist_item_progress).toEqual([]);
  });
});
