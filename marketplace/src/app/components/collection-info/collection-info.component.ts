import { Component, input } from '@angular/core';
import { CommonModule } from '@angular/common';

import { Collection } from '@/models/data.state';
import { normalizeDefaultBackground } from '@/constants/background-color';

@Component({
  standalone: true,
  imports: [
    CommonModule,
  ],
  selector: 'app-collection-info',
  templateUrl: './collection-info.component.html',
  styleUrls: ['./collection-info.component.scss']
})
export class CollectionInfoComponent {

  collection = input<Collection | null>();

  imageBackgroundColor(): string | null {
    return normalizeDefaultBackground(this.collection()?.defaultBackground);
  }

}
