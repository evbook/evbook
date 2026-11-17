import type { AppEnv } from "../platform/env";
import type { ActorStorage } from "../platform/ports";
import type { PolledProvider, ProviderPoller } from "./providerPoll";
import { SkodaPoller } from "./skodaPoll";
import { VolvoPoller } from "./volvoPoll";

/**
 * Every polled provider's poller. Keyed by `PolledProvider`, so a provider
 * added to the `Provider` type does not compile until it can be polled.
 */
const POLLERS: Record<PolledProvider, (storage: ActorStorage, env: AppEnv) => ProviderPoller> = {
  volvo: (storage, env) => new VolvoPoller(storage, env),
  skoda: (storage, env) => new SkodaPoller(storage, env),
};

/** The poller for a car's provider; null for a Tesla, and for a provider this build does not know. */
export function pollerFor(
  provider: string | null | undefined,
  storage: ActorStorage,
  env: AppEnv,
): ProviderPoller | null {
  const make = provider && Object.hasOwn(POLLERS, provider) ? POLLERS[provider as PolledProvider] : null;
  return make ? make(storage, env) : null;
}
