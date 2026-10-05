import { describe, expect, it } from "vitest";
import { readZipEntries, readZipEntry } from "./zip";
import { buildZip, bytesReader } from "../../../test/zipfile";

async function textOf(bytes: Uint8Array, path: string): Promise<string> {
  const reader = bytesReader(bytes);
  const entry = (await readZipEntries(reader)).find((candidate) => candidate.path === path)!;
  const decoder = new TextDecoder();
  let out = "";
  for await (const chunk of readZipEntry(reader, entry)) out += decoder.decode(chunk, { stream: true });
  return out + decoder.decode();
}

describe("zip reading", () => {
  it("lists entries from the central directory", async () => {
    const bytes = await buildZip([
      { name: "driving_states.csv", content: "a,b\n1,2\n" },
      { name: "charging_states.csv", content: "c,d\n3,4\n", deflate: true },
    ]);
    const entries = await readZipEntries(bytesReader(bytes));
    expect(entries.map((entry) => entry.path)).toEqual(["driving_states.csv", "charging_states.csv"]);
    expect(entries[0]!.method).toBe(0);
    expect(entries[1]!.method).toBe(8);
    expect(entries[0]!.uncompressedSize).toBe(8);
  });

  it("reads a stored entry", async () => {
    const bytes = await buildZip([{ name: "a.csv", content: "hello,world\n" }]);
    expect(await textOf(bytes, "a.csv")).toBe("hello,world\n");
  });

  it("reads a deflated entry, including one larger than a read chunk", async () => {
    const long = "row,value\n" + Array.from({ length: 40_000 }, (_, i) => `${i},x\n`).join("");
    const bytes = await buildZip([{ name: "big.csv", content: long, deflate: true }]);
    expect(await textOf(bytes, "big.csv")).toBe(long);
  });

  it("reads entries in nested folders and skips directory and macOS entries", async () => {
    const bytes = await buildZip([
      { name: "export/", content: "" },
      { name: "export/driving_states.csv", content: "x\n" },
      { name: "__MACOSX/export/._driving_states.csv", content: "junk" },
    ]);
    const entries = await readZipEntries(bytesReader(bytes));
    expect(entries.map((entry) => entry.path)).toEqual(["export/driving_states.csv"]);
  });

  it("rejects something that is not a zip", async () => {
    const bytes = new TextEncoder().encode("just some text, not an archive at all");
    await expect(readZipEntries(bytesReader(bytes))).rejects.toThrow(/not a zip file/);
  });
});
