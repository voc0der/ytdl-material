import { ChangeDetectionStrategy, Component, ElementRef, EventEmitter, Input, Output, ViewChild } from '@angular/core';
import { BreakpointObserver } from '@angular/cdk/layout';
import { MatBottomSheet } from '@angular/material/bottom-sheet';
import { MatDivider } from '@angular/material/divider';
import { MatIcon } from '@angular/material/icon';
import { MatMenu, MatMenuItem, MatMenuTrigger } from '@angular/material/menu';
import { MatProgressSpinner } from '@angular/material/progress-spinner';
import { NARROW_SCREEN_QUERY } from 'app/utils/narrow-screen';
import { openPickerSheet, type PickerOption } from './picker-sheet.component';

export type { PickerOption } from './picker-sheet.component';

/**
 * A chip that shows the value of one setting and lets it be changed: from a menu under the
 * chip on a wide screen, or from a sheet on a narrow one, where a menu would be cramped and
 * cut short. Optionally it carries a second, smaller choice (segments) shown above the
 * options, such as the order to sort in.
 */
@Component({
  selector: 'app-picker',
  templateUrl: './picker.component.html',
  styleUrls: ['./picker.component.scss'],
  changeDetection: ChangeDetectionStrategy.Eager,
  imports: [MatIcon, MatMenu, MatMenuItem, MatMenuTrigger, MatDivider, MatProgressSpinner]
})
export class PickerComponent {
  @Input() options: PickerOption[] = [];
  @Input() value: unknown = null;
  // Names the choice: the heading of its sheet, and what a screen reader calls an icon-only chip.
  @Input() title = '';
  // Shown ahead of the value, as in "Quality Best".
  @Input() label: string | null = null;
  @Input() icon: string | null = null;
  @Input() iconOnly = false;
  @Input() disabled = false;
  @Input() loading = false;
  @Input() segments: PickerOption<string>[] = [];
  @Input() segment: string | null = null;
  @Input() segmentsTitle = '';
  @Output() valueChange = new EventEmitter<unknown>();
  @Output() segmentChange = new EventEmitter<string>();

  @ViewChild(MatMenuTrigger) menuTrigger: MatMenuTrigger;
  @ViewChild('trigger') trigger: ElementRef<HTMLButtonElement>;

  expanded = false;

  constructor(private bottomSheet: MatBottomSheet, private breakpointObserver: BreakpointObserver) { }

  get selectedLabel(): string {
    return this.options.find(option => option.value === this.value)?.label ?? '';
  }

  open(): void {
    if (this.disabled || this.loading) {
      return;
    }

    if (this.breakpointObserver.isMatched(NARROW_SCREEN_QUERY)) {
      this.openSheet();
    } else {
      this.menuTrigger.openMenu();
    }
  }

  choose(value: unknown): void {
    if (value === this.value) {
      return;
    }

    this.value = value;
    this.valueChange.emit(value);
  }

  chooseSegment(segment: string): void {
    if (segment === this.segment) {
      return;
    }

    this.segment = segment;
    this.segmentChange.emit(segment);
  }

  onMenuClosed(): void {
    this.expanded = false;
    // The menu hangs off a stand-in laid over the chip, which cannot take focus back itself.
    this.trigger?.nativeElement.focus();
  }

  private openSheet(): void {
    this.expanded = true;
    openPickerSheet(this.bottomSheet, {
      title: this.title,
      options: this.options,
      isSelected: value => value === this.value,
      select: value => this.choose(value),
      segments: this.segments,
      segmentsTitle: this.segmentsTitle,
      isSegmentSelected: segment => segment === this.segment,
      selectSegment: segment => this.chooseSegment(segment)
    }).afterDismissed().subscribe(() => {
      this.expanded = false;
    });
  }
}
