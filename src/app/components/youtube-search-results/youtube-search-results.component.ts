import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';
import { MatIconButton } from '@angular/material/button';
import { MatIcon } from '@angular/material/icon';
import { MatTooltip } from '@angular/material/tooltip';
import { Result } from '../../youtube-search.service';

@Component({
  selector: 'app-youtube-search-results',
  templateUrl: './youtube-search-results.component.html',
  styleUrl: './youtube-search-results.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconButton, MatIcon, MatTooltip]
})
export class YoutubeSearchResultsComponent {
  @Input() interactive = false;
  @Input() active = false;
  @Input() loading = false;
  @Input() failed = false;
  @Input() results: Result[] = [];
  @Output() selected = new EventEmitter<string>();
}
