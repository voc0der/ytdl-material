import { ComponentFixture, TestBed, waitForAsync } from '@angular/core/testing';

import { EditCategoryDialogComponent } from './edit-category-dialog.component';
import { configureTestBed } from '../../../testing/test-bed';

describe('EditCategoryDialogComponent', () => {
  let component: EditCategoryDialogComponent;
  let fixture: ComponentFixture<EditCategoryDialogComponent>;

  beforeEach(waitForAsync(() => {
    configureTestBed({
      declarations: [ EditCategoryDialogComponent ]
    })
    .compileComponents();
  }));

  beforeEach(() => {
    fixture = TestBed.createComponent(EditCategoryDialogComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
