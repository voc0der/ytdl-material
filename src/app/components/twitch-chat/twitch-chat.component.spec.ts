import { ComponentFixture, TestBed, waitForAsync } from '@angular/core/testing';

import { TwitchChatComponent } from './twitch-chat.component';
import { configureTestBed } from '../../../testing/test-bed';

describe('TwitchChatComponent', () => {
  let component: TwitchChatComponent;
  let fixture: ComponentFixture<TwitchChatComponent>;

  beforeEach(waitForAsync(() => {
    configureTestBed({
      declarations: [ TwitchChatComponent ]
    })
    .compileComponents();
  }));

  beforeEach(() => {
    fixture = TestBed.createComponent(TwitchChatComponent);
    component = fixture.componentInstance;
    component.db_file = {
      id: 'file-1',
      isAudio: false,
      url: 'https://twitch.tv/videos/1'
    } as any;
    component.current_timestamp = 0;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
