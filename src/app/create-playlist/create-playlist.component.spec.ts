import { ComponentFixture, TestBed, waitForAsync } from '@angular/core/testing';

import { CreatePlaylistComponent } from './create-playlist.component';
import { configureTestBed } from '../../testing/test-bed';

describe('CreatePlaylistComponent', () => {
  let component: CreatePlaylistComponent;
  let fixture: ComponentFixture<CreatePlaylistComponent>;

  beforeEach(waitForAsync(() => {
    configureTestBed({
      declarations: [ CreatePlaylistComponent ]
    })
    .compileComponents();
  }));

  beforeEach(() => {
    fixture = TestBed.createComponent(CreatePlaylistComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
