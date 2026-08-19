import { ComponentFixture, TestBed, waitForAsync } from '@angular/core/testing';

import { ArgModifierDialogComponent, HighlightPipe } from './arg-modifier-dialog.component';
import { configureTestBed } from '../../../testing/test-bed';

describe('ArgModifierDialogComponent', () => {
  let component: ArgModifierDialogComponent;
  let fixture: ComponentFixture<ArgModifierDialogComponent>;

  beforeEach(waitForAsync(() => {
    configureTestBed({
      declarations: [ ArgModifierDialogComponent, HighlightPipe ]
    })
    .compileComponents();
  }));

  beforeEach(() => {
    fixture = TestBed.createComponent(ArgModifierDialogComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
