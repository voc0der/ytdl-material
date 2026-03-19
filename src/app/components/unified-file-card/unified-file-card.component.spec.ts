import { NO_ERRORS_SCHEMA } from '@angular/core';
import { ComponentFixture, TestBed, waitForAsync } from '@angular/core/testing';
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
    fixture.detectChanges();
  });

  it('should create', () => {
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
});
