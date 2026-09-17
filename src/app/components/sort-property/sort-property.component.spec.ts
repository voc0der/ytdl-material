import { ComponentFixture, TestBed } from '@angular/core/testing';

import { SortPropertyComponent } from './sort-property.component';
import { configureTestBed } from '../../../testing/test-bed';

describe('SortPropertyComponent', () => {
 let component: SortPropertyComponent;
 let fixture: ComponentFixture<SortPropertyComponent>;

 beforeEach(async () => {
  await configureTestBed({
   imports: [SortPropertyComponent]
  })
   .compileComponents();

  fixture = TestBed.createComponent(SortPropertyComponent);
  component = fixture.componentInstance;
  fixture.detectChanges();
 });

 it('should create', () => {
  expect(component).toBeTruthy();
 });

 it('should emit the selected sort property when changed', () => {
  const sort_property_spy = vi.spyOn(component.sortPropertyChange, 'emit').mockReturnValue(undefined);
  const sort_option_spy = vi.spyOn(component.sortOptionChanged, 'emit').mockReturnValue(undefined);

  component.emitSortOptionChanged('upload_date');

  expect(component.sortProperty).toBe('upload_date');
  expect(sort_property_spy).toHaveBeenCalledWith('upload_date');
  expect(sort_option_spy).toHaveBeenCalledWith({ by: 'upload_date', order: -1 });
 });

 it('should emit descending mode changes when toggled', () => {
  const descending_mode_spy = vi.spyOn(component.descendingModeChange, 'emit').mockReturnValue(undefined);
  const sort_option_spy = vi.spyOn(component.sortOptionChanged, 'emit').mockReturnValue(undefined);

  component.toggleModeChange();

  expect(component.descendingMode).toBe(false);
  expect(descending_mode_spy).toHaveBeenCalledWith(false);
  expect(sort_option_spy).toHaveBeenCalledWith({ by: 'registered', order: 1 });
 });
 it('should name the two orders in the terms of the property being sorted by', () => {
  const labels = () => component.currentOrderOptions.map(option => option.label);

  expect(labels()).toEqual(['Newest first', 'Oldest first']);
  component.sortProperty = 'title';
  expect(labels()).toEqual(['A to Z', 'Z to A']);
  expect(component.currentOrderOptions.map(option => option.value)).toEqual(['ascending', 'descending']);
  component.sortProperty = 'size';
  expect(labels()).toEqual(['Largest first', 'Smallest first']);
 });

 it('should emit the order picked', () => {
  const sort_option_spy = vi.spyOn(component.sortOptionChanged, 'emit').mockReturnValue(undefined);

  component.orderChanged('ascending');

  expect(component.descendingMode).toBe(false);
  expect(component.currentOrder).toBe('ascending');
  expect(sort_option_spy).toHaveBeenCalledWith({ by: 'registered', order: 1 });
 });

 it('should show the direction on the chip, and a sort icon when only the icon shows', () => {
  expect(component.icon).toBe('arrow_downward');
  component.descendingMode = false;
  expect(component.icon).toBe('arrow_upward');
  component.iconOnly = true;
  expect(component.icon).toBe('swap_vert');
 });
});
