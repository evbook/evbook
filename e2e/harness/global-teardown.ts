import { stopAll } from "./processes";

/** Set E2E_KEEP_RUNNING=1 to leave the stack up and poke at it by hand. */
export default async function globalTeardown(): Promise<void> {
  if (process.env.E2E_KEEP_RUNNING === "1") {
    console.log("[e2e] leaving the stack running (E2E_KEEP_RUNNING=1); stop it with: npm run e2e:stop");
    return;
  }
  stopAll();
}
