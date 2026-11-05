import type { InputVideoTrack, VideoCodec } from "mediabunny";

type Config = NonNullable<Awaited<ReturnType<InputVideoTrack["getDecoderConfig"]>>>;
type JoinedConfig = { decoderConfig: Config; keyPrefixes?: [Uint8Array, Uint8Array] };

function descriptionBytes(description: Config["description"]) {
  if (!description) return Buffer.alloc(0);
  return ArrayBuffer.isView(description)
    ? Buffer.from(description.buffer, description.byteOffset, description.byteLength)
    : Buffer.from(description);
}

// ISO/IEC 14496-15: avcC stores parameter sets with 16-bit lengths, whereas
// avc3 samples use the NAL length width specified in the configuration record.
function avcKeyPrefix(config: Buffer, lengthWidth: number) {
  if (config.length < 7 || config[0] !== 1 || lengthWidth === 3) throw new Error("Invalid AVC configuration");
  const blocks: Buffer[] = [];
  let offset = 6;
  function appendSets(count: number, type: number) {
    for (let i = 0; i < count; i++) {
      const size = config.readUInt16BE(offset);
      offset += 2;
      if (!size || offset + size > config.length || (config[offset] & 31) !== type) throw new Error("Invalid AVC parameter set");
      const length = Buffer.alloc(lengthWidth);
      length.writeUIntBE(size, 0, lengthWidth);
      blocks.push(length, config.subarray(offset, offset + size));
      offset += size;
    }
  }
  const spsCount = config[5] & 31;
  appendSets(spsCount, 7);
  const ppsCount = config.readUInt8(offset++);
  appendSets(ppsCount, 8);
  if (!spsCount || !ppsCount) throw new Error("Missing AVC parameter sets");
  if (offset < config.length) {
    // Optional high-profile chroma and bit-depth metadata precedes the SPS extensions.
    offset += 3;
    appendSets(config.readUInt8(offset++), 13);
  }
  if (offset !== config.length) throw new Error("Invalid AVC configuration length");
  return Buffer.concat(blocks);
}

export function prepareCruiseCodec(codec: VideoCodec, first: Config, second: Config): JoinedConfig {
  if (first.codedWidth !== second.codedWidth || first.codedHeight !== second.codedHeight
    || first.displayAspectWidth !== second.displayAspectWidth || first.displayAspectHeight !== second.displayAspectHeight
    || first.codec !== second.codec) throw new Error("Incompatible generated video tracks");

  const firstBytes = descriptionBytes(first.description);
  const secondBytes = descriptionBytes(second.description);
  if (firstBytes.equals(secondBytes)) return { decoderConfig: first };

  // AVC can carry updated parameter sets in-band. Prefix every sync sample so
  // that starting playback or seeking directly into either scene is decodable.
  if (codec !== "avc" || firstBytes.length < 7 || secondBytes.length < 7
    || !firstBytes.subarray(0, 5).equals(secondBytes.subarray(0, 5))) {
    throw new Error("Incompatible generated video configurations");
  }
  const lengthWidth = 1 + (firstBytes[4] & 3);
  return {
    decoderConfig: { ...first, codec: first.codec.replace(/^avc[13]\./, "avc3.") },
    keyPrefixes: [avcKeyPrefix(firstBytes, lengthWidth), avcKeyPrefix(secondBytes, lengthWidth)],
  };
}
