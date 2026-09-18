import { Component, OnInit, Inject, ChangeDetectionStrategy } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialogTitle, MatDialogContent, MatDialogActions, MatDialogClose } from '@angular/material/dialog';
import { PostsService } from 'app/posts.services';
import { CdkScrollable } from '@angular/cdk/scrolling';
import { FormsModule } from '@angular/forms';
import { MatSlideToggle } from '@angular/material/slide-toggle';
import { MatIcon } from '@angular/material/icon';
import { MatTooltip } from '@angular/material/tooltip';
import { MatProgressSpinner } from '@angular/material/progress-spinner';
import { PickerComponent, PickerOption } from 'app/components/picker/picker.component';

@Component({
    selector: 'app-edit-category-dialog',
    templateUrl: './edit-category-dialog.component.html',
    styleUrls: ['./edit-category-dialog.component.scss'],
    changeDetection: ChangeDetectionStrategy.Eager,
    host: { class: 'kit-dialog' },
    imports: [MatDialogTitle, CdkScrollable, MatDialogContent, FormsModule, MatSlideToggle, MatIcon, MatTooltip, MatDialogActions, MatDialogClose, MatProgressSpinner, PickerComponent]
})
export class EditCategoryDialogComponent implements OnInit {

  updating = false;
  original_category = null;
  category = null;

  readonly operatorLabel = $localize`Operator`;
  readonly propertyLabel = $localize`Property`;
  readonly comparatorLabel = $localize`Comparator`;
  readonly valueLabel = $localize`Value`;

  readonly operatorOptions: PickerOption[] = [
    { value: 'or', label: 'OR' },
    { value: 'and', label: 'AND' }
  ];

  propertyOptions: PickerOption[] = [
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

  comparatorOptions: PickerOption[] = [
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
