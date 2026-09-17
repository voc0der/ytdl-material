import { ChangeDetectionStrategy, Component, Inject } from '@angular/core';
import { MAT_BOTTOM_SHEET_DATA, MatBottomSheet, MatBottomSheetRef } from '@angular/material/bottom-sheet';
import { MatIcon } from '@angular/material/icon';

export interface PickerOption<T = unknown> {
  value: T;
  label: string;
  // Shown at the end of the row, such as the size a quality would download at.
  detail?: string | null;
}

export interface PickerSheetData {
  title: string;
  options: PickerOption[];
  // Several options can be on at once, and choosing one leaves the sheet open.
  multiple?: boolean;
  isSelected: (value: unknown) => boolean;
  select: (value: unknown) => void;
  // A second, smaller choice shown above the options, such as the order to sort in.
  segments?: PickerOption<string>[];
  segmentsTitle?: string;
  isSegmentSelected?: (value: string) => boolean;
  selectSegment?: (value: string) => void;
}

export function openPickerSheet(bottom_sheet: MatBottomSheet, data: PickerSheetData): MatBottomSheetRef<PickerSheetComponent> {
  return bottom_sheet.open(PickerSheetComponent, {
    data,
    panelClass: 'kit-sheet-panel',
    ariaLabel: data.title
  });
}

/**
 * A choice opened on a narrow screen. It reads what is selected through the callbacks rather
 * than from a copy, so a multiple choice shows each change while it stays open.
 */
@Component({
  selector: 'app-picker-sheet',
  templateUrl: './picker-sheet.component.html',
  styleUrls: ['./picker-sheet.component.scss'],
  changeDetection: ChangeDetectionStrategy.Eager,
  imports: [MatIcon]
})
export class PickerSheetComponent {
  constructor(
    @Inject(MAT_BOTTOM_SHEET_DATA) public data: PickerSheetData,
    private sheetRef: MatBottomSheetRef<PickerSheetComponent>
  ) { }

  isSegmentSelected(segment: PickerOption<string>): boolean {
    return !!this.data.isSegmentSelected?.(segment.value);
  }

  choose(option: PickerOption): void {
    this.data.select(option.value);
    if (!this.data.multiple) {
      this.sheetRef.dismiss();
    }
  }

  chooseSegment(segment: PickerOption<string>): void {
    this.data.selectSegment?.(segment.value);
  }
}
