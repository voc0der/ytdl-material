import { ComponentFixture, TestBed, waitForAsync } from '@angular/core/testing';

import { LogsViewerComponent } from './logs-viewer.component';
import { configureTestBed } from '../../../testing/test-bed';

describe('LogsViewerComponent', () => {
  let component: LogsViewerComponent;
  let fixture: ComponentFixture<LogsViewerComponent>;

  beforeEach(waitForAsync(() => {
    configureTestBed({
      declarations: [ LogsViewerComponent ]
    })
    .compileComponents();
  }));

  beforeEach(() => {
    fixture = TestBed.createComponent(LogsViewerComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
