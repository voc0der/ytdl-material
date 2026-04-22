import { ComponentFixture, TestBed } from '@angular/core/testing';

import { SortPropertyComponent } from './sort-property.component';

describe('SortPropertyComponent', () => {
  let component: SortPropertyComponent;
  let fixture: ComponentFixture<SortPropertyComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      declarations: [ SortPropertyComponent ]
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
    const sort_property_spy = spyOn(component.sortPropertyChange, 'emit');
    const sort_option_spy = spyOn(component.sortOptionChanged, 'emit');

    component.emitSortOptionChanged('upload_date');

    expect(component.sortProperty).toBe('upload_date');
    expect(sort_property_spy).toHaveBeenCalledWith('upload_date');
    expect(sort_option_spy).toHaveBeenCalledWith({by: 'upload_date', order: -1});
  });

  it('should emit descending mode changes when toggled', () => {
    const descending_mode_spy = spyOn(component.descendingModeChange, 'emit');
    const sort_option_spy = spyOn(component.sortOptionChanged, 'emit');

    component.toggleModeChange();

    expect(component.descendingMode).toBeFalse();
    expect(descending_mode_spy).toHaveBeenCalledWith(false);
    expect(sort_option_spy).toHaveBeenCalledWith({by: 'registered', order: 1});
  });
});
