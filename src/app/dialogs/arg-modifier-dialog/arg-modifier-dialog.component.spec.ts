import { ComponentFixture, TestBed, waitForAsync } from '@angular/core/testing';
import { CdkDragDrop } from '@angular/cdk/drag-drop';

import { ArgModifierDialogComponent, HighlightPipe } from './arg-modifier-dialog.component';
import { configureTestBed } from '../../../testing/test-bed';

describe('ArgModifierDialogComponent', () => {
  let component: ArgModifierDialogComponent;
  let fixture: ComponentFixture<ArgModifierDialogComponent>;

  beforeEach(waitForAsync(() => {
    configureTestBed({
      imports: [ ArgModifierDialogComponent, HighlightPipe ]
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

  it('requires a value only when the value toggle is enabled', () => {
    expect(component.canAddArg()).toBeFalsy();
    component.setFirstArg('--retries');
    expect(component.canAddArg()).toBeTruthy();
    component.secondArgEnabled = true;
    expect(component.canAddArg()).toBeFalsy();
    component.secondArg = '0';
    expect(component.canAddArg()).toBeTruthy();
    component.addArg();
    expect(component.args_array).toEqual(['--retries', '0']);
    expect(component.modified_args).toBe('--retries,,0');
  });

  it('appends flags and values without adding empty arguments', () => {
    component.setFirstArg('--ignore-errors');
    component.addArg();
    component.setFirstArg('--format');
    component.secondArgEnabled = true;
    component.secondArg = 'best video';
    component.addArg();
    expect(component.args_array).toEqual(['--ignore-errors', '--format', 'best video']);
    expect(component.modified_args).toBe('--ignore-errors,,--format,,best video');
  });

  it('ignores blank chips and clears the input after adding a nonblank chip', () => {
    const input = {value: '--ignore-errors'};
    component.add({input, value: '   '});
    component.add({input, value: ''});
    expect(component.args_array).toEqual([]);
    expect(component.modified_args).toBe('');
    expect(input.value).toBe('--ignore-errors');

    component.add({input, value: '--ignore-errors'});
    component.add({value: '--no-playlist'});
    expect(input.value).toBe('');
    expect(component.args_array).toEqual(['--ignore-errors', '--no-playlist']);
    expect(component.modified_args).toBe('--ignore-errors,,--no-playlist');
  });

  it('keeps the serialized arguments in sync when chips are moved or removed', () => {
    component.modified_args = '--ignore-errors,,--no-playlist,,--verbose';
    component.generateArgsArray();
    component.drop({previousIndex: 2, currentIndex: 0} as CdkDragDrop<string[]>);
    expect(component.args_array).toEqual(['--verbose', '--ignore-errors', '--no-playlist']);
    expect(component.modified_args).toBe('--verbose,,--ignore-errors,,--no-playlist');
    component.remove(1);
    expect(component.modified_args).toBe('--verbose,,--no-playlist');
    component.remove(1);
    component.remove(0);
    expect(component.args_array).toEqual([]);
    expect(component.modified_args).toBe('');
  });

  it('filters both autocomplete lists without regard to case', () => {
    let options: any[] = [];
    let chips: any[] = [];
    const optionSubscription = component.filteredOptions.subscribe(value => options = value);
    const chipSubscription = component.filteredChipOptions.subscribe(value => chips = value);
    try {
      expect(options).toEqual(component.availableArgs);
      component.stateCtrl.setValue('RETRIES');
      component.chipCtrl.setValue('retries');
      expect(options.length).toBeGreaterThan(0);
      expect(options.every(option => option.key.toLowerCase().includes('retries'))).toBe(true);
      expect(chips).toEqual(options);
      component.stateCtrl.setValue('no-such-option-12345');
      expect(options).toEqual([]);
    } finally {
      optionSubscription.unsubscribe();
      chipSubscription.unsubscribe();
    }
  });
});

describe('HighlightPipe', () => {
  it('highlights search terms literally, including regular expression characters', () => {
    const pipe = new HighlightPipe();
    expect(pipe.transform('Use [abc] or a+b, not aaab', '[abc] a+b'))
      .toBe('Use <b>[abc]</b> or <b>a+b</b>, not aaab');
    expect(pipe.transform('--RETRIES', 'retries')).toBe('--<b>RETRIES</b>');
    expect(pipe.transform('--retries', '')).toBe('--retries');
  });
});
