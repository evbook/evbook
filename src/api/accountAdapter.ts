import type { AccountDto, Provider } from "@shared/api-types";
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

/** A provider whose account is a key the owner pasted, kept in a table of its own. */
export interface KeyAccounts {
  /** Its key table is `<provider>_keys`: one row per account, with `account` and `refused_reason`. */
  provider: Provider;
  /** The words for a key the maker refuses, from the stored reason; null while it works. */
  refusal(reason: string | null): string | null;
  /** Whatever else is kept for the key outside its table (a token held by an actor). */
  forget?(env: AppEnv, name: string): Promise<void>;
}

/**
 * The adapter of such a provider. Each key is an account of its own: signed
 * in while the maker accepts it. Removing one forgets the key and switches its
 * cars' logging off, so nothing keeps waking for a car that can no longer be
 * read; connecting the key again switches them back on.
 */
export function keyAccounts({ provider, refusal, forget }: KeyAccounts): AccountAdapter {
  const table = `${provider}_keys`;
  return {
    async list(env, rows, cars) {
      const keys = await env.DB.prepare(`SELECT account, refused_reason FROM ${table}`).all<{
        account: string;
        refused_reason: string | null;
      }>();
      const reasonOf = new Map(keys.results.map((k) => [k.account, k.refused_reason]));
      return rows.map((row) => {
        const reason = reasonOf.get(row.name);
        return {
          name: row.name,
          provider,
          label: row.label,
          // No key row at all is not signed in either.
          signedIn: reason === null,
          pending: false,
          lastError: refusal(reason ?? null),
          cars: cars.get(row.name) ?? 0,
        };
      });
    },
    async remove(env, name) {
      const cars = await env.DB.prepare("SELECT id FROM cars WHERE account = ? AND provider = ?")
        .bind(name, provider)
        .all<{ id: number }>();
      await env.DB.batch([
        env.DB.prepare(
          "UPDATE car_settings SET enabled = 0 WHERE car_id IN (SELECT id FROM cars WHERE account = ? AND provider = ?)",
        ).bind(name, provider),
        env.DB.prepare(`DELETE FROM ${table} WHERE account = ?`).bind(name),
      ]);
      await forget?.(env, name);
      for (const car of cars.results) await env.actors.vehicle(car.id).stop(car.id);
    },
  };
}
