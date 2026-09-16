import { ComponentFixture, TestBed, fakeAsync, tick } from '@angular/core/testing';
import { OverlayContainer } from '@angular/cdk/overlay';
import { of } from 'rxjs';
import { PostsService } from '../../posts.services';

import { ConcurrentStreamComponent } from './concurrent-stream.component';
import { configureTestBed } from '../../../testing/test-bed';

describe('ConcurrentStreamComponent', () => {
  let component: ConcurrentStreamComponent;
  let fixture: ComponentFixture<ConcurrentStreamComponent>;
  let postsServiceStub: any;

  beforeEach(async () => {
    postsServiceStub = {
      checkConcurrentStream: vi.fn().mockReturnValue(of({stream: null})),
      updateConcurrentStream: vi.fn().mockReturnValue(of({success: true}))
    };
    await configureTestBed({
      imports: [ ConcurrentStreamComponent ],
      providers: [{provide: PostsService, useValue: postsServiceStub}]
    })
    .compileComponents();
  });

  beforeEach(() => {
    fixture = TestBed.createComponent(ConcurrentStreamComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  function openMenu(): void {
    fixture.nativeElement.querySelector('button').click();
    fixture.detectChanges();
    tick();
  }

  function menuAction(label: string): HTMLButtonElement | undefined {
    const overlay = TestBed.inject(OverlayContainer).getContainerElement();
    return Array.from(overlay.querySelectorAll('button')).find(button => button.textContent.includes(label));
  }

  it('should host and stop from the icon menu without creating polling timers when reopened', fakeAsync(() => {
    component.server_mode = true;
    component.uid = 'file-1';
    openMenu();

    expect(postsServiceStub.checkConcurrentStream).toHaveBeenCalledWith('file-1');
    menuAction('Start stream').click();
    fixture.detectChanges();
    tick(1000);
    expect(component.server_started).toBe(true);
    expect(postsServiceStub.updateConcurrentStream).toHaveBeenCalledTimes(1);

    const checkTimer = component.check_timeout;
    openMenu();
    expect(component.check_timeout).toBe(checkTimer);
    menuAction('Stop').click();
    fixture.detectChanges();
    tick(2000);

    expect(component.started).toBe(false);
    expect(component.watch_together_clicked).toBe(false);
    expect(postsServiceStub.updateConcurrentStream).toHaveBeenCalledTimes(1);
  }));

  it('should join an existing stream and keep the session when its menu is reopened', fakeAsync(() => {
    postsServiceStub.checkConcurrentStream.mockReturnValue(of({stream: {playing: false, playback_timestamp: 10}}));
    openMenu();
    menuAction('Join stream').click();
    fixture.detectChanges();
    tick();
    expect(component.started).toBe(true);
    expect(component.server_started).toBe(false);

    const checkTimer = component.check_timeout;
    openMenu();
    expect(component.started).toBe(true);
    expect(component.check_timeout).toBe(checkTimer);
    expect(menuAction('Join stream')).toBeUndefined();
    menuAction('Stop').click();
    tick();
    expect(component.watch_together_clicked).toBe(false);
  }));
});
