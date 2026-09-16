import type { ClubType } from '../types';

export const CLUBS: ClubType[] = ['driver', 'wood', 'hybrid', 'iron', 'wedge', 'putter'];

const CLUB_LABEL: Record<ClubType, [string, string]> = {
  driver: ['一號木', 'Driver'],
  wood: ['球道木', 'Fairway wood'],
  hybrid: ['混血桿', 'Hybrid'],
  iron: ['鐵桿', 'Iron'],
  wedge: ['挖起桿', 'Wedge'],
  putter: ['推桿', 'Putter'],
};

export const clubLabel = (c: ClubType, lang: string) => CLUB_LABEL[c][lang === 'en' ? 1 : 0];
