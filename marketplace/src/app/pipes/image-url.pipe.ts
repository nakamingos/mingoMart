import { MarketItem } from '@/models/db';
import { Pipe, PipeTransform } from '@angular/core';

import { environment } from '@environments/environment';

@Pipe({
  standalone: true,
  name: 'imageUrlPipe'
})
export class ImageUrlPipe implements PipeTransform {

  transform(phunk: MarketItem): string {
    if (!phunk) return '';
    return environment.staticUrl + '/static/images/' + phunk.sha;
  }
}
