import { ComponentFixture, TestBed } from '@angular/core/testing';

import { GenerateRssUrlComponent } from './generate-rss-url.component';
import { configureTestBed } from '../../../testing/test-bed';

describe('GenerateRssUrlComponent', () => {
  let component: GenerateRssUrlComponent;
  let fixture: ComponentFixture<GenerateRssUrlComponent>;

  beforeEach(async () => {
    await configureTestBed({
      declarations: [ GenerateRssUrlComponent ]
    })
    .compileComponents();

    fixture = TestBed.createComponent(GenerateRssUrlComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
