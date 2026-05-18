import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

import { createCanvas, Image, registerFont } from 'canvas';
import type { CanvasRenderingContext2D } from 'canvas';

import { Collection, Ethscription } from '@/modules/storage/models/db';
import { readFile } from 'fs/promises';
import path from 'path';

const PUBLIC_SUPABASE_URL = 'https://oafirqjkcmgmjononxiy.supabase.co';
const RARITY_TRAIT_MAX_WIDTH_RATIO = 0.6;

function splitRarityTraitText(value: string, ctx: CanvasRenderingContext2D, maxWidth: number): string[] {
  const normalized = value.replace(/\s+/g, ' ').trim().toUpperCase();

  if (!normalized || ctx.measureText(normalized).width <= maxWidth) {
    return [normalized];
  }

  const words = normalized.split(' ');
  if (words.length < 2) {
    return [normalized];
  }

  let secondLine = words[words.length - 1];
  let splitIndex = words.length - 1;

  while (splitIndex > 1) {
    const candidate = `${words[splitIndex - 1]} ${secondLine}`;
    if (ctx.measureText(candidate).width > maxWidth) {
      break;
    }

    secondLine = candidate;
    splitIndex--;
  }

  return [
    words.slice(0, splitIndex).join(' '),
    secondLine,
  ].filter(Boolean);
}

function cardText(value: string | number): string {
  return `${value}`.toUpperCase();
}

@Injectable()
export class ImageService implements OnModuleInit {

  onModuleInit() {
    registerFont(path.join(__dirname, '../../../_static/Pizzascript10px-Regular.otf'), { family: 'Pizzascript' });
  }

