import type { FrameData } from '../types';

const KEYS = ['t', 'mediaT', 'pose2d', 'pose3d', 'clubRaw', 'clubRawSource', 'club', 'clubSource', 'clubCands'] as const;
type Key = (typeof KEYS)[number];
type TA = Float64Array | Float32Array | Uint8Array;
const CTORS = { Float64Array, Float32Array, Uint8Array } as const;

interface Header {
  v: 1;
  n: number;
  arrays: { key: Key; type: keyof typeof CTORS; offset: number; length: number }[];
}

async function pipe(data: Uint8Array | Blob, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const blob = data instanceof Blob ? data : new Blob([data as BlobPart]);
  const out = await new Response(blob.stream().pipeThrough(stream)).arrayBuffer();
  return new Uint8Array(out);
}

export async function encodeFrames(fd: FrameData): Promise<Blob> {
  const arrays: Header['arrays'] = [];
  let offset = 0;
  for (const key of KEYS) {
    const a = fd[key] as TA | undefined;
    if (!a) continue;
    arrays.push({ key, type: a.constructor.name as keyof typeof CTORS, offset, length: a.length });
    offset += a.byteLength;
  }
  const header: Header = { v: 1, n: fd.n, arrays };
  const hBytes = new TextEncoder().encode(JSON.stringify(header));
  const body = new Uint8Array(4 + hBytes.length + offset);
  new DataView(body.buffer).setUint32(0, hBytes.length, true);
  body.set(hBytes, 4);
  const base = 4 + hBytes.length;
  for (const a of arrays) {
    const src = fd[a.key] as TA;
    body.set(new Uint8Array(src.buffer, src.byteOffset, src.byteLength), base + a.offset);
  }
  // 舊版 iOS（16.4 以前）沒有 CompressionStream：改存未壓縮資料並加上標記
  if (typeof CompressionStream === 'undefined') {
    return new Blob([RAW_MAGIC as BlobPart, body as BlobPart], { type: 'application/octet-stream' });
  }
  const gz = await pipe(body, new CompressionStream('gzip'));
  return new Blob([gz as BlobPart], { type: 'application/octet-stream' });
}

/** 未壓縮資料的開頭標記 */
const RAW_MAGIC = new TextEncoder().encode('SWL0');

async function readBody(blob: Blob): Promise<Uint8Array> {
  const head = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
  if (head.length === 4 && head.every((b, i) => b === RAW_MAGIC[i])) return new Uint8Array(await blob.slice(4).arrayBuffer());
  if (typeof DecompressionStream === 'undefined') throw new Error('decompression-unsupported');
  return pipe(blob, new DecompressionStream('gzip'));
}

export async function decodeFrames(blob: Blob): Promise<FrameData> {
  const body = await readBody(blob);
  const hLen = new DataView(body.buffer, body.byteOffset).getUint32(0, true);
  const header = JSON.parse(new TextDecoder().decode(body.subarray(4, 4 + hLen))) as Header;
  const base = 4 + hLen;
  const fd = { n: header.n } as FrameData;
  for (const a of header.arrays) {
    const Ctor = CTORS[a.type];
    const bytes = body.slice(base + a.offset, base + a.offset + a.length * Ctor.BYTES_PER_ELEMENT);
    (fd as unknown as Record<Key, TA>)[a.key] = new Ctor(bytes.buffer);
  }
  return fd;
}

export function cloneFrames(fd: FrameData): FrameData {
  const out = { n: fd.n } as FrameData;
  for (const k of KEYS) {
    const a = fd[k] as TA | undefined;
    if (a) (out as unknown as Record<Key, TA>)[k] = a.slice();
  }
  return out;
}
