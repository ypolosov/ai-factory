// Лёгкая основа русского и английского слова для поиска без морфологии: снять частое окончание
// и приставку "не", взять первые 6 букв. Грубо, но "призы" и "приз", "невостребованные" и
// "не востребован" совпадают.
const ENDINGS = [
  'иями',
  'ями',
  'ами',
  'его',
  'ого',
  'ему',
  'ому',
  'ыми',
  'ими',
  'ией',
  'ией',
  'иях',
  'ах',
  'ях',
  'ов',
  'ев',
  'ей',
  'ам',
  'ям',
  'ом',
  'ем',
  'ой',
  'ий',
  'ый',
  'ая',
  'яя',
  'ое',
  'ее',
  'ые',
  'ие',
  'ую',
  'юю',
  'ия',
  'ть',
  'ся',
  'ing',
  'ed',
  'es',
  'а',
  'я',
  'о',
  'е',
  'ы',
  'и',
  'у',
  'ю',
  'ь',
  's',
];

// dropNe - снять "не": для сравнения основ; для поиска по началу слова в трекере - нет.
export function stem(word: string, dropNe = true): string {
  let w = word.toLowerCase();
  if (dropNe && w.startsWith('не') && w.length > 7) w = w.slice(2);
  const end = ENDINGS.find((e) => w.endsWith(e) && w.length - e.length >= 3);
  if (end) w = w.slice(0, -end.length);
  return w.slice(0, 6);
}

export const words = (text: string): string[] => text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [];

export const stems = (text: string): Set<string> => new Set(words(text).map((w) => stem(w)));
