import { ComponentFixture, TestBed, waitForAsync } from '@angular/core/testing';
import { MAT_DIALOG_DATA } from '@angular/material/dialog';

import { ShareMediaDialogComponent } from './share-media-dialog.component';
import { PostsService } from '../../posts.services';
import { configureTestBed } from '../../../testing/test-bed';

describe('ShareMediaDialogComponent', () => {
  let component: ShareMediaDialogComponent;
  let fixture: ComponentFixture<ShareMediaDialogComponent>;

  beforeEach(waitForAsync(() => {
    configureTestBed({
      imports: [ ShareMediaDialogComponent ]
    })
    .compileComponents();
  }));

  function open(data: Record<string, unknown>): void {
    TestBed.overrideProvider(MAT_DIALOG_DATA, {useValue: {sharing_enabled: true, current_timestamp: 83600, ...data}});
    TestBed.inject(PostsService).path = 'https://media.example.com/api/';
    fixture = TestBed.createComponent(ShareMediaDialogComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  }

  it('should create', () => {
    open({uid: 'f1'});
    expect(component).toBeTruthy();
  });

  it('should give the short link, opening at the time asked for', () => {
    open({uid: 'f1', share_id: 'AbCdEf12345'});
    expect(component.share_url).toBe('https://media.example.com/s/AbCdEf12345');
    // Where the video was, in whole seconds.
    expect(component.current_timestamp).toBe(83);

    component.timestamp_enabled = true;
    component.useTimestampChanged();
    expect(component.share_url).toBe('https://media.example.com/s/AbCdEf12345?t=83');

    component.timestamp_enabled = false;
    component.useTimestampChanged();
    expect(component.share_url).toBe('https://media.example.com/s/AbCdEf12345');
  });

  it('should fall back to the player link for an automatic playlist, which has no short one', () => {
    open({uid: 'category-1', is_playlist: true});
    expect(component.share_url).toMatch(/;playlist_id=category-1$/);
  });
});
