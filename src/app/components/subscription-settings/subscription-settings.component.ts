import { ChangeDetectionStrategy, Component, EventEmitter, Input, OnChanges, Output, SimpleChanges } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatDialog } from '@angular/material/dialog';
import { MatIcon } from '@angular/material/icon';
import { MatSlideToggle } from '@angular/material/slide-toggle';
import { MatTooltip } from '@angular/material/tooltip';
import { ArgModifierDialogComponent } from 'app/dialogs/arg-modifier-dialog/arg-modifier-dialog.component';
import { PickerComponent } from '../picker/picker.component';
import {
  CUSTOM_TIMERANGE, QUALITY_OPTIONS, SubscriptionSettings, TIMERANGE_OPTIONS, TIMERANGE_UNIT_OPTIONS, TimerangeUnit,
  formatTimerange, parseTimerange, timerangeChoice
} from './subscription-settings';

/**
 * The settings of a subscription, for subscribing and for editing one. The choices that
 * matter most -- quality, which uploads, audio only -- are chips; the rest are rows
 * underneath. A page can show either part on its own, bound to the same settings.
 */
@Component({
  selector: 'app-subscription-settings',
  templateUrl: './subscription-settings.component.html',
  styleUrls: ['./subscription-settings.component.scss'],
  changeDetection: ChangeDetectionStrategy.Eager,
  imports: [FormsModule, MatIcon, MatSlideToggle, MatTooltip, PickerComponent]
})
export class SubscriptionSettingsComponent implements OnChanges {
  @Input({ required: true }) settings: SubscriptionSettings;
  @Input() mode: 'create' | 'edit' = 'create';
  @Input() showChoices = true;
  @Input() showRows = true;
  // A channel has playlists of its own to retrieve; a playlist does not.
  @Input() isPlaylist = false;
  // Only when subscribing: a subscription is named once, from this or from its title.
  @Input() name = '';
  @Input() disabled = false;
  @Output() nameChange = new EventEmitter<string>();
  @Output() changed = new EventEmitter<void>();

  readonly qualityOptions = QUALITY_OPTIONS;
  readonly timerangeOptions = TIMERANGE_OPTIONS;
  readonly unitOptions = TIMERANGE_UNIT_OPTIONS;
  readonly customTimerange = CUSTOM_TIMERANGE;
  readonly qualityLabel = $localize`Quality`;
  readonly uploadsLabel = $localize`Uploads`;
  readonly customUnitLabel = $localize`Unit`;
  readonly customAmountLabel = $localize`Number of units`;
  readonly editArgsLabel = $localize`Edit arguments`;
  readonly audioOnlyFixedHint = $localize`Set when subscribing`;

  // The custom range being typed. Kept apart from the settings so that clearing the number
  // to type another does not throw the choice back to every upload.
  customAmount: number | null = null;
  customUnit: TimerangeUnit = 'day';
  private customChosen = false;

  constructor(private dialog: MatDialog) { }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['settings'] && this.settings) {
      const current = parseTimerange(this.settings.timerange);
      this.customChosen = false;
      this.customAmount = current?.amount ?? null;
      this.customUnit = current?.unit ?? 'day';
    }
  }

  get timerangeChoice(): string | null {
    return this.customChosen ? CUSTOM_TIMERANGE : timerangeChoice(this.settings.timerange);
  }

  get isCustomTimerange(): boolean {
    return this.timerangeChoice === CUSTOM_TIMERANGE;
  }

  chooseQuality(quality: string): void {
    this.settings.maxQuality = quality;
    this.changed.emit();
  }

  chooseTimerange(choice: string | null): void {
    if (choice === CUSTOM_TIMERANGE) {
      const current = parseTimerange(this.settings.timerange);
      this.customChosen = true;
      this.customAmount = current?.amount ?? 7;
      this.customUnit = current?.unit ?? 'day';
      this.applyCustomTimerange();
      return;
    }

    this.customChosen = false;
    this.settings.timerange = choice;
    this.changed.emit();
  }

  applyCustomTimerange(): void {
    // A number still being typed leaves the last whole range in place.
    const timerange = formatTimerange(this.customAmount, this.customUnit);
    if (timerange && timerange !== this.settings.timerange) {
      this.settings.timerange = timerange;
      this.changed.emit();
    }
  }

  chooseCustomUnit(unit: TimerangeUnit): void {
    this.customUnit = unit;
    this.applyCustomTimerange();
  }

  toggleAudioOnly(): void {
    this.settings.audioOnly = !this.settings.audioOnly;
    this.changed.emit();
  }

  setName(name: string): void {
    this.name = name;
    this.nameChange.emit(name);
  }

  openArgsEditor(): void {
    this.dialog.open(ArgModifierDialogComponent, {
      data: { initial_args: this.settings.custom_args }
    }).afterClosed().subscribe(new_args => {
      if (new_args !== null && new_args !== undefined) {
        this.settings.custom_args = new_args;
        this.changed.emit();
      }
    });
  }
}
