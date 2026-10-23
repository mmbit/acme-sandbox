// Numbers a customer reads out on the phone and types from an email, each ending in a Damm check digit: a digit
// misheard or two swapped never makes another valid number. HQ gives every paid basket an order number (6 random digits
// and the check, 7 in all: the confirmation's subject and body, the order page), and a company may give numbers of its
// own with the same check (another length tells them apart). Plain JS: pages import it by its path, servers the same file.

const DAMM = [
  '0317598642',
  '7092154863',
  '4206871359',
  '1750983426',
  '6123045978',
  '3674209581',
  '5869720134',
  '8945362017',
  '9438617205',
  '2581436790',
].map(row => [...row].map(Number));
const dammOf = digits => [...digits].reduce((i, d) => DAMM[i][Number(d)], 0);

// Digits and their check digit
export const withCheck = digits => digits + String(dammOf(digits));
// Digits, two or more, whose last is their check digit
export const checkOk = digits => typeof digits === 'string' && /^\d{2,}$/.test(digits) && dammOf(digits) === 0;
// A new number of this many digits, the check included (unique only once the caller checks it isn't taken). Each
// random digit is a byte below 250 taken mod 10, so every digit is as likely.
export function newNumber(length = LENGTH) {
  const byte = new Uint8Array(1);
  let digits = '';
  while (digits.length < length - 1) {
    crypto.getRandomValues(byte);
    if (byte[0] < 250) digits += String(byte[0] % 10);
  }
  return withCheck(digits);
}

// A basket's order number, as HQ gives it
export const LENGTH = 7;
export const numberOk = number => checkOk(number) && number.length === LENGTH;
// A basket's order number as said or typed, its spaces, dashes and dots left out, when it is one
export function numberOf(said) {
  const digits = String(said ?? '').replace(/[\s.-]/g, '');
  return numberOk(digits) ? digits : null;
}
// A number as it's read out, its last four digits a group of their own: 482 9173, 1234 5678. space: a page's no-break
// space ('\u00a0'), so it never breaks over two lines.
export const spaced = (number, space = ' ') => `${number.slice(0, -4)}${space}${number.slice(-4)}`;
