import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MAT_BOTTOM_SHEET_DATA, MatBottomSheetRef } from '@angular/material/bottom-sheet';

import { PickerSheetComponent, PickerSheetData } from './picker-sheet.component';
import { configureTestBed } from '../../../testing/test-bed';

describe('PickerSheetComponent', () => {
  let fixture: ComponentFixture<PickerSheetComponent>;
  let sheet_ref: { dismiss: ReturnType<typeof vi.fn> };
  let selected: string[];

  function createSheet(data: Partial<PickerSheetData>): void {
    configureTestBed({
      imports: [PickerSheetComponent],
      providers: [
        { provide: MAT_BOTTOM_SHEET_DATA, useValue: data },
        { provide: MatBottomSheetRef, useValue: sheet_ref }
      ]
    });
    fixture = TestBed.createComponent(PickerSheetComponent);
    fixture.detectChanges();
  }

  const rows = (): HTMLButtonElement[] => Array.from(fixture.nativeElement.querySelectorAll('.sheet-option'));

  beforeEach(() => {
    sheet_ref = { dismiss: vi.fn() };
    selected = ['registered'];
  });

  it('should close once a single choice is made', () => {
    const select = vi.fn((value: string) => { selected = [value]; });
    createSheet({
      title: 'Sort',
      options: [{ value: 'registered', label: 'Download Date' }, { value: 'title', label: 'Name' }],
      isSelected: value => selected.includes(value as string),
      select
    });

    expect(fixture.nativeElement.querySelector('.sheet-title').textContent).toBe('Sort');
    expect(rows().map(row => row.getAttribute('role'))).toEqual(['radio', 'radio']);
    expect(rows().map(row => row.getAttribute('aria-checked'))).toEqual(['true', 'false']);

    rows()[1].click();

    expect(select).toHaveBeenCalledWith('title');
    expect(sheet_ref.dismiss).toHaveBeenCalled();
  });

  it('should stay open and show each change when several can be chosen', () => {
    createSheet({
      title: 'Filters',
      options: [{ value: 'video_only', label: 'Video only' }, { value: 'favorited', label: 'Favorited' }],
      multiple: true,
      isSelected: value => selected.includes(value as string),
      select: value => { selected = [...selected, value as string]; }
    });

    rows()[1].click();
    fixture.detectChanges();

    expect(sheet_ref.dismiss).not.toHaveBeenCalled();
    expect(rows().map(row => row.getAttribute('role'))).toEqual(['checkbox', 'checkbox']);
    expect(rows()[1].getAttribute('aria-checked')).toBe('true');
  });

  it('should change the order without closing', () => {
    let order = 'descending';
    createSheet({
      title: 'Sort',
      options: [{ value: 'registered', label: 'Download Date' }],
      isSelected: () => true,
      select: vi.fn(),
      segments: [{ value: 'descending', label: 'Newest first' }, { value: 'ascending', label: 'Oldest first' }],
      segmentsTitle: 'Order',
      isSegmentSelected: value => value === order,
      selectSegment: value => { order = value; }
    });
    const segments = (): HTMLButtonElement[] => Array.from(fixture.nativeElement.querySelectorAll('.sheet-segment'));

    segments()[1].click();
    fixture.detectChanges();

    expect(order).toBe('ascending');
    expect(segments().map(segment => segment.getAttribute('aria-checked'))).toEqual(['false', 'true']);
    expect(sheet_ref.dismiss).not.toHaveBeenCalled();
  });

  it('should show what a choice would cost beside it', () => {
    createSheet({
      title: 'Quality',
      options: [{ value: '', label: 'Best' }, { value: '1080', label: '1080p', detail: '640 MB' }],
      isSelected: value => value === '',
      select: vi.fn()
    });

    expect(rows()[0].querySelector('.sheet-option-detail')).toBeNull();
    expect(rows()[1].querySelector('.sheet-option-detail').textContent).toBe('640 MB');
  });
});
