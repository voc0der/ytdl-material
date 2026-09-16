import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

interface ResultInit {
  id?: string | null;
  title?: string | null;
  thumbnailUrl?: string | null;
  videoUrl?: string | null;
  channelTitle?: string | null;
}

interface YoutubeSearchResponse {
  items: YoutubeSearchItem[];
}

interface YoutubeSearchItem {
  id: {
    videoId: string;
  };
  snippet: {
    title: string;
    thumbnails: {
      high: {
        url: string;
      };
    };
    channelTitle: string;
  };
}

export class Result {
  id: string | null
  title: string | null
  thumbnailUrl: string | null
  videoUrl: string | null
  channelTitle: string | null;

  constructor(obj: ResultInit = {}) {
    this.id = obj.id ?? null
    this.title = obj.title ?? null
    this.thumbnailUrl = obj.thumbnailUrl ?? null
    this.channelTitle = obj.channelTitle ?? null
    this.videoUrl = obj.videoUrl ?? (this.id ? `https://www.youtube.com/watch?v=${this.id}` : null)
  }
}


@Injectable({
  providedIn: 'root'
})
export class YoutubeSearchService {

  readonly url = 'https://www.googleapis.com/youtube/v3/search';
  key: string | null = null;

  constructor(private http: HttpClient) { }

  initializeAPI(key: string | null): void {
    this.key = key;
  }

  search(query: string): Observable<Result[]> {
    return this.http.get<YoutubeSearchResponse>(this.url, {
      params: { q: query, key: this.key ?? '', part: 'snippet', type: 'video', maxResults: 5 }
    }).pipe(map((response: YoutubeSearchResponse) => {
      return response.items.map((item: YoutubeSearchItem) => {
        return new Result({
          id: item.id.videoId,
          title: item.snippet.title,
          thumbnailUrl: item.snippet.thumbnails.high.url,
          channelTitle: item.snippet.channelTitle
        })
      })
    }))
  }

}
