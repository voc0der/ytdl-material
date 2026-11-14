import { Component, Input, OnInit, Pipe, PipeTransform, ChangeDetectionStrategy } from '@angular/core';
import { NgStyle } from '@angular/common';
import { RouterLink } from '@angular/router';

const HTML_ESCAPES: Record<string, string> = {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;'};

function escapeHTML(text: string): string {
  return text.replace(/[&<>"']/g, character => HTML_ESCAPES[character]);
}

// Only a whole http or https address becomes a link, so no word can pick a link's scheme.
function webAddress(word: string): string | null {
  if (!/^https?:\/\//i.test(word)) return null;
  try {
    return new URL(word).href;
  } catch {
    return null;
  }
}

/*************************************************
 * Turns the web addresses in a description into
 * links, with every part of it escaped first. A
 * description is written by whoever uploaded the
 * file, so nothing in one may become markup. What
 * this returns is still sanitized as [innerHTML]
 * rather than marked as trusted.
 ************************************************/
@Pipe({ name: 'linkify' })
export class LinkifyPipe implements PipeTransform {

  transform(value: string): string {
    if (!value) return value;
    return value.split('\n').map(line => line.split(' ').map(word => {
      const href = webAddress(word);
      return href === null
        ? escapeHTML(word)
        : `<a target="_blank" rel="noopener noreferrer" href="${escapeHTML(href)}">${escapeHTML(word)}</a>`;
    }).join(' ')).join('<br>');
  }

}

@Component({
    selector: 'app-see-more',
    templateUrl: './see-more.component.html',
    providers: [LinkifyPipe],
    styleUrls: ['./see-more.component.scss'],
    changeDetection: ChangeDetectionStrategy.Eager,
    imports: [NgStyle, RouterLink, LinkifyPipe]
})
export class SeeMoreComponent implements OnInit {

  see_more_active = false;

  @Input() text = '';
  @Input() line_limit = 2;

  constructor() { }

  ngOnInit(): void {
  }

  toggleSeeMore() {
    this.see_more_active = !this.see_more_active;
  }

}
