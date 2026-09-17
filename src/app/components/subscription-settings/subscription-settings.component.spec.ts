import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MatDialog } from '@angular/material/dialog';
import { of } from 'rxjs';

import { SubscriptionSettingsComponent } from './subscription-settings.component';
import { defaultSubscriptionSettings } from './subscription-settings';
import { configureTestBed } from '../../../testing/test-bed';

describe('SubscriptionSettingsComponent', () => {
  let fixture: ComponentFixture<SubscriptionSettingsComponent>;
  let component: SubscriptionSettingsComponent;
  let dialog: { open: ReturnType<typeof vi.fn> };
  let changes: number;

  beforeEach(async () => {
    dialog = { open: vi.fn().mockReturnValue({ afterClosed: () => of('--verbose') }) };

    await configureTestBed({
      imports: [SubscriptionSettingsComponent],
      providers: [{ provide: MatDialog, useValue: dialog }]
    }).compileComponents();

    fixture = TestBed.createComponent(SubscriptionSettingsComponent);
    component = fixture.componentInstance;
    component.settings = defaultSubscriptionSettings();
    changes = 0;
    component.changed.subscribe(() => changes++);
    fixture.detectChanges();
  });

  const chips = (): HTMLButtonElement[] => Array.from(fixture.nativeElement.querySelectorAll('.settings-choices button.kit-chip'));
  const rowTitles = (): string[] => Array.from(fixture.nativeElement.querySelectorAll('.settings-row-title')).map((title: HTMLElement) => title.textContent.trim());

  it('shows the choices and the rows of a new subscription', () => {
    expect(rowTitles()).toEqual(['Name', 'Own folder', 'Playlist', 'File names', 'Extra arguments']);
    expect(chips().map(chip => chip.textContent.trim())).toContain('Only Audio');
  });

  it('shows what a page asks for on its own', () => {
    component.showRows = false;
    fixture.detectChanges();

    expect(rowTitles()).toEqual([]);
    expect(fixture.nativeElement.querySelector('.settings-choices')).toBeTruthy();
  });

  it('offers Paused when editing, and never a name', () => {
    component.mode = 'edit';
    fixture.detectChanges();

    expect(rowTitles()).toEqual(['Paused', 'Own folder', 'Playlist', 'File names', 'Extra arguments']);
  });

  it('drops the quality choice for an audio-only subscription', () => {
    expect(fixture.nativeElement.textContent).toContain('Quality');

    component.settings.audioOnly = true;
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).not.toContain('Quality');
  });

  it('cannot change audio only once subscribed', () => {
    component.mode = 'edit';
    component.settings.audioOnly = true;
    fixture.detectChanges();

    const audioChip = chips().find(chip => chip.textContent.includes('Only Audio'));
    expect(audioChip.disabled).toBe(true);
  });

  it('writes a custom range the backend can read', () => {
    component.chooseTimerange('custom');

    expect(component.isCustomTimerange).toBe(true);
    expect(component.settings.timerange).toBe('now-7days');

    component.customAmount = 3;
    component.chooseCustomUnit('month');

    expect(component.settings.timerange).toBe('now-3months');
    expect(changes).toBeGreaterThan(0);
  });

  it('keeps the custom range while the number is being retyped', () => {
    component.chooseTimerange('custom');
    component.customAmount = null;
    component.applyCustomTimerange();

    expect(component.settings.timerange).toBe('now-7days');
    expect(component.isCustomTimerange).toBe(true);
  });

  it('opens an existing custom range on its own number and unit', () => {
    component.settings = { ...defaultSubscriptionSettings(), timerange: 'now-13days' };
    component.ngOnChanges({ settings: {} as any });

    expect(component.isCustomTimerange).toBe(true);
    expect(component.customAmount).toBe(13);
    expect(component.customUnit).toBe('day');
  });

  it('goes back to every upload when the range is cleared', () => {
    component.chooseTimerange('now-1month');
    expect(component.settings.timerange).toBe('now-1month');

    component.chooseTimerange(null);

    expect(component.settings.timerange).toBeNull();
    expect(component.isCustomTimerange).toBe(false);
  });

  it('takes the arguments the editor returns', () => {
    component.openArgsEditor();

    expect(dialog.open).toHaveBeenCalled();
    expect(component.settings.custom_args).toBe('--verbose');
    expect(changes).toBe(1);
  });

  it('reports the name as it is typed without owning it', () => {
    const names: string[] = [];
    component.nameChange.subscribe(name => names.push(name));

    component.setName('My channel');

    expect(names).toEqual(['My channel']);
  });
});
