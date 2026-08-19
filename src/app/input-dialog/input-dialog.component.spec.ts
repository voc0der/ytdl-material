import { ComponentFixture, TestBed, waitForAsync } from '@angular/core/testing';

import { InputDialogComponent } from './input-dialog.component';
import { configureTestBed } from '../../testing/test-bed';

describe('InputDialogComponent', () => {
  let component: InputDialogComponent;
  let fixture: ComponentFixture<InputDialogComponent>;

  beforeEach(waitForAsync(() => {
    configureTestBed({
      declarations: [ InputDialogComponent ]
    })
    .compileComponents();
  }));

  beforeEach(() => {
    fixture = TestBed.createComponent(InputDialogComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
