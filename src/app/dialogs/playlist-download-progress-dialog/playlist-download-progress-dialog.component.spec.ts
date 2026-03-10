import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MAT_DIALOG_DATA } from '@angular/material/dialog';
import { MatDialogModule } from '@angular/material/dialog';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatTooltipModule } from '@angular/material/tooltip';

import { PlaylistDownloadProgressDialogComponent } from './playlist-download-progress-dialog.component';

describe('PlaylistDownloadProgressDialogComponent', () => {
  let component: PlaylistDownloadProgressDialogComponent;
  let fixture: ComponentFixture<PlaylistDownloadProgressDialogComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      declarations: [PlaylistDownloadProgressDialogComponent],
      imports: [MatDialogModule, MatProgressBarModule, MatTooltipModule],
      providers: [
        {
          provide: MAT_DIALOG_DATA,
          useValue: {
            download: {
              uid: 'test',
              running: false,
              finished: false,
              paused: false,
              finished_step: false,
              url: 'https://example.com',
              type: 'video',
              title: 'test playlist',
              step_index: 2,
              percent_complete: 33.33,
              timestamp_start: Date.now(),
              playlist_item_progress: []
            }
          }
        }
      ]
    })
    .compileComponents();

    fixture = TestBed.createComponent(PlaylistDownloadProgressDialogComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
