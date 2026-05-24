import { Pipe, PipeTransform } from '@angular/core';

import { Notification, TxFunction } from '@/models/global-state';
import { Collection } from '@/models/data.state';

type NotificationTexts = {
  titles: {
    [key in TxFunction]: string;
  } & { // Use intersection type to add 'batch' separately
    batch: {
      [key in TxFunction]?: string;
    };
  };
  body: {
    [key in Notification['type']]: {
      message: string;
    };
  };
  classes: {
    [key in TxFunction]: string;
  };
};

@Pipe({
  standalone: true,
  name: 'notifText'
})
export class NotificationPipe implements PipeTransform {

  notifs: NotificationTexts = {
    titles: {
      sendToEscrow: 'Send to Escrow',
      hashNoLongerForSale: 'Delist %singleName%',
      offerHashForSale: 'Offer %singleName% For Sale',
      withdrawBidForHash: 'Withdraw Bid For %singleName%',
      acceptBidForHash: 'Accept Bid For %singleName%',
      buyHash: 'Buy %singleName%',
      enterBidForHash: 'Enter Bid For %singleName%',
      transferHash: 'Transfer %singleName%',
      withdrawHash: 'Withdraw %singleName% from Escrow',
      purchased: 'Your item Sold!',
      chatMessage: 'New message',
      bridgeOut: 'Bridge %singleName% to Magma',
      bridgeIn: 'Bridge %singleName% to Ethereum',
      mint: 'Inscribing %singleName%',
      tic: 'Inscribing Comment',
      ticDelete: 'Deleting Comment',
      createBid: 'Auction Bid',
      settleAuction: 'Settle Auction',
      batch: {
        sendToEscrow: 'Send <span class="highlight">%length%</span> items to Escrow',
        hashNoLongerForSale: 'Delist <span class="highlight">%length%</span> items',
        offerHashForSale: 'Offer <span class="highlight">%length%</span> items For Sale',
        withdrawBidForHash: 'Withdraw Bid For <span class="highlight">%length%</span> items',
        acceptBidForHash: 'Accept Bid For <span class="highlight">%length%</span> items',
        buyHash: 'Buy <span class="highlight">%length%</span> items',
        enterBidForHash: 'Enter Bid For <span class="highlight">%length%</span> items',
        transferHash: 'Transfer <span class="highlight">%length%</span> items',
        withdrawHash: 'Withdraw <span class="highlight">%length%</span> items from Escrow',
      },
    },
    body: {
      event: {
        message: 'Sold for <strong>%value%Ξ</strong>'
      },
      wallet: {
        message: '<strong>Please submit</strong> the transaction using your connected Ethereum wallet.'
      },
      pending: {
        message: 'Your transaction is <strong>being processed</strong> on the Ethereum network.'
      },
      complete: {
        message: 'Your transaction is <strong>complete</strong>.'
      },
      error: {
        message: 'There was an <strong>error</strong> with your transaction.'
      },
      chat: {
        message: 'New message'
      },
    },
    classes: {
      sendToEscrow: 'escrow',
      hashNoLongerForSale: 'sale',
      offerHashForSale: 'sale',
      withdrawBidForHash: 'bid',
      acceptBidForHash: 'bid',
      buyHash: 'sale',
      enterBidForHash: 'bid',
      transferHash: 'transfer',
      withdrawHash: 'escrow',
      purchased: 'purchased',
      chatMessage: 'chat',
      bridgeIn: 'bridge',
      bridgeOut: 'bridge',
      mint: 'mint',
      tic: 'tic',
      ticDelete: 'tic',
      createBid: 'auction',
      settleAuction: 'auction',
    },
  }

  transform(
    notif: Notification,
    collections: { [key: Collection['slug']]: Collection },
    type: 'title' | 'body' | 'class'
  ): string | null {

    if (!notif) return null;

    // console.log({ notif, collections, type })

    if (type === 'class') {
      return this.notifs.classes[notif.function];
    }

    if (type === 'title') {
      let title = this.notifs.titles[notif.function];

      if (notif.isBatch && notif.hashIds) {
        title = this.notifs.titles.batch[notif.function]!.replace('%length%', `${notif.hashIds.length}`);
      }

      if (notif.slug) {
        title = title.replace('%singleName%', collections[notif.slug]?.singleName || '');
      }

      if (notif.chatAddress) {
        title = this.notifs.titles.chatMessage;
      }

      return title.replace('%singleName%', 'Ethscription');
    }

    if (type === 'body') {
      if (notif.type === 'event') {
        return this.notifs.body.event.message.replace('%value%', `${notif.value}`);
      }

      if (notif.isBatch && notif.hashIds) {
        return this.notifs.body[notif.type].message;
      }

      return this.notifs.body[notif.type].message.replace('%tokenId%', `${notif.tokenId}`);
    }

    return '';
  }
}
