import { ElementRef } from '@angular/core';
import { OnlyNumberDirective } from './only-number.directive';

describe('OnlyNumberDirective', () => {
  let input: HTMLInputElement;
  let directive: OnlyNumberDirective;
  let inputEvents: number;

  beforeEach(() => {
    input = document.createElement('input');
    document.body.appendChild(input);
    directive = new OnlyNumberDirective(new ElementRef(input));
    inputEvents = 0;
    input.addEventListener('input', () => inputEvents++);
  });

  afterEach(() => input.remove());

  function transfer(text: string) {
    return { getData: () => text };
  }

  it('should create an instance', () => {
    expect(directive).toBeTruthy();
  });

  it('replaces the selection with only the digits from pasted text', () => {
    input.value = '1299';
    input.setSelectionRange(1, 3);
    const event = { preventDefault: vi.fn(), clipboardData: transfer('3a4-5') } as unknown as ClipboardEvent;

    directive.onPaste(event);

    expect(event.preventDefault).toHaveBeenCalled();
    expect(input.value).toBe('13459');
    expect(input.selectionStart).toBe(4);
    expect(inputEvents).toBe(1);
  });

  it('inserts the digits from dropped text at the caret', () => {
    input.value = '10';
    input.setSelectionRange(1, 1);
    const event = { preventDefault: vi.fn(), dataTransfer: transfer('x7') } as unknown as DragEvent;

    directive.onDrop(event);

    expect(input.value).toBe('170');
    expect(inputEvents).toBe(1);
  });

  it('appends on inputs that do not expose a text selection', () => {
    input.type = 'number';
    input.value = '4';
    const event = { preventDefault: vi.fn(), clipboardData: transfer('2') } as unknown as ClipboardEvent;

    directive.onPaste(event);

    expect(input.value).toBe('42');
    expect(inputEvents).toBe(1);
  });
});
