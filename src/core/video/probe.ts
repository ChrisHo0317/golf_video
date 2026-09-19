import { createFile, MP4BoxBuffer, type ISOFile, type Movie } from 'mp4box';
import { loadVideo } from './videoElement';

export interface ProbeResult {
  durationSec: number;
  fps: number;
  /** 旋轉後的顯示寬高 */
  width: number;
  height: number;
  rotation: 0 | 90 | 180 | 270;
  codec: string | null;
  /** mp4box 可解析（可走 WebCodecs 路徑） */
  demuxable: boolean;
}

const CHUNK = 4 * 1024 * 1024;

/** 以 mp4box 解析 MP4/MOV；回傳 ISOFile 與影片資訊 */
export async function demux(file: Blob, keepData: boolean): Promise<{ iso: ISOFile; info: Movie } | null> {
  const iso = createFile(keepData);
  let info: Movie | null = null;
  let failed = false;
  iso.onReady = (i) => {
    info = i;
  };
  iso.onError = () => {
    failed = true;
  };
  let offset = 0;
  while (offset < file.size && !failed) {
    const buf = await file.slice(offset, offset + CHUNK).arrayBuffer();
    const mb = MP4BoxBuffer.fromArrayBuffer(buf, offset);
    iso.appendBuffer(mb, offset + buf.byteLength >= file.size);
    offset += buf.byteLength;
    // 不需要樣本資料時，拿到 moov 即可停止
    if (!keepData && info) break;
  }
  iso.flush();
  if (failed || !info) return null;
  return { iso, info };
}

function rotationFromMatrix(m: ArrayLike<number>): 0 | 90 | 180 | 270 {
  const a = m[0] / 65536;
  const b = m[1] / 65536;
  const deg = Math.round((Math.atan2(b, a) * 180) / Math.PI);
  const r = ((deg % 360) + 360) % 360;
  return (r === 90 || r === 180 || r === 270 ? r : 0) as 0 | 90 | 180 | 270;
}

export async function probeVideo(file: Blob): Promise<ProbeResult> {
  try {
    const d = await demux(file, false);
    const track = d?.info.videoTracks[0];
    if (d && track) {
      const rotation = rotationFromMatrix(track.matrix);
      const w = track.video?.width ?? track.track_width;
      const h = track.video?.height ?? track.track_height;
      const durationSec = track.duration / track.timescale || d.info.duration / d.info.timescale;
      const fps = track.nb_samples / durationSec;
      const swap = rotation === 90 || rotation === 270;
      return {
        durationSec,
        fps: Math.round(fps * 100) / 100,
        width: swap ? h : w,
        height: swap ? w : h,
        rotation,
        codec: track.codec,
        demuxable: true,
      };
    }
  } catch {
    // 交給 <video> 降級解析
  }
  return probeWithElement(file);
}

async function probeWithElement(file: Blob): Promise<ProbeResult> {
  const { video, dispose } = await loadVideo(file, 10000);
  try {
    return {
      durationSec: video.duration,
      fps: 60,
      width: video.videoWidth,
      height: video.videoHeight,
      rotation: 0,
      codec: null,
      demuxable: false,
    };
  } finally {
    dispose();
  }
}
