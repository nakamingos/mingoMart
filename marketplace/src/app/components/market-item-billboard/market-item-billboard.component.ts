import { Component, effect, input, signal, untracked } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';

import { LazyLoadImageModule } from 'ng-lazyload-image';

import { MarketItem } from '@/models/db';
import { DecodedData } from '@/models/ethscriptions';

import { EthscriptionService } from '@/services/ethscription.service';

@Component({
  selector: 'app-market-item-billboard',
  standalone: true,
  imports: [
    CommonModule,
    LazyLoadImageModule,
    RouterModule
  ],
  templateUrl: './market-item-billboard.component.html',
  styleUrls: ['./market-item-billboard.component.scss']
})
export class MarketItemBillboardComponent {

  marketItem = input.required<MarketItem | null>();
  contentData = signal<DecodedData | null>(null);

  constructor(
    private ethscriptionSvc: EthscriptionService
  ) {
    effect(() => {
      const marketItem = this.marketItem();
      if (!marketItem) return;

      untracked(async () => {
        const data = await this.ethscriptionSvc.fetchImage(marketItem, false);
        this.contentData.set(data);
      });
    });
  }
}
