import { pinyin } from 'pinyin-pro';

export function normalize(text) {
  return text.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}
export function isDismiss(text, phrases) {
  const heard = normalize(text);
  const syllables = (value) => pinyin(value, { toneType: 'none', type: 'array', nonZh: 'consecutive' });
  const spoken = syllables(heard).join('\0');
  return phrases.some((phrase) => {
    const wanted = normalize(phrase);
    if (!wanted) return false;
    if (heard.includes(wanted)) return true;
    const parts = syllables(wanted);
    return parts.length >= 2 && (`\0${spoken}\0`).includes(`\0${parts.join('\0')}\0`);
  });
}
