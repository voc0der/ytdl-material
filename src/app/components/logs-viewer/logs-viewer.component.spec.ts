import { ComponentFixture, TestBed, waitForAsync } from '@angular/core/testing';
import { of } from 'rxjs';

import { LogsViewerComponent } from './logs-viewer.component';
import { configureTestBed } from '../../../testing/test-bed';

describe('LogsViewerComponent', () => {
  let component: LogsViewerComponent;
  let fixture: ComponentFixture<LogsViewerComponent>;

  beforeEach(waitForAsync(() => {
    configureTestBed({
      imports: [ LogsViewerComponent ]
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

describe('LogsViewerComponent scrolling', () => {
  let component: LogsViewerComponent;
  let box: { scrollTop: number, scrollHeight: number };

  beforeEach(() => {
    const posts_service: any = {
      getLogs: vi.fn().mockName('getLogs').mockReturnValue(of({ logs: 'first line\nsecond line\nthird line' })),
      openSnackBar: vi.fn().mockName('openSnackBar')
    };
    component = new LogsViewerComponent(posts_service, {} as any);
    box = { scrollTop: 0, scrollHeight: 900 };
    component.logsOutput = { nativeElement: box } as any;
  });

  it('puts the newest line in view once the logs arrive', () => {
    vi.useFakeTimers();
    try {
      component.getLogs();
      vi.runAllTimers();
    } finally {
      vi.useRealTimers();
    }

    expect(component.logs.length).toBe(3);
    expect(box.scrollTop).toBe(900);
  });

  it('does nothing when there is no box to scroll', () => {
    component.logsOutput = undefined;
    expect(() => component.scrollToLatest()).not.toThrow();
  });
});
