import assert from "node:assert/strict";
import { test } from "node:test";
import { prepareCruiseCodec } from "../src/cruise-codec";

test("signals in-band AVC parameters for independently encoded scenes", () => {
  // Small configuration records with different SPS/PPS IDs and four-byte NAL lengths.
  const config = (record: string) => ({
    codec: "avc1.64001f", codedWidth: 960, codedHeight: 720, description: Buffer.from(record, "hex"),
  });
  const opening = config("0164001fffe1000267a101000268a2fdf8f800");
  const finale = config("0164001fffe1000267b101000268b2fdf8f800");

  assert.deepEqual(prepareCruiseCodec("avc", opening, opening), { decoderConfig: opening });
  const pair = prepareCruiseCodec("avc", opening, finale);
  assert.equal(pair.decoderConfig.codec, "avc3.64001f");
  assert.deepEqual(pair.keyPrefixes?.map(bytes => Buffer.from(bytes).toString("hex")), [
    "0000000267a10000000268a2", "0000000267b10000000268b2",
  ]);
  assert.throws(() => prepareCruiseCodec("avc", opening, config("0164001fffe1000567")), /Invalid AVC/);
  assert.throws(() => prepareCruiseCodec("avc", opening, { ...finale, codedWidth: 1280 }), /Incompatible/);
});
