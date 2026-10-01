import { Component, ElementRef, Input, OnDestroy, OnInit, QueryList, ViewChild, ViewChildren, ChangeDetectionStrategy } from '@angular/core';
import { DatabaseFile } from 'api-types';
import { PostsService } from 'app/posts.services';
import { MatButton } from '@angular/material/button';
import { MatProgressSpinner } from '@angular/material/progress-spinner';
import { Subscription } from 'rxjs';

@Component({
    selector: 'app-twitch-chat',
    templateUrl: './twitch-chat.component.html',
    styleUrls: ['./twitch-chat.component.scss'],
    changeDetection: ChangeDetectionStrategy.Eager,
    imports: [MatButton, MatProgressSpinner]
})
export class TwitchChatComponent implements OnInit, OnDestroy {

  full_chat = null;
  visible_chat = null;
  chat_response_received = false;
  downloading_chat = false;

  current_chat_index = null;

  CHAT_CHECK_INTERVAL_MS = 200;
  chat_check_interval_obj = null;
  private chat_scroll_timeout_obj = null;
  private chat_requests = new Subscription();

  scrollContainer = null;

  @Input() db_file: DatabaseFile = null;
  @Input() sub = null;
  @Input() current_timestamp = null;

  @ViewChild('scrollContainer') scrollRef: ElementRef;
  @ViewChildren('chat') chat: QueryList<any>;

  constructor(private postsService: PostsService) { }

  ngOnInit(): void {
    this.getFullChat();
  }

  ngOnDestroy(): void {
    this.chat_requests.unsubscribe();
    this.stopChatCheck();
  }

  private stopChatCheck(): void {
    clearInterval(this.chat_check_interval_obj);
    clearTimeout(this.chat_scroll_timeout_obj);
  }

  private isUserNearBottom(): boolean {
    const threshold = 150;
    const position = this.scrollContainer.scrollTop + this.scrollContainer.offsetHeight;
    const height = this.scrollContainer.scrollHeight;
    return position > height - threshold;
  }

  scrollToBottom = (force_scroll = false) => {
    if (force_scroll || this.isUserNearBottom()) {
      this.scrollContainer.scrollTop = this.scrollContainer.scrollHeight;
    }
  }

  addNewChatMessages() {
    if (!this.scrollContainer) {
      this.scrollContainer = this.scrollRef?.nativeElement;
    }
    if (!this.scrollContainer) { return; }

    const next_chat_index = this.getIndexOfNextChat();
    const first_unseen_index = this.current_chat_index === null ? 0 : this.current_chat_index + 1;
    if (this.current_chat_index === null || next_chat_index < first_unseen_index || next_chat_index - first_unseen_index > 25) {
      this.visible_chat = [];
      this.current_chat_index = Math.max(0, next_chat_index - 25) - 1;
      clearTimeout(this.chat_scroll_timeout_obj);
      this.chat_scroll_timeout_obj = setTimeout(() => this.scrollToBottom(true), 100);
    }

    for (let i = this.current_chat_index + 1; i < next_chat_index; i++) {
      this.visible_chat.push(this.full_chat[i]);
    }
    this.current_chat_index = next_chat_index - 1;
  }

  getIndexOfNextChat() {
    const index = binarySearch(this.full_chat, 'timestamp', this.current_timestamp);
    return index;
  }

  getFullChat() {
    this.chat_requests.add(this.postsService.getFullTwitchChat(this.db_file.id, this.db_file.isAudio ? 'audio' : 'video', null, this.sub).subscribe(res => {
      this.chat_response_received = true;
      if (res['chat']) {
        this.initializeChatCheck(res['chat']);
      }
    }));
  }

  downloadTwitchChat() {
    const vodId = this.db_file.url?.split('videos/')[1]?.split(/[?#]/)[0];
    if (!vodId) {
      this.postsService.openSnackBar($localize`VOD url for this video is not supported. VOD ID must be after "twitch.tv/videos/"`);
      return;
    }
    this.downloading_chat = true;
    this.chat_requests.add(this.postsService.downloadTwitchChat(this.db_file.id, this.db_file.isAudio ? 'audio' : 'video', vodId, null, this.sub).subscribe(res => {
      this.downloading_chat = false;
      if (res['chat']) {
        this.initializeChatCheck(res['chat']);
      } else {
        this.postsService.openSnackBar($localize`Download failed.`)
      }
    }, err => {
      this.downloading_chat = false;
      this.postsService.openSnackBar($localize`Chat could not be downloaded.`)
    }));
  }

  initializeChatCheck(full_chat) {
    this.stopChatCheck();
    this.full_chat = full_chat;
    this.visible_chat = [];
    this.current_chat_index = null;
    this.chat_check_interval_obj = setInterval(() => this.addNewChatMessages(), this.CHAT_CHECK_INTERVAL_MS);
  }

}

function binarySearch(arr, key, n) {
  let min = 0;
  let max = arr.length;
  // Find the first message strictly after playback, including every equal timestamp.
  while (min < max) {
    const mid = Math.floor((min + max) / 2);
    if (arr[mid][key] <= n) {
      min = mid + 1;
    } else {
      max = mid;
    }
  }

  return min;
}
