import { Component, Input, EventEmitter, Output, ChangeDetectionStrategy } from '@angular/core';
import { Sort } from 'api-types';

@Component({
    selector: 'app-sort-property',
    templateUrl: './sort-property.component.html',
    styleUrls: ['./sort-property.component.scss'],
    changeDetection: ChangeDetectionStrategy.Eager,
    standalone: false
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
  
  @Input() sortProperty = 'registered';
  @Input() descendingMode = true;

  @Output() sortPropertyChange = new EventEmitter<string>();
  @Output() descendingModeChange = new EventEmitter<boolean>();
  @Output() sortOptionChanged = new EventEmitter<Sort>();

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
