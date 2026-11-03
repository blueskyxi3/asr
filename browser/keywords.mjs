import { pinyin } from 'pinyin-pro';

// sherpa's zh-en token table contains toned Mandarin initials/finals and English phones.
export function encodeKeywords(phrases, tokenText, phoneText) {
  const tokens = new Set(tokenText.trim().split('\n').map((line) => line.split(/\s+/)[0]));
  const lexicon = new Map(phoneText.trim().split('\n').map((line) => {
    const [word, ...phones] = line.trim().split(/\s+/); return [word, phones];
  }));
  const split = (syllable) => {
    const candidates = [[syllable], [syllable.slice(0, 2), syllable.slice(2)], [syllable.slice(0, 1), syllable.slice(1)]];
    const found = candidates.find((parts) => parts.every((part) => part && tokens.has(part)));
    if (!found) throw new Error(`Unsupported pronunciation: ${syllable}`);
    return found;
  };
  return phrases.map((phrase, index) => {
    if (!/^[\p{Script=Han}A-Za-z\s'-]+$/u.test(phrase)) throw new Error(`Unsupported wake word: ${phrase}`);
    const encoded = [];
    for (const part of phrase.match(/[\p{Script=Han}]+|[A-Za-z][A-Za-z'-]*/gu) || []) {
      if (/\p{Script=Han}/u.test(part)) {
        for (const syllable of pinyin(part, { toneType: 'symbol', type: 'array' })) encoded.push(...split(syllable));
      } else {
        const phones = lexicon.get(part.toUpperCase());
        if (!phones?.length || !phones.every((phone) => tokens.has(phone))) throw new Error(`Unknown English wake word: ${part}`);
        encoded.push(...phones);
      }
    }
    if (!encoded.length) throw new Error('Empty wake word');
    return `${encoded.join(' ')} @wake_${index}`;
  }).join('\n') + '\n';
}
