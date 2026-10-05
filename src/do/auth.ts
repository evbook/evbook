import { DurableObject } from "cloudflare:workers";
import { AuthActor } from "../actors/auth";
import { toAppEnv } from "../platform/cloudflare/env";

/**
 * Cloudflare shell around `AuthActor`: the class the AUTH_DO binding names,
 * one delegating method per RPC. The actor body lives in src/actors/auth.ts
 * and knows nothing about Durable Objects — `ctx.storage` satisfies its
 * `ActorStorage` port as-is, alarm included.
 */
export class AuthDO extends DurableObject<Env> {
  private readonly actor = new AuthActor(this.ctx.storage, toAppEnv(this.env));

  signIn(accessToken: string, refreshToken: string) {
    return this.actor.signIn(accessToken, refreshToken);
  }

  signOut() {
    return this.actor.signOut();
  }

  status() {
    return this.actor.status();
  }

  getAccessToken() {
    return this.actor.getAccessToken();
  }

  getAccessContext() {
    return this.actor.getAccessContext();
  }

  getApiHost() {
    return this.actor.getApiHost();
  }

  forceRefresh() {
    return this.actor.forceRefresh();
  }

  override alarm() {
    return this.actor.alarm();
  }
}
