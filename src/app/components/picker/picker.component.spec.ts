import { ComponentFixture, TestBed } from '@angular/core/testing';
import { BreakpointObserver } from '@angular/cdk/layout';
import { OverlayContainer } from '@angular/cdk/overlay';
import { MatBottomSheet } from '@angular/material/bottom-sheet';
import { Subject } from 'rxjs';

import { PickerComponent } from './picker.component';
import { PickerSheetComponent, PickerSheetData } from './picker-sheet.component';
import { NARROW_SCREEN_QUERY } from 'app/utils/narrow-screen';
import { configureTestBed } from '../../../testing/test-bed';

describe('PickerComponent', () => {
  let fixture: ComponentFixture<PickerComponent>;
  let component: PickerComponent;
  let narrow_screen: boolean;
  let bottom_sheet: { open: ReturnType<typeof vi.fn> };
  let sheet_dismissed: Subject<void>;

  beforeEach(async () => {
    narrow_screen = false;
    sheet_dismissed = new Subject<void>();
    bottom_sheet = { open: vi.fn().mockReturnValue({ afterDismissed: () => sheet_dismissed }) };

    await configureTestBed({
      imports: [PickerComponent],
      providers: [
        { provide: MatBottomSheet, useValue: bottom_sheet },
        { provide: BreakpointObserver, useValue: { isMatched: (query: string) => query === NARROW_SCREEN_QUERY && narrow_screen } }
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(PickerComponent);
    component = fixture.componentInstance;
    component.title = 'Quality';
    component.label = 'Quality';
    component.options = [
      { value: '', label: 'Best' },
      { value: '1080', label: '1080p', detail: '640 MB' }
    ];
    component.value = '';
    fixture.detectChanges();
  });

  const chip = (): HTMLButtonElement => fixture.nativeElement.querySelector('button');
  const menuItems = (): HTMLButtonElement[] =>
    Array.from(TestBed.inject(OverlayContainer).getContainerElement().querySelectorAll('.kit-menu button.mat-mdc-menu-item'));

  it('should show the setting it changes and its current value', () => {
    expect(chip().textContent).toContain('Quality');
    expect(chip().textContent).toContain('Best');
  });

  it('should open a menu under the chip on a wide screen', () => {
    chip().click();
    fixture.detectChanges();

    expect(bottom_sheet.open).not.toHaveBeenCalled();
    expect(menuItems().map(item => item.querySelector('.mat-mdc-menu-item-text span').textContent)).toEqual(['Best', '1080p']);
    expect(menuItems()[1].querySelector('.kit-menu-detail').textContent).toBe('640 MB');
    expect(menuItems().map(item => item.getAttribute('aria-checked'))).toEqual(['true', 'false']);
    expect(chip().getAttribute('aria-expanded')).toBe('true');
  });

  it('should report a choice made from the menu', () => {
    const value_change = vi.fn();
    component.valueChange.subscribe(value_change);
    chip().click();
    fixture.detectChanges();

    menuItems()[1].click();
    fixture.detectChanges();

    expect(value_change).toHaveBeenCalledWith('1080');
    expect(chip().textContent).toContain('1080p');
  });

  it('should not report choosing the value it already has', () => {
    const value_change = vi.fn();
    component.valueChange.subscribe(value_change);

    component.choose('');

    expect(value_change).not.toHaveBeenCalled();
  });

  it('should keep the menu open while the order changes', () => {
    component.segments = [{ value: 'descending', label: 'Newest first' }, { value: 'ascending', label: 'Oldest first' }];
    component.segment = 'descending';
    fixture.detectChanges();
    const segment_change = vi.fn();
    component.segmentChange.subscribe(segment_change);
    chip().click();
    fixture.detectChanges();

    menuItems()[1].click();
    fixture.detectChanges();

    expect(segment_change).toHaveBeenCalledWith('ascending');
    expect(component.menuTrigger.menuOpen).toBe(true);
  });

  it('should open a sheet instead on a narrow screen', () => {
    narrow_screen = true;
    const value_change = vi.fn();
    component.valueChange.subscribe(value_change);

    chip().click();

    expect(component.menuTrigger.menuOpen).toBe(false);
    expect(bottom_sheet.open).toHaveBeenCalledWith(PickerSheetComponent, expect.objectContaining({ panelClass: 'kit-sheet-panel' }));
    const data: PickerSheetData = bottom_sheet.open.mock.calls[0][1].data;
    expect(data.title).toBe('Quality');
    expect(data.isSelected('')).toBe(true);

    data.select('1080');
    expect(value_change).toHaveBeenCalledWith('1080');
    expect(data.isSelected('1080')).toBe(true);

    expect(component.expanded).toBe(true);
    sheet_dismissed.next();
    expect(component.expanded).toBe(false);
  });

  it('should not open while its options are loading', () => {
    component.loading = true;
    fixture.detectChanges();

    chip().click();

    expect(component.menuTrigger.menuOpen).toBe(false);
    expect(bottom_sheet.open).not.toHaveBeenCalled();
    expect(fixture.nativeElement.querySelector('mat-spinner')).not.toBeNull();
  });

  it('leaves a chip that already shows the choice unnamed', () => {
    expect(chip().getAttribute('aria-label')).toBeNull();
  });

  it('names a chip that shows only its value by the choice and the value', () => {
    component.label = null;
    fixture.detectChanges();

    expect(chip().getAttribute('aria-label')).toBe('Quality Best');
  });

  it('shows a dash rather than nothing when the value matches no option', () => {
    component.label = null;
    component.value = 'not-an-option';
    fixture.detectChanges();

    expect(chip().textContent).toContain('—');
    expect(chip().getAttribute('aria-label')).toBe('Quality');
  });

  it('should name an icon-only chip by its title', () => {
    component.iconOnly = true;
    component.icon = 'swap_vert';
    fixture.detectChanges();

    expect(chip().getAttribute('aria-label')).toBe('Quality');
    expect(chip().classList).toContain('kit-icon-button');
    expect(chip().textContent.trim()).toBe('swap_vert');
  });
});
