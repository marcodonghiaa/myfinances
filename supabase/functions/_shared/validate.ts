// Input checks for the browser-facing bank functions. Kept free of Deno APIs so the test runs anywhere.

// Enable Banking takes ISO 3166 alpha-2 codes, upper case ("IT"), as the Accounts page sends them.
export const isCountryCode = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Z]{2}$/.test(value);

// Bank names come from list-banks; the cap only stops oversized junk reaching the upstream API.
export const MAX_BANK_NAME_LENGTH = 100;
export const isBankName = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "" && value.length <= MAX_BANK_NAME_LENGTH;

// Unexpired consent requests one user may have open at once; start-bank-consent refuses more.
export const MAX_OPEN_CONSENTS = 5;
