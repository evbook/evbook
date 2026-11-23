import type { Provider } from "@shared/api-types";
import type { AppEnv } from "../platform/env";
import type { ActorStorage } from "../platform/ports";
import { PleosPoller } from "./pleosPoll";
import type { ProviderPoller } from "./providerPoll";
import { SkodaPoller } from "./skodaPoll";
import { TeslaPoller } from "./teslaPoll";
import { VolvoPoller } from "./volvoPoll";

/**
 * Every provider's poller. Keyed by `Provider`, so a provider added to the
 * `Provider` type does not compile until it can be polled.
 */
const POLLERS: Record<Provider, (storage: ActorStorage, env: AppEnv) => ProviderPoller> = {
  tesla: (storage, env) => new TeslaPoller(storage, env),
  volvo: (storage, env) => new VolvoPoller(storage, env),
  skoda: (storage, env) => new SkodaPoller(storage, env),
  pleos: (storage, env) => new PleosPoller(storage, env),
};

/** The poller for a car's provider; null for a provider this build does not know. */
export function pollerFor(
  provider: string | null | undefined,
  storage: ActorStorage,
  env: AppEnv,
): ProviderPoller | null {
  const make = provider && Object.hasOwn(POLLERS, provider) ? POLLERS[provider as Provider] : null;
  return make ? make(storage, env) : null;
}
