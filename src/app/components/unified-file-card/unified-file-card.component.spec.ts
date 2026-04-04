import { NO_ERRORS_SCHEMA } from '@angular/core';
import { ComponentFixture, TestBed, waitForAsync } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { MatDialog } from '@angular/material/dialog';

import { UnifiedFileCardComponent } from './unified-file-card.component';

describe('UnifiedFileCardComponent', () => {
  let component: UnifiedFileCardComponent;
  let fixture: ComponentFixture<UnifiedFileCardComponent>;

  beforeEach(waitForAsync(() => {
    TestBed.configureTestingModule({
      declarations: [ UnifiedFileCardComponent ],
      providers: [
        { provide: MatDialog, useValue: {} }
      ],
      schemas: [NO_ERRORS_SCHEMA]
    })
    .compileComponents();
  }));

  beforeEach(() => {
    fixture = TestBed.createComponent(UnifiedFileCardComponent);
    component = fixture.componentInstance;
    component.theme = {
      ghost_primary: '#000000',
      ghost_secondary: '#111111'
    } as any;
  });

  function loadPlayableCard(): void {
    component.loading = false;
    component.locale = { ngID: 'en-GB' } as any;
    component.file_obj = {
      uid: 'example-uid',
      duration: 90,
      type: 'video',
      isAudio: false,
      title: 'Example title',
      registered: Date.now(),
      thumbnailURL: 'https://example.com/thumb.jpg'
    } as any;
    fixture.detectChanges();
  }

  it('should create', () => {
    fixture.detectChanges();
    expect(component).toBeTruthy();
  });

  it('should build preview stream URLs without a trailing slash before the query string', () => {
    component.baseStreamPath = '/api/';
    component.apiKeyString = 'public-token';
    component.file_obj = {
      uid: 'uid with spaces',
      isAudio: false
    } as any;

    expect(component.generateStreamURL()).toBe('/api/stream?uid=uid%20with%20spaces&type=video&apiKey=public-token&t=,10');
  });

  it('should emit goToFile when the metadata strip is clicked', () => {
    loadPlayableCard();
    spyOn(component.goToFile, 'emit');

    const metadataStrip = fixture.debugElement.query(By.css('.download-time'));
    metadataStrip.nativeElement.click();

    expect(component.goToFile.emit).toHaveBeenCalledWith(jasmine.objectContaining({
      file: component.file_obj
    }));
  });

  it('should not emit goToFile when the menu button is clicked', () => {
    loadPlayableCard();
    spyOn(component.goToFile, 'emit');

    const menuButton = fixture.debugElement.query(By.css('.menuButton'));
    menuButton.nativeElement.click();

    expect(component.goToFile.emit).not.toHaveBeenCalled();
  });

  it('should mark thumbnail previews as non-draggable', () => {
    loadPlayableCard();

    const thumbnail = fixture.debugElement.query(By.css('img'));

    expect(thumbnail.nativeElement.getAttribute('draggable')).toBe('false');
  });
});
