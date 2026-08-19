import { ComponentFixture, TestBed } from '@angular/core/testing';

import { TaskSettingsComponent } from './task-settings.component';
import { configureTestBed } from '../../../testing/test-bed';

describe('TaskSettingsComponent', () => {
  let component: TaskSettingsComponent;
  let fixture: ComponentFixture<TaskSettingsComponent>;

  beforeEach(async () => {
    await configureTestBed({
      declarations: [ TaskSettingsComponent ]
    })
    .compileComponents();

    fixture = TestBed.createComponent(TaskSettingsComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
