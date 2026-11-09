import { ComponentFixture, TestBed, waitForAsync } from '@angular/core/testing';
import { of, Subject, throwError } from 'rxjs';

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

describe('LogsViewerComponent requests and clearing', () => {
  let component: LogsViewerComponent;
  let posts: any;
  let dialog: any;

  beforeEach(() => {
    vi.useFakeTimers();
    posts = {
      getLogs: vi.fn().mockReturnValue(of({logs: 'INFO Ready'})),
      clearAllLogs: vi.fn().mockReturnValue(of({success: true})),
      openSnackBar: vi.fn()
    };
    dialog = {open: vi.fn().mockReturnValue({afterClosed: () => of(true)})};
    component = new LogsViewerComponent(posts, dialog);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('shows a spinner for the first request and keeps existing logs visible during refresh', () => {
    const response = new Subject<{logs: string}>();
    posts.getLogs.mockReturnValue(response);
    component.ngOnInit();
    expect(component.logs_loading).toBe(true);
    expect(posts.getLogs).toHaveBeenCalledWith(50);

    response.next({logs: 'INFO Ready\nWARN Retry\nERROR Failed\nVERBOSE Details'});
    response.complete();
    expect(component.logs_loading).toBe(false);
    expect(component.logs).toEqual([
      {text: 'INFO Ready', level: 'info'}, {text: 'WARN Retry', level: 'warn'},
      {text: 'ERROR Failed', level: 'error'}, {text: 'VERBOSE Details', level: 'verbose'}
    ]);

    const refresh = new Subject<{logs: string}>();
    posts.getLogs.mockReturnValue(refresh);
    component.linesChanged(0);
    expect(posts.getLogs).toHaveBeenLastCalledWith(null);
    expect(component.logs_loading).toBe(false);
    expect(component.logs).toHaveLength(4);
    refresh.next({logs: 'INFO Refreshed'});
    refresh.complete();
    expect(component.logs_text).toBe('INFO Refreshed');

    component.linesChanged(10);
    expect(posts.getLogs).toHaveBeenLastCalledWith(10);
  });

  it.each([null, undefined, 42, {}])('reports an invalid log payload (%s) and preserves the last readable logs', logs => {
    component.getLogs();
    posts.getLogs.mockReturnValue(of({logs}));

    component.getLogs();
    vi.runAllTimers();

    expect(component.logs_loading).toBe(false);
    expect(component.logs_text).toBe('INFO Ready');
    expect(component.logs).toEqual([{text: 'INFO Ready', level: 'info'}]);
    expect(posts.openSnackBar).toHaveBeenCalledWith('Failed to retrieve logs!');
  });

  it('accepts an empty log without reporting a request failure', () => {
    posts.getLogs.mockReturnValue(of({logs: ''}));
    component.getLogs();
    expect(component.logs_loading).toBe(false);
    expect(component.logs_text).toBe('');
    expect(posts.openSnackBar).not.toHaveBeenCalled();
  });

  it('clears the loading state and reports a failed request', () => {
    const error = new Error('Offline');
    const response = new Subject<{logs: string}>();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    posts.getLogs.mockReturnValue(response);
    component.getLogs();
    expect(component.logs_loading).toBe(true);
    response.error(error);
    expect(component.logs_loading).toBe(false);
    expect(posts.openSnackBar).toHaveBeenCalledWith('Failed to retrieve logs!');
  });

  it.each([false, undefined])('keeps logs when clearing is not confirmed (%s)', confirmed => {
    dialog.open.mockReturnValue({afterClosed: () => of(confirmed)});
    component.clearLogs();
    expect(posts.clearAllLogs).not.toHaveBeenCalled();
    expect(posts.getLogs).not.toHaveBeenCalled();
  });

  it('clears old text and reloads logs only after the server confirms deletion', () => {
    const deletion = new Subject<{success: boolean}>();
    const refresh = new Subject<{logs: string}>();
    component.getLogs();
    posts.clearAllLogs.mockReturnValue(deletion);
    posts.getLogs.mockReturnValue(refresh);

    component.clearLogs();
    expect(component.logs_text).toBe('INFO Ready');
    expect(posts.getLogs).toHaveBeenCalledTimes(1);
    deletion.next({success: true});
    deletion.complete();
    expect(component.logs).toEqual([]);
    expect(component.logs_text).toBe('');
    expect(posts.getLogs).toHaveBeenCalledTimes(2);
    expect(posts.openSnackBar).toHaveBeenCalledWith('Logs successfully cleared!');
    refresh.next({logs: 'INFO After clearing'});
    refresh.complete();
    expect(component.logs_text).toBe('INFO After clearing');
  });

  it.each(['refused', 'offline'])('keeps logs and reports a %s clear request', failure => {
    component.getLogs();
    posts.clearAllLogs.mockReturnValue(failure === 'refused'
      ? of({success: false}) : throwError(() => new Error('Offline')));
    component.clearLogs();
    expect(component.logs_text).toBe('INFO Ready');
    expect(posts.getLogs).toHaveBeenCalledTimes(1);
    expect(posts.openSnackBar).toHaveBeenCalledWith('Failed to clear logs!');
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
