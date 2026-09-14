import { Component, OnInit, Inject, ChangeDetectionStrategy } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialogTitle, MatDialogContent, MatDialogActions, MatDialogClose } from '@angular/material/dialog';
import { PostsService } from 'app/posts.services';
import { CdkScrollable } from '@angular/cdk/scrolling';
import { MatFormField, MatLabel, MatInput, MatHint } from '@angular/material/input';
import { FormsModule } from '@angular/forms';
import { MatCheckbox } from '@angular/material/checkbox';
import { MatDivider, MatList, MatListItem } from '@angular/material/list';
import { MatSelect, MatOption } from '@angular/material/select';
import { MatIconButton, MatButton } from '@angular/material/button';
import { MatIcon } from '@angular/material/icon';
import { MatTooltip } from '@angular/material/tooltip';
import { MatProgressSpinner } from '@angular/material/progress-spinner';

@Component({
    selector: 'app-edit-category-dialog',
    templateUrl: './edit-category-dialog.component.html',
    styleUrls: ['./edit-category-dialog.component.scss'],
    changeDetection: ChangeDetectionStrategy.Eager,
    imports: [MatDialogTitle, CdkScrollable, MatDialogContent, MatFormField, MatLabel, MatInput, FormsModule, MatCheckbox, MatDivider, MatList, MatListItem, MatSelect, MatOption, MatIconButton, MatIcon, MatTooltip, MatHint, MatDialogActions, MatButton, MatDialogClose, MatProgressSpinner]
})
export class EditCategoryDialogComponent implements OnInit {

  updating = false;
  original_category = null;
  category = null;

  propertyOptions = [
    {
      value: 'fulltitle',
      label: 'Title'
    },
    {
      value: 'id',
      label: 'ID'
    },
    {
      value: 'webpage_url',
      label: 'URL'
    },
    {
      value: 'view_count',
      label: 'Views'
    },
    {
      value: 'uploader',
      label: 'Uploader'
    },
    {
      value: 'categories',
      label: 'Source category'
    },
    {
      value: '_filename',
      label: 'File Name'
    },
    {
      value: 'tags',
      label: 'Tags'
    }
  ];

  comparatorOptions = [
    {
      value: 'includes',
      label: 'includes'
    },
    {
      value: 'not_includes',
      label: 'not includes'
    },
    {
      value: 'equals',
      label: 'equals'
    },
    {
      value: 'not_equals',
      label: 'not equals'
    },

  ];

  constructor(@Inject(MAT_DIALOG_DATA) public data: any, private postsService: PostsService) {
    if (this.data) {
      this.original_category = this.data.category;
      this.category = JSON.parse(JSON.stringify(this.original_category));
    }
  }

  ngOnInit(): void {
  }

  addNewRule() {
    this.category['rules'].push({
      preceding_operator: 'or',
      property: 'fulltitle',
      comparator: 'includes',
      value: ''
    });
  }

  saveClicked() {
    this.updating = true;
    this.postsService.updateCategory(this.category).subscribe(res => {
      this.updating = false;
      this.original_category = JSON.parse(JSON.stringify(this.category));
      this.postsService.reloadCategories();
    }, err => {
      this.updating = false;
      console.error(err);
    });
  }

  categoryChanged() {
    return JSON.stringify(this.category) === JSON.stringify(this.original_category);
  }

  swapRules(original_index, new_index) {
    [this.category.rules[original_index], this.category.rules[new_index]] = [this.category.rules[new_index],
                                                                            this.category.rules[original_index]];
  }

  removeRule(index) {
    this.category['rules'].splice(index, 1);
  }

}
