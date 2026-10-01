import { ComponentFixture, TestBed, waitForAsync } from '@angular/core/testing';
import { ElementRef } from '@angular/core';
import { of, Subject, throwError } from 'rxjs';

import { TwitchChatComponent } from './twitch-chat.component';
import { PostsService } from '../../posts.services';
import { configureTestBed } from '../../../testing/test-bed';

function message(timestamp: number, text = `Message at ${timestamp}`) {
  return { timestamp, timestamp_str: `${timestamp}s`, name: 'Viewer', user_color: '#123456', message: text };
}

describe('TwitchChatComponent', () => {
  let component: TwitchChatComponent;
  let fixture: ComponentFixture<TwitchChatComponent>;

  beforeEach(waitForAsync(() => {
    configureTestBed({
      imports: [ TwitchChatComponent ]
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

  it('renders messages when playback reaches their timestamp', () => {
    component.initializeChatCheck([message(0), message(2)]);
    fixture.detectChanges();

    component.addNewChatMessages();
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('0s - Viewer: Message at 0');
    expect(fixture.nativeElement.textContent).not.toContain('Message at 2');
  });
});

describe('TwitchChatComponent replay and downloads', () => {
  let component: TwitchChatComponent;
  let posts: {
    getFullTwitchChat: ReturnType<typeof vi.fn>;
    downloadTwitchChat: ReturnType<typeof vi.fn>;
    openSnackBar: ReturnType<typeof vi.fn>;
  };
  let scrollBox: { scrollTop: number; offsetHeight: number; scrollHeight: number };

  beforeEach(() => {
    vi.useFakeTimers();
    posts = {
      getFullTwitchChat: vi.fn().mockReturnValue(of({ chat: null })),
      downloadTwitchChat: vi.fn().mockReturnValue(of({ chat: null })),
      openSnackBar: vi.fn()
    };
    component = new TwitchChatComponent(posts as unknown as PostsService);
    component.db_file = { id: 'file-1', isAudio: false, url: 'https://twitch.tv/videos/123?t=10s' } as any;
    component.current_timestamp = 0;
    scrollBox = { scrollTop: 0, offsetHeight: 200, scrollHeight: 1000 };
    component.scrollRef = new ElementRef(scrollBox);
  });

  afterEach(() => {
    component.ngOnDestroy();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  function pollAt(timestamp: number) {
    component.current_timestamp = timestamp;
    vi.advanceTimersByTime(component.CHAT_CHECK_INTERVAL_MS);
  }

  it.each([false, true])('loads saved chat with the media type and subscription (audio: %s)', isAudio => {
    const response = new Subject<any>();
    posts.getFullTwitchChat.mockReturnValue(response);
    component.db_file.isAudio = isAudio;
    component.sub = { name: 'channel-1' };

    component.ngOnInit();

    expect(posts.getFullTwitchChat).toHaveBeenCalledWith('file-1', isAudio ? 'audio' : 'video', null, component.sub);
    expect(component.chat_response_received).toBe(false);

    response.next({ chat: [message(0)] });
    expect(component.chat_response_received).toBe(true);
    pollAt(0);
    expect(component.visible_chat).toEqual([message(0)]);
  });

  it('offers a download without polling when no saved chat exists', () => {
    component.ngOnInit();

    expect(component.chat_response_received).toBe(true);
    expect(component.full_chat).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('shows the first message at its timestamp and appends later messages only once', () => {
    const chat = [message(5), message(10), message(10, 'Same timestamp'), message(20)];
    component.initializeChatCheck(chat);

    pollAt(0);
    expect(component.visible_chat).toEqual([]);
    pollAt(5);
    expect(component.visible_chat).toEqual(chat.slice(0, 1));
    pollAt(10);
    expect(component.visible_chat).toEqual(chat.slice(0, 3));
    pollAt(10);
    expect(component.visible_chat).toEqual(chat.slice(0, 3));
    pollAt(25);
    expect(component.visible_chat).toEqual(chat);
  });

  it('starts with recent history when playback is already in progress', () => {
    const chat = Array.from({ length: 60 }, (_, i) => message(i));
    component.current_timestamp = 40.5;
    component.initializeChatCheck(chat);

    pollAt(40.5);

    expect(component.visible_chat).toEqual(chat.slice(16, 41));
  });

  it.each([1, 29])('removes future messages after a backward seek to %s seconds', timestamp => {
    const chat = Array.from({ length: 50 }, (_, i) => message(i));
    component.initializeChatCheck(chat);
    pollAt(0);
    pollAt(30);

    pollAt(timestamp);

    expect(component.visible_chat).toEqual(chat.slice(Math.max(0, timestamp - 24), timestamp + 1));
    pollAt(timestamp + 1);
    expect(component.visible_chat.at(-1)).toEqual(chat[timestamp + 1]);
  });

  it('clears chat when seeking before the first message', () => {
    component.initializeChatCheck([message(5), message(10)]);
    pollAt(10);

    pollAt(0);

    expect(component.visible_chat).toEqual([]);
    pollAt(5);
    expect(component.visible_chat).toEqual([message(5)]);
  });

  it('limits a large forward seek to the latest 25 messages, including equal timestamps', () => {
    const chat = [message(0), ...Array.from({ length: 30 }, (_, i) => message(10, `Message ${i}`)), message(20)];
    component.initializeChatCheck(chat);
    pollAt(0);

    pollAt(10);

    expect(component.visible_chat).toEqual(chat.slice(6, 31));
  });

  it('shows the last 25 messages when opened after the end of chat', () => {
    const chat = Array.from({ length: 40 }, (_, i) => message(i));
    component.initializeChatCheck(chat);

    pollAt(100);

    expect(component.visible_chat).toEqual(chat.slice(-25));
  });

  it('handles an empty chat', () => {
    component.initializeChatCheck([]);

    pollAt(100);

    expect(component.visible_chat).toEqual([]);
  });

  it('waits for the chat container to render before polling it', () => {
    component.scrollRef = undefined;
    component.initializeChatCheck([message(0)]);

    expect(() => pollAt(0)).not.toThrow();
    component.scrollRef = new ElementRef(scrollBox);
    pollAt(0);
    expect(component.visible_chat).toEqual([message(0)]);
  });

  it('replaces the polling timer and message position when chat is reloaded', () => {
    const addMessages = vi.spyOn(component, 'addNewChatMessages');
    component.initializeChatCheck([message(0), message(1)]);
    pollAt(1);
    addMessages.mockClear();

    component.initializeChatCheck([message(0, 'Replacement')]);
    pollAt(0);

    expect(addMessages).toHaveBeenCalledTimes(1);
    expect(component.visible_chat).toEqual([message(0, 'Replacement')]);
  });

  it('cancels polling and a pending seek scroll when destroyed', () => {
    const addMessages = vi.spyOn(component, 'addNewChatMessages');
    const scroll = vi.spyOn(component, 'scrollToBottom');
    component.initializeChatCheck(Array.from({ length: 60 }, (_, i) => message(i)));
    pollAt(0);
    pollAt(50);
    addMessages.mockClear();
    scroll.mockClear();

    component.ngOnDestroy();
    vi.advanceTimersByTime(1000);

    expect(addMessages).not.toHaveBeenCalled();
    expect(scroll).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['saved', 'downloaded'])('cancels a pending request for %s chat when destroyed', source => {
    const response = new Subject<any>();
    if (source === 'saved') {
      posts.getFullTwitchChat.mockReturnValue(response);
      component.ngOnInit();
    } else {
      posts.downloadTwitchChat.mockReturnValue(response);
      component.downloadTwitchChat();
    }
    expect(response.observed).toBe(true);

    component.ngOnDestroy();

    expect(response.observed).toBe(false);
    response.next({ chat: [message(0)] });
    expect(vi.getTimerCount()).toBe(0);
    expect(component.full_chat).toBeNull();
  });

  it.each([
    { position: 651, forced: false, expected: 1000 },
    { position: 650, forced: false, expected: 650 },
    { position: 0, forced: true, expected: 1000 }
  ])('scrolls from $position to $expected (forced: $forced)', ({ position, forced, expected }) => {
    component.scrollContainer = scrollBox;
    scrollBox.scrollTop = position;

    component.scrollToBottom(forced);

    expect(scrollBox.scrollTop).toBe(expected);
  });

  it('scrolls to the new position after a large seek has rendered', () => {
    component.initializeChatCheck(Array.from({ length: 60 }, (_, i) => message(i)));
    pollAt(0);
    pollAt(50);
    scrollBox.scrollTop = 0;

    vi.advanceTimersByTime(100);

    expect(scrollBox.scrollTop).toBe(1000);
  });

  it.each([false, true])('downloads chat using the VOD ID without URL parameters (audio: %s)', isAudio => {
    const response = new Subject<any>();
    posts.downloadTwitchChat.mockReturnValue(response);
    component.db_file.isAudio = isAudio;
    component.sub = { name: 'channel-1' };

    component.downloadTwitchChat();

    expect(component.downloading_chat).toBe(true);
    expect(posts.downloadTwitchChat).toHaveBeenCalledWith('file-1', isAudio ? 'audio' : 'video', '123', null, component.sub);

    response.next({ chat: [message(0)] });
    expect(component.downloading_chat).toBe(false);
    pollAt(0);
    expect(component.visible_chat).toEqual([message(0)]);
  });

  it.each(['https://twitch.tv/channel-1', 'https://twitch.tv/videos/'])('rejects an unsupported VOD URL: %s', url => {
    component.db_file.url = url;

    expect(() => component.downloadTwitchChat()).not.toThrow();

    expect(posts.downloadTwitchChat).not.toHaveBeenCalled();
    expect(component.downloading_chat).toBe(false);
    expect(posts.openSnackBar).toHaveBeenCalledWith(expect.stringContaining('VOD url for this video is not supported'));
  });

  it('allows retrying a download that returns no chat', () => {
    component.downloadTwitchChat();

    expect(component.downloading_chat).toBe(false);
    expect(posts.openSnackBar).toHaveBeenCalledWith('Download failed.');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('allows retrying a download after a request error', () => {
    posts.downloadTwitchChat.mockReturnValue(throwError(() => new Error('offline')));

    component.downloadTwitchChat();

    expect(component.downloading_chat).toBe(false);
    expect(posts.openSnackBar).toHaveBeenCalledWith('Chat could not be downloaded.');
    expect(vi.getTimerCount()).toBe(0);
  });
});
