import { DurableObject } from "cloudflare:workers";
import { VehicleActor } from "../actors/vehicle";
import { toAppEnv } from "../platform/cloudflare/env";

/**
 * Cloudflare shell around `VehicleActor`: the class the VEHICLE_DO binding
 * names, one delegating method per RPC. The actor body lives in
 * src/actors/vehicle.ts and knows nothing about Durable Objects —
 * `ctx.storage` satisfies its `ActorStorage` port as-is, alarm included.
 */
export class VehicleDO extends DurableObject<Env> {
  private readonly actor = new VehicleActor(this.ctx.storage, toAppEnv(this.env));

  ensureRunning(carId: number) {
    return this.actor.ensureRunning(carId);
  }

  restartVolvo(carId: number) {
    return this.actor.restartVolvo(carId);
  }

  pollDue(carId: number) {
    return this.actor.pollDue(carId);
  }

  stop(carId: number) {
    return this.actor.stop(carId);
  }

  getSummary() {
    return this.actor.getSummary();
  }

  suspendLogging() {
    return this.actor.suspendLogging();
  }

  resumeLogging() {
    return this.actor.resumeLogging();
  }

  wake() {
    return this.actor.wake();
  }

  sendDestination(text: string) {
    return this.actor.sendDestination(text);
  }

  override alarm() {
    return this.actor.alarm();
  }
}
