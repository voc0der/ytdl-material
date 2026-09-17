import { Component, Input, EventEmitter, Output, ChangeDetectionStrategy } from '@angular/core';
import { Sort } from 'api-types';
import { PickerComponent, type PickerOption } from '../picker/picker.component';

@Component({
    selector: 'app-sort-property',
    templateUrl: './sort-property.component.html',
    styleUrls: ['./sort-property.component.scss'],
    changeDetection: ChangeDetectionStrategy.Eager,
    imports: [PickerComponent]
})
export class SortPropertyComponent {
  sortProperties = {
    'registered': {
      'key': 'registered',
      'label': $localize`Download Date`
    },
    'upload_date': {
      'key': 'upload_date',
      'label': $localize`Upload Date`
    },
    'title': {
      'key': 'title',
      'label': $localize`Name`
    },
    'size': {
      'key': 'size',
      'label': $localize`File Size`
    },
    'duration': {
      'key': 'duration',
      'label': $localize`Duration`
    }
  };

  readonly propertyOptions: PickerOption<string>[] = Object.values(this.sortProperties)
    .map(property => ({ value: property.key, label: property.label }));

  // "Descending" means something different for each property, so each names its two orders
  // in its own terms, listed with the one people usually want first.
  private readonly newestFirst = { value: 'descending', label: $localize`:Sort order, most recent first:Newest first` };
  private readonly oldestFirst = { value: 'ascending', label: $localize`:Sort order, least recent first:Oldest first` };
  private readonly orderOptions: Record<string, PickerOption<string>[]> = {
    registered: [this.newestFirst, this.oldestFirst],
    upload_date: [this.newestFirst, this.oldestFirst],
    title: [
      { value: 'ascending', label: $localize`:Sort order, alphabetical:A to Z` },
      { value: 'descending', label: $localize`:Sort order, reverse alphabetical:Z to A` }
    ],
    size: [
      { value: 'descending', label: $localize`:Sort order, largest first:Largest first` },
      { value: 'ascending', label: $localize`:Sort order, smallest first:Smallest first` }
    ],
    duration: [
      { value: 'descending', label: $localize`:Sort order, longest first:Longest first` },
      { value: 'ascending', label: $localize`:Sort order, shortest first:Shortest first` }
    ]
  };

  readonly title = $localize`:Sort picker title:Sort`;
  readonly orderTitle = $localize`:Sort order picker label:Order`;

  @Input() sortProperty = 'registered';
  @Input() descendingMode = true;
  // Shows only an icon, for where the control sits inside the search field on a narrow screen.
  @Input() iconOnly = false;

  @Output() sortPropertyChange = new EventEmitter<string>();
  @Output() descendingModeChange = new EventEmitter<boolean>();
  @Output() sortOptionChanged = new EventEmitter<Sort>();

  get currentOrderOptions(): PickerOption<string>[] {
    return this.orderOptions[this.sortProperty] ?? this.orderOptions['registered'];
  }

  get currentOrder(): string {
    return this.descendingMode ? 'descending' : 'ascending';
  }

  get icon(): string {
    if (this.iconOnly) {
      return 'swap_vert';
    }

    return this.descendingMode ? 'arrow_downward' : 'arrow_upward';
  }

  orderChanged(order: string): void {
    this.descendingMode = order === 'descending';
    this.emitSortOptionChanged();
  }

  toggleModeChange(): void {
    this.descendingMode = !this.descendingMode;
    this.emitSortOptionChanged();
  }

  emitSortOptionChanged(sortProperty = this.sortProperty): void {
    this.sortProperty = sortProperty;
    if (!this.sortProperty || !this.sortProperties[this.sortProperty]) {
      return;
    }
    this.sortPropertyChange.emit(this.sortProperty);
    this.descendingModeChange.emit(this.descendingMode);
    this.sortOptionChanged.emit({
      by: this.sortProperty,
      order: this.descendingMode ? -1 : 1
    });
  }
}