  async generateSocialShareImage(data: {
    ethscription: Ethscription,
    collection: Collection,
    attributes: {
      k: string,
      v: string,
      rarity: number,
    }[],
  }): Promise<Buffer> {
    const canvasWidth = 1200;
    const canvasHeight = 630;

    const colors = {
      base: '#FF008C',
      green: '#00FF73',
      purple: '#5B28FF',
    };

    const canvas = createCanvas(canvasWidth, canvasHeight);
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;

    ctx.fillStyle = colors.base;
    ctx.fillRect(0, 0, canvasWidth, canvasHeight);

    const bottomBarHeight = 200;
    const bottomBarPos = canvasHeight - bottomBarHeight;

    const topBarHeight = 20;
    ctx.fillStyle = colors.green;
    ctx.fillRect(0, 0, canvasWidth, topBarHeight);

    ctx.fillStyle = colors.green;
    ctx.fillRect(0, bottomBarPos, canvasWidth, bottomBarHeight);

    ctx.fillStyle = colors.base;
    ctx.font = '400 48px Pizzascript';
    ctx.fillText(cardText(data.collection.singleName), 34, bottomBarPos + 65);

    ctx.fillStyle = colors.base;
    ctx.font = '400 137px Pizzascript';
    ctx.fillText(`${data.ethscription.tokenId}`, 30, canvasHeight - 40);

    const rightPadding = 60;
    const rarityLineY = bottomBarPos + 65;
    const traitLineY = bottomBarPos + 110;
    const collectionLineY = bottomBarPos + 155;
    const oneOfText = 'ONE OF';
    const rarityNumberText = `${data.attributes[0].rarity}`;
    ctx.font = '400 45px Pizzascript';
    const traitLines = splitRarityTraitText(
      `${data.attributes[0].v}`,
      ctx,
      canvasWidth * RARITY_TRAIT_MAX_WIDTH_RATIO,
    );
    const shouldStackTrait = traitLines.length > 1;
    const rarityNumberWidth = ctx.measureText(rarityNumberText).width;
    const oneOfTextWidth = ctx.measureText(oneOfText).width;
    const firstTraitLineWidth = shouldStackTrait ? ctx.measureText(traitLines[0]).width : 0;
    const rarityNumberX = canvasWidth - rightPadding - rarityNumberWidth - (shouldStackTrait ? firstTraitLineWidth + 15 : 0);
    const oneOfTextX = rarityNumberX - oneOfTextWidth - 15;

    ctx.fillStyle = colors.base;
    ctx.fillText(oneOfText, oneOfTextX, rarityLineY);

    ctx.fillStyle = colors.purple;
    ctx.fillText(rarityNumberText, rarityNumberX, rarityLineY);

    if (shouldStackTrait) {
      ctx.fillText(traitLines[0], canvasWidth - rightPadding - firstTraitLineWidth, rarityLineY);
    }

    const traitText = shouldStackTrait ? traitLines[1] : traitLines[0];
    const traitTextWidth = ctx.measureText(traitText).width;
    ctx.fillText(traitText, canvasWidth - rightPadding - traitTextWidth, traitLineY);

    ctx.fillStyle = colors.base;
    ctx.font = '400 45px Pizzascript';
    const text3 = cardText(`${data.collection.singleName}s`);
    const text3Width = ctx.measureText(text3).width;
    ctx.fillText(text3, canvasWidth - rightPadding - text3Width, collectionLineY);

    const baseImageUrl = `${PUBLIC_SUPABASE_URL}/storage/v1/object/public/static/images`;
    let image: ArrayBuffer | null = null;
    try {
      const response = await fetch(`${baseImageUrl}/${data.ethscription.sha}${data.collection.hasTransparents ? '_transparent' : ''}`);
      if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
      image = await response.arrayBuffer();
    } catch (err) {
      Logger.error('Failed to load inscription image:', err);
      image = null;
    }

    if (image) {
      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => {
          const imageSize = 400;
          const x = canvasWidth / 2 - imageSize / 2;
          const y = bottomBarPos - imageSize;
          ctx.drawImage(img, x, y, imageSize, imageSize);
          resolve();
        };
        img.onerror = reject;
        img.src = Buffer.from(image);
      });
    }

    try {
      const logo = new Image();
      const logoSrc = path.join(__dirname, '../../../_static/mmlogo.png');
      await new Promise<void>(async (resolve, reject) => {
        logo.onload = () => {
          ctx.drawImage(
            logo,
            35,
            topBarHeight + 35,
            296,
            60
          );
          resolve();
        };
        logo.onerror = reject;
        logo.src = Buffer.from(await readFile(logoSrc));
      }).catch(() => {
        Logger.error('Failed to load logo');
      });
    } catch (err) {
      Logger.error('Failed to load logo:', err);
    }

    const buffer = canvas.toBuffer('image/png');
    return buffer;
  }

  async generateCollectionSocialImage(
    collection: Collection,
    previewItems: Ethscription[] = []
  ): Promise<Buffer> {
    const canvasWidth = 1200;
    const canvasHeight = 630;

    console.log(collection);

    const colors = {
      base: '#FF008C',
      green: '#00FF73',
      blue: '#00FFC9',
    };

    const canvas = createCanvas(canvasWidth, canvasHeight);
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;

    ctx.fillStyle = colors.base;
    ctx.fillRect(0, 0, canvasWidth, canvasHeight);

    const bottomBarHeight = 140;
    const bottomBarPos = canvasHeight - bottomBarHeight;

    const topBarHeight = 20;
    ctx.fillStyle = colors.green;
    ctx.fillRect(0, 0, canvasWidth, topBarHeight);

    ctx.fillStyle = colors.green;
    ctx.fillRect(0, bottomBarPos, canvasWidth, bottomBarHeight);

    const logoSize = 80;
    const logoY = bottomBarPos + (bottomBarHeight - logoSize) / 2;
    const logoX = 34;

    if (collection.image) {
      const logoBackgroundColor = `#${collection.defaultBackground ?? 'FF03B4'}`;
      ctx.fillStyle = logoBackgroundColor;
      ctx.fillRect(logoX, logoY, logoSize, logoSize);

      try {
        const collectionImage = new Image();
        await new Promise<void>((resolve, reject) => {
          collectionImage.onload = () => {
            ctx.drawImage(collectionImage, logoX, logoY, logoSize, logoSize);
            resolve();
          };
          collectionImage.onerror = () => {
            Logger.error('Failed to load collection image');
            resolve();
          };
          if (collection.image.startsWith('data:')) {
            const base64Data = collection.image.split(',')[1];
            collectionImage.src = Buffer.from(base64Data, 'base64');
          } else {
            collectionImage.src = collection.image;
          }
        });
      } catch (err) {
        Logger.error('Failed to load collection image:', err);
      }
    }

    ctx.fillStyle = colors.base;
    ctx.font = '400 48px Pizzascript';
    const collectionNameX = collection.image ? logoX + logoSize + 15 : logoX;
    ctx.fillText(cardText(collection.name), collectionNameX, bottomBarPos + 65);

    ctx.fillStyle = colors.base;
    ctx.font = '400 39px Pizzascript';
    const urlText = cardText(`etherphunks.eth.limo/${collection.slug}`);
    ctx.fillText(urlText, collectionNameX, bottomBarPos + 105);

    const baseImageUrl = `${PUBLIC_SUPABASE_URL}/storage/v1/object/public/static/images`;

    if (previewItems.length > 0) {
      const gridSize = Math.min(4, previewItems.length);
      const itemSize = 340;
      const spacing = 0;
      const totalWidth = (itemSize * gridSize) + (spacing * (gridSize - 1));
      const startX = canvasWidth / 2 - totalWidth / 2;
      const startY = bottomBarPos - itemSize;

      for (let i = 0; i < gridSize; i++) {
        const item = previewItems[i];
        const x = startX + (i * (itemSize + spacing));

        try {
          const response = await fetch(`${baseImageUrl}/${item.sha}${collection.hasTransparents ? '_transparent' : ''}`);
          if (response.ok) {
            const imageBuffer = await response.arrayBuffer();
            const img = new Image();
            await new Promise<void>((resolve, reject) => {
              img.onload = () => {
                ctx.drawImage(img, x, startY, itemSize, itemSize);
                resolve();
              };
              img.onerror = reject;
              img.src = Buffer.from(imageBuffer);
            }).catch(() => {
              ctx.fillStyle = 'rgba(0,0,0,0.2)';
              ctx.fillRect(x, startY, itemSize, itemSize);
            });
          }
        } catch (err) {
          ctx.fillStyle = 'rgba(0,0,0,0.2)';
          ctx.fillRect(x, startY, itemSize, itemSize);
        }
      }
    }

    try {
      const logo = new Image();
      const logoSrc = path.join(__dirname, '../../../_static/mmlogo.png');
      await new Promise<void>(async (resolve, reject) => {
        logo.onload = () => {
          ctx.drawImage(
            logo,
            35,
            topBarHeight + 35,
            400,
            100
          );
          resolve();
        };
        logo.onerror = reject;
        logo.src = Buffer.from(await readFile(logoSrc));
      }).catch(() => {
        Logger.error('Failed to load logo');
      });
    } catch (err) {
      Logger.error('Failed to load logo:', err);
    }

    const buffer = canvas.toBuffer('image/png');
    return buffer;
  }
}
