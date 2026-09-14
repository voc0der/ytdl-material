import { Component, Inject, ChangeDetectionStrategy } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialogTitle, MatDialogContent, MatDialogActions, MatDialogClose } from '@angular/material/dialog';
import { Task, TaskType } from 'api-types';
import { PostsService } from 'app/posts.services';
import { CdkScrollable } from '@angular/cdk/scrolling';
import { MatFormField, MatLabel, MatInput, MatSuffix } from '@angular/material/input';
import { FormsModule } from '@angular/forms';
import { OnlyNumberDirective } from '../../directives/only-number.directive';
import { MatCheckbox } from '@angular/material/checkbox';
import { MatButton } from '@angular/material/button';

@Component({
    selector: 'app-task-settings',
    templateUrl: './task-settings.component.html',
    styleUrls: ['./task-settings.component.scss'],
    changeDetection: ChangeDetectionStrategy.Eager,
    imports: [MatDialogTitle, CdkScrollable, MatDialogContent, MatFormField, MatLabel, MatInput, FormsModule, OnlyNumberDirective, MatSuffix, MatCheckbox, MatDialogActions, MatButton, MatDialogClose]
})
export class TaskSettingsComponent {
  task_key: TaskType;
  new_options = {};
  task: Task = null;

  constructor(private postsService: PostsService, @Inject(MAT_DIALOG_DATA) public data: {task: Task}) {
    this.task_key = this.data.task.key;
    this.task = this.data.task;
    if (!this.task.options) {
      this.task.options = {};
    }
  }

  ngOnInit(): void {
    this.getSettings();
  }

  getSettings(): void {
    this.postsService.getTask(this.task_key).subscribe(res => {
      this.task = res['task'];
      this.new_options = JSON.parse(JSON.stringify(this.task['options'])) || {};
    });
  }

  saveSettings(): void {
    this.postsService.updateTaskOptions(this.task_key, this.new_options).subscribe(() => {
      this.getSettings();
    }, () => {
      this.getSettings();
    });
  }

  optionsChanged(): boolean {
    return JSON.stringify(this.new_options) !== JSON.stringify(this.task.options);
  }
}
