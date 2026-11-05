import {
  CustomSource, EncodedAudioPacketSource, EncodedPacketSink, EncodedVideoPacketSource,
  Input, MP4, Mp4OutputFormat, Output, StreamTarget, type InputVideoTrack,
} from "mediabunny";
import { prepareCruiseCodec } from "./cruise-codec";
import { cruiseAudioKey } from "./template-assets";

const cutSeconds = 13.7;
const endSeconds = 26.554;
const partSize = 5 * 1024 * 1024;

function openTrackFile(bucket: R2Bucket, key: string) {
  return new Input({
    formats: [MP4],
    source: new CustomSource({
      prefetchProfile: "network",
      maxCacheSize: 2 * 1024 * 1024,
      async getSize() {
        const object = await bucket.head(key);
        if (!object) throw new Error("Assembly input missing");
        return object.size;
      },
      async read(start, end) {
        const object = await bucket.get(key, { range: { offset: start, length: end - start } });
        if (!object) throw new Error("Assembly input missing");
        return object.body;
      },
    }),
  });
}

// A regular MP4 patches the size of its opening mdat after writing the tracks.
// Retain that first part until finalize, streaming the rest directly to R2.
function mp4Target(upload: R2MultipartUpload) {
  const header = new Uint8Array(partSize);
  const buffer = new Uint8Array(partSize);
  const parts: R2UploadedPart[] = [];
  let length = 0;
  let used = 0;
  return new StreamTarget(new WritableStream({
    async write({ position, data }) {
      let offset = 0;
      if (position < partSize) {
        offset = Math.min(data.byteLength, partSize - position);
        header.set(data.subarray(0, offset), position);
        position += offset;
        length = Math.max(length, position);
      }
      if (offset < data.length && position !== length) throw new Error("Unexpected MP4 write position");
      while (offset < data.length) {
        const count = Math.min(partSize - used, data.length - offset);
        buffer.set(data.subarray(offset, offset + count), used);
        used += count;
        length += count;
        offset += count;
        if (used === partSize) {
          parts.push(await upload.uploadPart(parts.length + 2, buffer));
          used = 0;
        }
      }
    },
    async close() {
      if (used) parts.push(await upload.uploadPart(parts.length + 2, buffer.subarray(0, used)));
      const first = await upload.uploadPart(1, header.subarray(0, Math.min(length, partSize)));
      await upload.complete([first, ...parts]);
    },
  }));
}

async function addScene(track: InputVideoTrack, source: EncodedVideoPacketSource, start: number, end: number, keyPrefix?: Uint8Array) {
  const [firstTimestamp, lastTimestamp] = await Promise.all([track.getFirstTimestamp(), track.computeDuration()]);
  if (!(lastTimestamp > firstTimestamp)) throw new Error("Empty generated scene");
  // Fit the complete performance into its original time slot, including the last reaction.
  const scale = (end - start) / (lastTimestamp - firstTimestamp);
  for await (const packet of new EncodedPacketSink(track).packets()) {
    await source.add(packet.clone({
      ...(keyPrefix && packet.type === "key" ? { data: Buffer.concat([keyPrefix, packet.data]) } : {}),
      timestamp: start + (packet.timestamp - firstTimestamp) * scale,
      duration: packet.duration * scale,
    }));
  }
}

export async function assembleCruiseVideo(bucket: R2Bucket, firstKey: string, secondKey: string, outputKey: string) {
  const files = [firstKey, secondKey, cruiseAudioKey].map(key => openTrackFile(bucket, key));
  let upload: R2MultipartUpload | undefined;
  try {
    const [first, second, audio] = await Promise.all([
      files[0].getPrimaryVideoTrack(), files[1].getPrimaryVideoTrack(), files[2].getPrimaryAudioTrack(),
    ]);
    if (!first || !second || !audio) throw new Error("Missing template track");
    const [codec, otherCodec, firstConfig, secondConfig, audioConfig, audioCodec] = await Promise.all([
      first.getCodec(), second.getCodec(), first.getDecoderConfig(), second.getDecoderConfig(),
      audio.getDecoderConfig(), audio.getCodec(),
    ]);
    if (!codec || codec !== otherCodec || !firstConfig || !secondConfig || !audioConfig || !audioCodec) {
      throw new Error("Missing or incompatible generated tracks");
    }
    const prepared = prepareCruiseCodec(codec, firstConfig, secondConfig);
    const videoSource = new EncodedVideoPacketSource(codec);
    const audioSource = new EncodedAudioPacketSource(audioCodec);
    upload = await bucket.createMultipartUpload(outputKey, { httpMetadata: { contentType: "video/mp4" } });
    const output = new Output({ format: new Mp4OutputFormat({ fastStart: false }), target: mp4Target(upload) });
    output.addVideoTrack(videoSource, { decoderConfig: prepared.decoderConfig });
    output.addAudioTrack(audioSource, { decoderConfig: audioConfig });
    await output.start();
    async function addAudio() {
      for await (const packet of new EncodedPacketSink(audio!).packets()) {
        if (packet.timestamp >= endSeconds) break;
        await audioSource.add(packet.clone({ duration: Math.min(packet.duration, endSeconds - packet.timestamp) }));
      }
      audioSource.close();
    }
    async function addVideo() {
      await addScene(first!, videoSource, 0, cutSeconds, prepared.keyPrefixes?.[0]);
      await addScene(second!, videoSource, cutSeconds, endSeconds, prepared.keyPrefixes?.[1]);
      videoSource.close();
    }
    try {
      await Promise.all([addVideo(), addAudio()]);
      await output.finalize();
    } catch (error) {
      await output.cancel().catch(() => {});
      throw error;
    }
  } catch (error) {
    await upload?.abort().catch(() => {});
    throw error;
  } finally {
    for (const file of files) file.dispose();
  }
}
