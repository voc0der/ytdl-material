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

  function remoteStream(drift: number, playing = true): void {
    component.uid = 'file-1';
    component.playback_timestamp = 10;
    component.playing = true;
    postsServiceStub.checkConcurrentStream.mockReturnValue(of({stream: {
      playing,
      playback_timestamp: 10 + drift - 2,
      unix_timestamp: Date.now() / 1000 - 2
    }}));
  }

  it('finds a stream without changing playback before the client joins', fakeAsync(() => {
    remoteStream(5);
    const seek = vi.spyOn(component.setPlaybackTimestamp, 'emit');
    const toggle = vi.spyOn(component.togglePlayback, 'emit');
    const rate = vi.spyOn(component.setPlaybackRate, 'emit');
    component.checkStream();
    expect(component.server_already_exists).toBe(true);
    expect(seek).not.toHaveBeenCalled();
    expect(toggle).not.toHaveBeenCalled();
    expect(rate).not.toHaveBeenCalled();
  }));

  it('pauses and seeks to the host position when the host pauses', fakeAsync(() => {
    remoteStream(0, false);
    component.startClient();
    const seek = vi.spyOn(component.setPlaybackTimestamp, 'emit');
    const toggle = vi.spyOn(component.togglePlayback, 'emit');
    component.checkStream();
    expect(toggle).toHaveBeenCalledExactlyOnceWith(false);
    expect(seek).toHaveBeenCalledExactlyOnceWith(8);
  }));

  it('resumes with the host without seeking when already synchronized', fakeAsync(() => {
    remoteStream(0);
    component.playing = false;
    component.startClient();
    const seek = vi.spyOn(component.setPlaybackTimestamp, 'emit');
    const toggle = vi.spyOn(component.togglePlayback, 'emit');
    const rate = vi.spyOn(component.setPlaybackRate, 'emit');
    component.checkStream();
    expect(toggle).toHaveBeenCalledExactlyOnceWith(true);
    expect(seek).not.toHaveBeenCalled();
    expect(rate).not.toHaveBeenCalled();
  }));

  for (const drift of [-3, 3]) {
    it(`seeks for a ${drift}s drift, accounting for the age of the host update`, fakeAsync(() => {
      remoteStream(drift);
      component.startClient();
      const seek = vi.spyOn(component.setPlaybackTimestamp, 'emit');
      const rate = vi.spyOn(component.setPlaybackRate, 'emit');
      component.checkStream();
      expect(seek).toHaveBeenCalledExactlyOnceWith(10 + drift + 0.3);
      expect(rate).not.toHaveBeenCalled();
    }));
  }

  for (const [drift, rate] of [[-1, 0.9], [1, 1.1]]) {
    it(`temporarily uses playback speed ${rate} for a ${drift}s drift`, fakeAsync(() => {
      remoteStream(drift);
      component.startClient();
      const speed = vi.spyOn(component.setPlaybackRate, 'emit');
      const seek = vi.spyOn(component.setPlaybackTimestamp, 'emit');
      component.checkStream();
      expect(speed).toHaveBeenCalledExactlyOnceWith(rate);
      expect(component.playback_rate_modified).toBe(true);
      expect(seek).not.toHaveBeenCalled();

      component.checkStream();
      expect(speed).toHaveBeenCalledTimes(1);
      tick(13000);
      expect(speed.mock.calls).toEqual([[rate], [1]]);
      expect(component.playback_rate_modified).toBe(false);
    }));
  }

  it('stops polling and publishing when the component is destroyed', fakeAsync(() => {
    component.uid = 'file-1';
    component.playback_timestamp = 10;
    component.playing = true;
    component.startWatching();
    component.startServer();
    tick(1000);
    expect(postsServiceStub.updateConcurrentStream)
      .toHaveBeenCalledExactlyOnceWith('file-1', 10, Date.now() / 1000, true);
    expect(postsServiceStub.checkConcurrentStream).toHaveBeenCalledTimes(1);
    fixture.destroy();
    tick(3000);
    expect(postsServiceStub.updateConcurrentStream).toHaveBeenCalledTimes(1);
    expect(postsServiceStub.checkConcurrentStream).toHaveBeenCalledTimes(1);
  }));

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
