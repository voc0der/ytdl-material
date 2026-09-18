import { ComponentFixture, TestBed, waitForAsync } from '@angular/core/testing';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { EventEmitter } from '@angular/core';

import { ConfirmDialogComponent, ConfirmDialogData, openConfirmDialog } from './confirm-dialog.component';
import { configureTestBed } from '../../../testing/test-bed';

describe('ConfirmDialogComponent', () => {
  let component: ConfirmDialogComponent;
  let fixture: ComponentFixture<ConfirmDialogComponent>;

  function build(data: ConfirmDialogData = {}) {
    TestBed.resetTestingModule();
    configureTestBed({
      imports: [ConfirmDialogComponent],
      providers: [
        { provide: MAT_DIALOG_DATA, useValue: data },
        { provide: MatDialogRef, useValue: { close: vi.fn().mockName('close') } }
      ]
    }).compileComponents();
    fixture = TestBed.createComponent(ConfirmDialogComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
    return component;
  }

  beforeEach(waitForAsync(() => {
    configureTestBed({
      imports: [ ConfirmDialogComponent ]
    })
    .compileComponents();
  }));

  beforeEach(() => {
    fixture = TestBed.createComponent(ConfirmDialogComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  describe('what it is headed with', () => {
    it('asks a plain question by default', () => {
      expect(build({ dialogTitle: 'Transfer DB' }).dialogIcon).toBe('help_outline');
      expect(component.destructive).toBe(false);
    });

    it('warns when the answer deletes something', () => {
      expect(build({ submitText: 'Delete', warnSubmitColor: true }).dialogIcon).toBe('warning');
      expect(component.destructive).toBe(true);
    });

    it('warns when any of several answers does', () => {
      build({ submitActions: [{ text: 'Remove Newest', value: 'newest', warnSubmitColor: true }] });

      expect(component.destructive).toBe(true);
    });

    it('takes the icon the caller asked for over either', () => {
      expect(build({ dialogIcon: 'error_outline', warnSubmitColor: true }).dialogIcon).toBe('error_outline');
    });
  });

  describe('picking from a list', () => {
    beforeEach(() => {
      build({
        dialogType: 'selection_list',
        list: [
          { key: 'clear_finished', title: 'Finished downloads' },
          { key: 'clear_errors', title: 'Errored downloads' }
        ]
      });
    });

    it('cannot be submitted until something is picked', () => {
      expect(component.submitDisabled).toBe(true);

      component.toggleItem('clear_errors');

      expect(component.submitDisabled).toBe(false);
    });

    it('keeps the keys the caller reads back off it', () => {
      component.toggleItem('clear_errors');
      component.toggleItem('clear_finished');

      expect(component.selected_items).toEqual(['clear_errors', 'clear_finished']);
      expect(component.isSelected('clear_errors')).toBe(true);

      component.toggleItem('clear_errors');

      expect(component.selected_items).toEqual(['clear_finished']);
      expect(component.isSelected('clear_errors')).toBe(false);
    });

    it('is always submittable when it is a question rather than a list', () => {
      build({ dialogText: 'Would you like to confirm?' });

      expect(component.submitDisabled).toBe(false);
    });
  });

  describe('answering', () => {
    it('closes with what was picked', () => {
      build({ submitActions: [{ text: 'Remove Oldest', value: 'oldest' }] });

      component.confirmClicked('oldest');

      expect(component.dialogRef.close).toHaveBeenCalledWith('oldest');
    });

    it('waits on the caller when one is listening, rather than closing', () => {
      const done = new EventEmitter<boolean | string>();
      const emitted: (boolean | string)[] = [];
      done.subscribe(value => emitted.push(value));
      build({ doneEmitter: done });

      component.confirmClicked();

      expect(emitted).toEqual([true]);
      expect(component.submitClicked).toBe(true);
      expect(component.dialogRef.close).not.toHaveBeenCalled();
    });
  });

  it('opens on the shared dialog surface', () => {
    const dialog = { open: vi.fn().mockName('open').mockReturnValue({}) } as any;

    openConfirmDialog(dialog, { dialogTitle: 'Reset tasks' });

    expect(dialog.open).toHaveBeenCalledWith(ConfirmDialogComponent, expect.objectContaining({
      data: { dialogTitle: 'Reset tasks' },
      panelClass: 'kit-dialog-panel'
    }));
  });
});
