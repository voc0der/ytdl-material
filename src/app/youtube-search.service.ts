import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

interface ResultInit {
  id?: string | null;
  title?: string | null;
  desc?: string | null;
  thumbnailUrl?: string | null;
  videoUrl?: string | null;
  uploaded?: string | null;
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
    description: string;
    thumbnails: {
      high: {
        url: string;
      };
    };
    publishedAt: string;
  };
}

export class Result {
  id: string | null
  title: string | null
  desc: string | null
  thumbnailUrl: string | null
  videoUrl: string | null
  uploaded: string | null;

  constructor(obj: ResultInit = {}) {
    this.id = obj.id ?? null
    this.title = obj.title ?? null
    this.desc = obj.desc ?? null
    this.thumbnailUrl = obj.thumbnailUrl ?? null
    this.uploaded = obj.uploaded ? formatDate(Date.parse(obj.uploaded)) : null
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

  initializeAPI(key: string): void {
    this.key = key;
  }

  search(query: string): Observable<Result[]> {
    if (this.ValidURL(query)) {
      return new Observable<Result[]>();
    }
    const params: string = [
      `q=${query}`,
      `key=${this.key}`,
      `part=snippet`,
      `type=video`,
      `maxResults=5`
    ].join('&')
    const queryUrl = `${this.url}?${params}`
    return this.http.get<YoutubeSearchResponse>(queryUrl).pipe(map((response: YoutubeSearchResponse) => {
      return response.items.map((item: YoutubeSearchItem) => {
        return new Result({
          id: item.id.videoId,
          title: item.snippet.title,
          desc: item.snippet.description,
          thumbnailUrl: item.snippet.thumbnails.high.url,
          uploaded: item.snippet.publishedAt
        })
      })
    }))
  }

  // checks if url is a valid URL
  ValidURL(str: string): boolean {
    // tslint:disable-next-line: max-line-length
    const strRegex = /((([A-Za-z]{3,9}:(?:\/\/)?)(?:[-;:&=\+\$,\w]+@)?[A-Za-z0-9.-]+|(?:www.|[-;:&=\+\$,\w]+@)[A-Za-z0-9.-]+)((?:\/[\+~%\/.\w-_]*)?\??(?:[-\+=&;%@.\w_]*)#?(?:[\w]*))?)/;
    const re = new RegExp(strRegex);
    return re.test(str);
  }
}

function formatDate(dateVal: number): string {
  const newDate = new Date(dateVal);

  const sMonth = padValue(newDate.getMonth() + 1);
  const sDay = padValue(newDate.getDate());
  const sYear = newDate.getFullYear();
  let sHour: number | string = newDate.getHours();
  const sMinute = padValue(newDate.getMinutes());
  let sAMPM = 'AM';

  const iHourCheck = Number(sHour);

  if (iHourCheck > 12) {
      sAMPM = 'PM';
      sHour = iHourCheck - 12;
  } else if (iHourCheck === 0) {
      sHour = '12';
  }

  sHour = padValue(sHour);

  return sMonth + '-' + sDay + '-' + sYear + ' ' + sHour + ':' + sMinute + ' ' + sAMPM;
}

function padValue(value: number | string): string {
  return Number(value) < 10 ? '0' + value : String(value);
}
