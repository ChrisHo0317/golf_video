import { createFile, type Box, type BoxKind, type Sample } from 'mp4box';
import { demux } from './probe';

export interface TrimmedVideo {
  blob: Blob;
  /** 新檔案的起點對應原片的媒體時間（秒） */
  offset: number;
  durationSec: number;
}

type SampleEntry = Box & { type: string } & Record<string, Box | undefined>;

/**
 * 以重新封裝（不重新編碼、不失真）裁切 MP4：保留 [start, end] 的影像樣本。
 * 起點會往前對齊到最近的關鍵格，否則裁切後的開頭解不出畫面；音軌不保留。
 * 無法解析或幾乎沒得裁時回傳 null，由呼叫端沿用原檔。
 */
export async function trimVideo(file: Blob, start: number, end: number): Promise<TrimmedVideo | null> {
  const d = await demux(file, true).catch(() => null);
  const track = d?.info.videoTracks[0];
  if (!d || !track) return null;
  const trak = d.iso.getTrackById(track.id);
  const entry = trak.mdia.minf.stbl.stsd.entries[0] as unknown as SampleEntry;
  if (!entry) return null;

  const samples: Sample[] = [];
  d.iso.onSamples = (_id, _user, s) => {
    for (const x of s) samples.push(x);
  };
  d.iso.setExtractionOptions(track.id, null, { nbSamples: Number.MAX_SAFE_INTEGER });
  d.iso.start();
  d.iso.flush();
  if (samples.length < 2) return null;

  const ts = samples[0].timescale;
  const minCts = Math.min(...samples.map((s) => s.cts));
  const timeOf = (cts: number) => (cts - minCts) / ts;

  let first = 0;
  for (let i = 0; i < samples.length; i++) if (samples[i].is_sync && timeOf(samples[i].cts) <= start + 1e-4) first = i;
  let last = first;
  for (let i = first; i < samples.length; i++) if (timeOf(samples[i].cts) <= end + 1e-4) last = i;
  const kept = last - first + 1;
  // 幾乎整部都要保留就不必重新封裝
  if (kept < 2 || kept > samples.length * 0.95) return null;

  const out = createFile();
  const config = entry.avcC ?? entry.hvcC ?? entry.vpcC ?? entry.av1C;
  const extras = [config, entry.pasp, entry.colr].filter((b): b is Box => !!b) as unknown as BoxKind[];
  const id = out.addTrack({
    type: entry.type as NonNullable<Parameters<typeof out.addTrack>[0]>['type'],
    timescale: ts,
    width: track.track_width,
    height: track.track_height,
    language: track.language,
    description_boxes: extras,
  });
  if (!id) return null;
  // addTrack 會寫入單位矩陣，旋轉資訊要從原片複製過來，否則播放方向會不同
  const newTrak = out.moov?.traks[out.moov.traks.length - 1];
  if (newTrak && trak.tkhd?.matrix) newTrak.tkhd.matrix = trak.tkhd.matrix;

  const base = Math.min(samples[first].dts, samples[first].cts);
  for (let i = first; i <= last; i++) {
    const s = samples[i];
    out.addSample(id, s.data as Uint8Array<ArrayBuffer>, {
      duration: s.duration,
      dts: s.dts - base,
      cts: s.cts - base,
      is_sync: s.is_sync,
    });
  }

  const buffer = out.getBuffer().buffer as ArrayBuffer;
  const offset = timeOf(samples[first].cts);
  const durationSec = timeOf(samples[last].cts) + samples[last].duration / ts - offset;
  return { blob: new Blob([buffer], { type: 'video/mp4' }), offset, durationSec };
}
