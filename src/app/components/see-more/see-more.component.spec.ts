import { waitForAsync, ComponentFixture, TestBed } from '@angular/core/testing';

import { LinkifyPipe, SeeMoreComponent } from './see-more.component';
import { configureTestBed } from '../../../testing/test-bed';

describe('SeeMoreComponent', () => {
  let component: SeeMoreComponent;
  let fixture: ComponentFixture<SeeMoreComponent>;

  beforeEach(waitForAsync(() => {
    configureTestBed({
      imports: [ SeeMoreComponent, LinkifyPipe ]
    })
    .compileComponents();
  }));

  beforeEach(() => {
    fixture = TestBed.createComponent(SeeMoreComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  function render(text: string): HTMLElement {
    component.text = text;
    fixture.detectChanges();
    return fixture.nativeElement.querySelector('.text');
  }

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  // Descriptions come from wherever a file was downloaded from, so anyone can write one.
  it('shows markup in a description as text instead of running it', () => {
    const description = render('Great clip <img src=x onerror=alert(1)> <script>alert(2)</script>');

    expect(description.querySelector('img, script')).toBeNull();
    expect(description.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(description.textContent).toContain('<script>alert(2)</script>');
  });

  it('links web addresses without letting one add attributes to its link', () => {
    const description = render('Q&A at https://example.test/a"onmouseover="alert(1) and https://example.test/b?x=1&y=2');
    const links = description.querySelectorAll('a');

    expect(links.length).toBe(2);
    expect(links[0].getAttribute('onmouseover')).toBeNull();
    expect(links[0].getAttribute('href')).toBe('https://example.test/a%22onmouseover=%22alert(1)');
    expect(links[0].textContent).toBe('https://example.test/a"onmouseover="alert(1)');
    expect(links[1].getAttribute('href')).toBe('https://example.test/b?x=1&y=2');
    expect(links[1].getAttribute('target')).toBe('_blank');
    expect(links[1].getAttribute('rel')).toBe('noopener noreferrer');
    expect(description.textContent).toContain('Q&A at');
  });

  it('links only whole http and https addresses', () => {
    const description = render('javascript:alert(1) httpd.conf ftp://example.test/file https:// http://');

    expect(description.querySelector('a')).toBeNull();
  });

  it('keeps the line breaks in a description', () => {
    const description = render('First line\nSecond line');

    expect(description.innerHTML.split('<br>').map(line => line.trim()).filter(Boolean)).toEqual(['First line', 'Second line']);
  });
});
