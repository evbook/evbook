import type { AccountDto } from "@shared/api-types";
import type { AppEnv } from "../platform/env";

/**
 * What Settings → Car accounts needs from a provider. Each provider's API
 * module (`src/api/<provider>.ts`) exports one, and `ACCOUNT_ADAPTERS` in
 * accounts.ts lists them all, so `accounts.ts` itself knows no provider.
 */

/** A row of `accounts`. */
export interface AccountRow {
  name: string;
  provider: string;
  label: string | null;
}

export interface AccountAdapter {
  /**
   * The provider's accounts as Settings lists them: one per row of `accounts`
   * it owns (`rows`), plus any it keeps elsewhere (Tesla's original account,
   * a Volvo connection with no car yet). `cars` counts cars by account name.
   */
  list(env: AppEnv, rows: AccountRow[], cars: ReadonlyMap<string, number>): Promise<AccountDto[]>;
  /**
   * Forget an account's credentials, for DELETE /accounts/:name; the route
   * deletes the `accounts` row afterwards. The cars and their history stay.
   * Absent when the account is disconnected from its own card instead.
   */
  remove?(env: AppEnv, name: string): Promise<void>;
}
