import { ComponentFixture, TestBed, waitForAsync } from '@angular/core/testing';
import { HttpErrorResponse } from '@angular/common/http';
import { of, Subject, throwError } from 'rxjs';

import { UpdateProgressDialogComponent } from './update-progress-dialog.component';
import { configureTestBed } from '../../../testing/test-bed';
import { PostsService } from 'app/posts.services';
import { UpdaterStatus } from '../../../api-types';

describe('UpdateProgressDialogComponent', () => {
  let component: UpdateProgressDialogComponent;
  let fixture: ComponentFixture<UpdateProgressDialogComponent>;

  beforeEach(waitForAsync(() => {
    configureTestBed({
      imports: [ UpdateProgressDialogComponent ]
    })
    .compileComponents();
  }));

  beforeEach(() => {
    fixture = TestBed.createComponent(UpdateProgressDialogComponent);
    component = fixture.componentInstance;
    component.updateStatus = { updating: false } as any;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});

describe('UpdateProgressDialogComponent polling', () => {
  let posts: { getUpdaterStatus: ReturnType<typeof vi.fn>; openSnackBar: ReturnType<typeof vi.fn> };
  let component: UpdateProgressDialogComponent;
  const restarting: UpdaterStatus = { updating: true, details: 'Update complete! Restarting server...' };

  beforeEach(() => {
    vi.useFakeTimers();
    posts = { getUpdaterStatus: vi.fn(), openSnackBar: vi.fn() };
    component = new UpdateProgressDialogComponent(posts as unknown as PostsService);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  // It used to read the status before the first answer had set it, and threw every tick.
  it('waits for the first status before asking again', () => {
    const first = new Subject<UpdaterStatus>();
    posts.getUpdaterStatus.mockReturnValue(first);

    component.ngOnInit();
    vi.advanceTimersByTime(1000);
    expect(posts.getUpdaterStatus).toHaveBeenCalledOnce();

    posts.getUpdaterStatus.mockReturnValue(of({ updating: true, details: 'Installing new dependencies...' }));
    first.next({ updating: true, details: 'Backing up key server files...' });
    vi.advanceTimersByTime(250);

    expect(posts.getUpdaterStatus).toHaveBeenCalledTimes(2);
    expect(component.updateStatus.details).toBe('Installing new dependencies...');
  });

  // The server restarts at the end of an update with its status still saying it is updating,
  // so a dialog that kept its timer kept asking four times a second until the page reloaded.
  it('stops asking once it is closed', () => {
    posts.getUpdaterStatus.mockReturnValue(of(restarting));
    component.ngOnInit();
    vi.advanceTimersByTime(250);
    expect(posts.getUpdaterStatus).toHaveBeenCalledTimes(2);

    component.ngOnDestroy();
    vi.advanceTimersByTime(5000);

    expect(posts.getUpdaterStatus).toHaveBeenCalledTimes(2);
  });

  it('keeps showing the last status while the server restarts, and keeps asking', () => {
    posts.getUpdaterStatus.mockReturnValue(of(restarting));
    component.ngOnInit();
    posts.getUpdaterStatus.mockReturnValue(throwError(() => new HttpErrorResponse({ status: 0 })));

    vi.advanceTimersByTime(500);

    expect(posts.getUpdaterStatus).toHaveBeenCalledTimes(3);
    expect(component.updateStatus).toEqual(restarting);
  });
});
