import type { AccountDto, Provider } from "@shared/api-types";

/**
 * A make EVBook can read, as the owner meets it: a row on the picker, the title
 * of its connect screen, the mark beside its account in Settings.
 *
 * Adding a make is one entry here and one connector in `pages/Connect.tsx`
 * (which will not compile until it has one). Nothing else in the app lists
 * them — the picker, the first-run screen and the accounts card all read this.
 */
export interface Make {
  id: Provider;
  /** As an owner says it. One connection can cover sister makes: "BMW & Mini". */
  name: string;
  /** What the maker calls the sign-in EVBook reads through. */
  account: string;
  /** One line on the picker: what connecting takes. */
  needs: string;
  /** Under the connect screen's title: what kind of access this is. */
  intro: string;
  /**
   * Whether further accounts of this make can sit side by side. Where they
   * cannot, a connected make's row opens the one connection instead of a new one.
   */
  multiple: boolean;
}

export const MAKES: readonly Make[] = [
  {
    id: "tesla",
    name: "Tesla",
    account: "Tesla account",
    needs: "Two tokens, from a browser extension or a phone app.",
    intro: "Paste a token pair from a token app you trust. It is checked at once and stored encrypted.",
    multiple: true,
  },
  {
    id: "volvo",
    name: "Volvo",
    account: "Volvo ID",
    needs: "A free API key from Volvo, then your Volvo ID.",
    intro: "Read-only, through Volvo's own API: EVBook sends the car no commands.",
    multiple: false,
  },
];

export function makeOf(id: string | undefined): Make | undefined {
  return MAKES.find((make) => make.id === id);
}

/** Whose account a row is, in words: its label, else what the maker calls it. */
export function accountTitle(account: AccountDto): string {
  if (account.label) return account.label;
  return makeOf(account.provider)?.account ?? account.name;
}

/** "Tesla", "Tesla or Volvo", "Tesla, Volvo or BMW" — for a sentence that offers them all. */
export function makeNames(): string {
  const names = MAKES.map((make) => make.name);
  if (names.length < 2) return names.join("");
  return `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`;
}
