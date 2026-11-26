import { Collection, Ethscription, AttributeItem } from '@/modules/storage/models/db';

export interface NotificationMessage {
  title: string;
  message: string;
  link: string;
  imageUrl?: string;
  /** Card image attached directly to the Discord message (preferred over imageUrl). */
  imageBuffer?: Buffer;
  filename?: string;
  /** When the sale happened; shown as the embed timestamp in the footer. */
  timestamp?: Date;
  /** Syntax highlighting for the message code block ('diff' colours +/- rows). */
  codeLanguage?: string;
}

export interface NotifItemData {
  ethscription: Ethscription;
  collection: Collection;
  attributes: NotifItemAttribute[];
}

export interface NotifItemAttribute {
  k: string;
  v: string;
  rarity: number;
}
