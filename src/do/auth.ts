import { DurableObject } from "cloudflare:workers";
import { AuthActor } from "../actors/auth";
import { VolvoAuthActor } from "../actors/volvoAuth";
import type { VolvoCredentialsInput } from "@shared/api-types";
import { toAppEnv } from "../platform/cloudflare/env";

/**
 * Cloudflare shell around `AuthActor`: the class the AUTH_DO binding names,
 * one delegating method per RPC. The actor body lives in src/actors/auth.ts
 * and knows nothing about Durable Objects — `ctx.storage` satisfies its
 * `ActorStorage` port as-is, alarm included.
 */
export class AuthDO extends DurableObject<Env> {
  private readonly actor = new AuthActor(this.ctx.storage, toAppEnv(this.env));
  /**
   * The Volvo connection lives on this same class under the instance name
   * "volvo" (cfActors), so it needed no Durable Object class — and no Cloudflare
   * migration — of its own. Each instance only ever receives one family of
   * calls; the alarm asks the Volvo actor whether this instance is its.
   */
  private readonly volvo = new VolvoAuthActor(this.ctx.storage, toAppEnv(this.env));

  signIn(accessToken: string, refreshToken: string, account?: string) {
    return this.actor.signIn(accessToken, refreshToken, account);
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

  volvoStatus() {
    return this.volvo.status();
  }

  volvoSetCredentials(input: VolvoCredentialsInput) {
    return this.volvo.setCredentials(input);
  }

  volvoClearCredentials() {
    return this.volvo.clearCredentials();
  }

  volvoBeginAuthorization(redirectUri: string) {
    return this.volvo.beginAuthorization(redirectUri);
  }

  volvoCompleteAuthorization(state: string, code: string) {
    return this.volvo.completeAuthorization(state, code);
  }

  volvoGetAccessContext() {
    return this.volvo.getAccessContext();
  }

  volvoForceRefresh() {
    return this.volvo.forceRefresh();
  }

  volvoDisconnect() {
    return this.volvo.disconnect();
  }

  override async alarm() {
    if (await this.volvo.owns()) return this.volvo.alarm();
    return this.actor.alarm();
  }
}
