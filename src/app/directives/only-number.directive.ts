// https://stackoverflow.com/a/58535434/8088021

import { Directive, ElementRef, HostListener } from '@angular/core';

@Directive({ selector: '[onlyNumber]' })
export class OnlyNumberDirective {

  private navigationKeys = [
    'Backspace',
    'Delete',
    'Tab',
    'Escape',
    'Enter',
    'Home',
    'End',
    'ArrowLeft',
    'ArrowRight',
    'Clear',
    'Copy',
    'Paste'
  ];
  inputElement: HTMLInputElement;
  constructor(public el: ElementRef<HTMLInputElement>) {
    this.inputElement = el.nativeElement;
  }

  @HostListener('keydown', ['$event'])
  onKeyDown(e: KeyboardEvent) {
    if (
      this.navigationKeys.indexOf(e.key) > -1 || // Allow: navigation keys: backspace, delete, arrows etc.
      (e.key === 'a' && e.ctrlKey === true) || // Allow: Ctrl+A
      (e.key === 'c' && e.ctrlKey === true) || // Allow: Ctrl+C
      (e.key === 'v' && e.ctrlKey === true) || // Allow: Ctrl+V
      (e.key === 'x' && e.ctrlKey === true) || // Allow: Ctrl+X
      (e.key === 'a' && e.metaKey === true) || // Allow: Cmd+A (Mac)
      (e.key === 'c' && e.metaKey === true) || // Allow: Cmd+C (Mac)
      (e.key === 'v' && e.metaKey === true) || // Allow: Cmd+V (Mac)
      (e.key === 'x' && e.metaKey === true) // Allow: Cmd+X (Mac)
    ) {
      // let it happen, don't do anything
      return;
    }
    // Ensure that it is a number and stop the keypress
    const key = Number(e.key)
    if (
      (e.shiftKey || (isNaN(key) && !(e.key === '.')))
    ) {
      e.preventDefault();
    }
  }

  @HostListener('paste', ['$event'])
  onPaste(event: ClipboardEvent) {
    event.preventDefault();
    const pastedInput = (event.clipboardData?.getData('text/plain') ?? '').replace(/\D/g, ''); // get a digit-only string
    this.insertText(pastedInput);
  }

  @HostListener('drop', ['$event'])
  onDrop(event: DragEvent) {
    event.preventDefault();
    const textData = (event.dataTransfer?.getData('text') ?? '').replace(/\D/g, '');
    this.inputElement.focus();
    this.insertText(textData);
  }

  // Replaces the current selection with text, then fires 'input' so ngModel sees the change
  // the same way it would for typing. Inputs without a text selection (type="number") append.
  private insertText(text: string) {
    const input = this.inputElement;
    if (input.selectionStart === null) {
      input.value += text;
    } else {
      input.setRangeText(text, input.selectionStart, input.selectionEnd ?? input.selectionStart, 'end');
    }
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
}
