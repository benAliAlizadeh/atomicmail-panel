import crypto from 'node:crypto';

const PASSWORD_GROUPS = [
  'ABCDEFGHJKLMNPQRSTUVWXYZ',
  'abcdefghijkmnopqrstuvwxyz',
  '23456789',
  '!@#$%^&*_-+=?',
];
const PASSWORD_ALPHABET = PASSWORD_GROUPS.join('');

function shuffleSecure(characters) {
  for (let index = characters.length - 1; index > 0; index -= 1) {
    const other = crypto.randomInt(index + 1);
    [characters[index], characters[other]] = [characters[other], characters[index]];
  }
  return characters;
}

export function generateAccountPassword(length = 20) {
  const safeLength = Number(length);
  if (!Number.isInteger(safeLength) || safeLength < PASSWORD_GROUPS.length || safeLength > 128) {
    throw new TypeError('Account password length must be an integer between 4 and 128');
  }

  // Keep the first character alphabetic so an exact password remains safe in
  // spreadsheet CSV consumers without formula-escaping changing its value.
  const first = PASSWORD_GROUPS[0][crypto.randomInt(PASSWORD_GROUPS[0].length)];
  const characters = PASSWORD_GROUPS.slice(1).map((group) => group[crypto.randomInt(group.length)]);
  while (characters.length < safeLength - 1) {
    characters.push(PASSWORD_ALPHABET[crypto.randomInt(PASSWORD_ALPHABET.length)]);
  }
  return `${first}${shuffleSecure(characters).join('')}`;
}
