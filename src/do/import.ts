import { DurableObject } from "cloudflare:workers";
import { ImportActor } from "../actors/import";
import { toAppEnv } from "../platform/cloudflare/env";
import type { StartImportOptions } from "../platform/ports";

/**
 * Cloudflare shell around `ImportActor`: the class the IMPORT_DO binding
 * names, one delegating method per RPC. The actor body lives in
 * src/actors/import.ts and knows nothing about Durable Objects —
 * `ctx.storage` satisfies its `ActorStorage` port as-is, alarm included.
 */
export class ImportDO extends DurableObject<Env> {
  private readonly actor = new ImportActor(this.ctx.storage, toAppEnv(this.env));

  begin(label: string) {
    return this.actor.begin(label);
  }

  append(bytes: Uint8Array) {
    return this.actor.append(bytes);
  }

  uploadedBytes() {
    return this.actor.uploadedBytes();
  }

  start(options: StartImportOptions) {
    return this.actor.start(options);
  }

  status() {
    return this.actor.status();
  }

  cancel() {
    return this.actor.cancel();
  }

  resume() {
    return this.actor.resume();
  }

  discard() {
    return this.actor.discard();
  }

  override alarm() {
    return this.actor.alarm();
  }
}
