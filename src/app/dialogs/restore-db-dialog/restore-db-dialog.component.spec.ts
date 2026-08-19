import { ComponentFixture, TestBed } from '@angular/core/testing';

import { RestoreDbDialogComponent } from './restore-db-dialog.component';
import { configureTestBed } from '../../../testing/test-bed';

describe('RestoreDbDialogComponent', () => {
  let component: RestoreDbDialogComponent;
  let fixture: ComponentFixture<RestoreDbDialogComponent>;

  beforeEach(async () => {
    await configureTestBed({
      declarations: [ RestoreDbDialogComponent ]
    })
    .compileComponents();
  });

  beforeEach(() => {
    fixture = TestBed.createComponent(RestoreDbDialogComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
