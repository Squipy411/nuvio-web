import { ALL_FORMATS, Input, UrlSource, Output, Mp4OutputFormat, AppendOnlyStreamTarget,
  EncodedPacketSink, EncodedVideoPacketSource, EncodedAudioPacketSource,
  type InputVideoTrack, type InputAudioTrack, type VideoCodec, type AudioCodec } from 'mediabunny';
import { readRetryDelay } from './requestPolicy.ts';
import { describeFetchFailure } from './sourceProbe.ts';

/** No request may hang: an unanswered read left the player loading forever. */
const REQUEST_TIMEOUT_MS = 20_000;

type SourceConstructor = typeof MediaSource;
export function nativeMediaSource(): SourceConstructor | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as unknown as { ManagedMediaSource?: SourceConstructor }).ManagedMediaSource
    ?? (typeof MediaSource === 'undefined' ? undefined : MediaSource);
}
export function containsTime(ranges: TimeRanges, time: number): boolean {
  for (let i = 0; i < ranges.length; i++) {
    if (ranges.start(i) <= time && ranges.end(i) > time + 0.1) return true;
  }
  return false;
}

/** Experimental packet-copy path. No VideoDecoder, canvas, or whole-file Blob. */
export class NativeMkvPlayer {
  private input: Input;
  private video: InputVideoTrack | null = null;
  private audio: InputAudioTrack | null = null;
  private mime: string[] = [];
  private source: MediaSource | null = null;
  private objectUrl = '';
  private abort = new AbortController();
  private stopped = false;
  private target = 0;
  private initial = true;
  private outputs: Output[] = [];
  duration = 0;
  private element: HTMLVideoElement;
  private fail: (error: unknown) => void;
  private preferredLanguage: string;

  constructor(element: HTMLVideoElement, url: string,
    fail: (error: unknown) => void, headers?: Record<string, string>, preferredLanguage = '') {
    this.element = element;
    this.fail = fail;
    this.preferredLanguage = preferredLanguage;
    this.input = new Input({ formats: ALL_FORMATS, source: new UrlSource(url, {
      maxCacheSize: 16 * 1024 * 1024, getRetryDelay: readRetryDelay,
      requestInit: headers ? { headers } : undefined,
      fetchFn: async (resource, init) => {
        /*
         * A read that never answers used to leave the player loading forever,
         * and one that was refused reported Safari's bare "Load failed".
         *
         * The cause is not guessed here. Every network-level refusal rejects
         * with the same opaque TypeError, so naming one of them is how a
         * player ends up insisting on a CORS error that the console does not
         * show. describeFetchFailure asks the host again in no-cors mode: if
         * it answers, the policy really is what stopped us; if it does not,
         * nothing reached it and the policy has nothing to do with it.
         */
        const deadline = new AbortController();
        const timer = setTimeout(() => deadline.abort(), REQUEST_TIMEOUT_MS);
        let response: Response;
        try {
          response = await fetch(resource, {
            ...init,
            signal: init?.signal
              ? AbortSignal.any([init.signal, deadline.signal])
              : deadline.signal,
          });
        } catch (error) {
          if (deadline.signal.aborted)
            throw new Error(
              `This host did not answer within ${Math.round(REQUEST_TIMEOUT_MS / 1000)} seconds. It may be slow, or the link may have expired.`,
            );
          if (error instanceof DOMException && error.name === 'AbortError') throw error;
          throw new Error(
            await describeFetchFailure(
              typeof resource === 'string' ? resource : String(resource),
              headers,
            ),
          );
        } finally {
          clearTimeout(timer);
        }
        /*
         * A 200 to a ranged request is only wrong when the range started
         * somewhere other than the beginning.
         *
         * Plenty of hosts answer an open-ended `bytes=0-` with 200 and the
         * whole body, which is legal and is exactly the bytes that were asked
         * for — reading forward from zero works either way. Treating that as a
         * refusal rejected sources that seek perfectly well, and this is the
         * first request made, so the whole file was turned away on the
         * strength of it. A later offset answered with 200 is a real problem:
         * the body then starts at zero while the reader expects it to start at
         * the offset, so the stream is silently misaligned rather than short.
         */
        const range = new Headers(init?.headers).get('range');
        const startsAtZero = !range || /^bytes=0-/i.test(range.trim());
        if (range && response.status === 200 && !startsAtZero) {
          await response.body?.cancel();
          throw new Error(
            `This host ignored a byte range (asked for ${range}, got the whole file). Native MKV seeking needs range support.`,
          );
        }
        return response;
      },
    }) });
  }

  async start(position = 0) {
    const Constructor = nativeMediaSource();
    if (!Constructor) throw new Error('Native remux requires MediaSource or ManagedMediaSource.');
    const signal = this.abort.signal;
    this.video = await this.bounded(this.input.getPrimaryVideoTrack(), signal);
    if (!this.video) throw new Error('No video track found.');
    const videoMime = `video/mp4; codecs="${await this.video.getCodecParameterString()}"`;
    if (!Constructor.isTypeSupported(videoMime)) throw new Error(`Native remux cannot play ${videoMime}.`);
    this.mime = [videoMime];
    const tracks = await this.bounded(this.input.getAudioTracks(), signal);
    const supported: { track: InputAudioTrack; mime: string }[] = [];
    for (const track of tracks) {
      const mime = `audio/mp4; codecs="${await track.getCodecParameterString()}"`;
      if (Constructor.isTypeSupported(mime)) supported.push({ track, mime });
    }
    const preferred = this.preferredLanguage.toLowerCase().split('-')[0];
    const selected = supported.find(({ track }) => preferred && track.languageCode?.toLowerCase().startsWith(preferred)) ?? supported[0];
    if (tracks.length && !selected) throw new Error('No audio track is supported by native MP4 playback. Remuxing cannot convert DTS or other unsupported audio.');
    this.audio = selected?.track ?? null;
    if (selected) this.mime.push(selected.mime);
    this.duration = await this.bounded(this.input.getDurationFromMetadata(), signal) ?? 0;
    if (!(this.duration > 0 && Number.isFinite(this.duration))) {
      throw new Error('Native remux needs a finite duration in the file metadata.');
    }
    if (this.stopped) return;
    this.element.disableRemotePlayback = true; // Required by iPhone ManagedMediaSource without an AirPlay alternative.
    this.element.addEventListener('seeking', this.seeking);
    await this.rebuild(position);
  }

  private seeking = () => {
    const time = this.element.currentTime;
    if (this.initial && Math.abs(time - this.target) < 1) return;
    if (!containsTime(this.element.buffered, time)) void this.rebuild(time).catch(error => {
      if (!this.stopped) { this.fail(error); this.stop(); }
    });
  };

  private async bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort = () => {};
    try {
      return await Promise.race([work, new Promise<never>((_, reject) => {
        abort = () => reject(new Error('Native remux canceled'));
        if (signal.aborted) return abort();
        signal.addEventListener('abort', abort, { once: true });
        timer = setTimeout(() => reject(new Error('Native remux timed out reading or buffering this source.')), 30_000);
      })]);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    }
  }

  private async rebuild(position: number) {
    if (this.stopped) return;
    this.abort.abort();
    for (const output of this.outputs) void output.cancel().catch(() => {});
    this.outputs = [];
    const controller = this.abort = new AbortController();
    const signal = controller.signal;
    this.target = Math.max(0, Math.min(position, this.duration - 0.1));
    this.initial = true;
    const Constructor = nativeMediaSource()!;
    const source = this.source = new Constructor();
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = URL.createObjectURL(source);
    const opened = new Promise<void>(resolve => source.addEventListener('sourceopen', () => resolve(), { once: true }));
    this.element.src = this.objectUrl;
    this.element.load();
    try { await this.bounded(opened, signal); }
    catch (error) { if (signal.aborted) return; throw error; }
    if (signal.aborted) return;
    source.duration = this.duration;
    const tracks = [this.video!, ...(this.audio ? [this.audio] : [])];
    const buffers = tracks.map((_, i) => source.addSourceBuffer(this.mime[i]));
    const destination = this.target;
    void Promise.all(tracks.map((track, i) => this.pump(track, buffers[i], signal, destination)))
      .then(() => { if (!signal.aborted && source.readyState === 'open') source.endOfStream(); })
      .catch(error => { if (!signal.aborted && !this.stopped) { this.fail(error); this.stop(); } });
  }

  private async pump(track: InputVideoTrack | InputAudioTrack, buffer: SourceBuffer,
    signal: AbortSignal, destination: number) {
    const packets = new EncodedPacketSink(track);
    const first = await this.bounded(packets.getKeyPacket(destination, { verifyKeyPackets: true }), signal)
      ?? await this.bounded(packets.getFirstKeyPacket(), signal);
    if (!first) throw new Error('No keyframe found for native remux.');
    const isVideo = track === this.video;
    const config = await this.bounded<AudioDecoderConfig | VideoDecoderConfig | null>(track.getDecoderConfig(), signal);
    const codec = await track.getCodec();
    if (!codec || !config) throw new Error('Missing native decoder configuration.');
    let pendingBytes = 0;
    const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'fragmented', minimumFragmentDuration: 1 }),
      target: new AppendOnlyStreamTarget(new WritableStream({ write: async data => {
        if (signal.aborted) throw new Error('Native remux canceled');
        if (data.byteLength > 32 * 1024 * 1024) throw new Error('Native remux fragment exceeds the memory limit.');
        if (buffer.buffered.length && this.element.currentTime > 15) {
          const end = this.element.currentTime - 10;
          if (buffer.buffered.start(0) < end) await this.update(buffer, () => buffer.remove(0, end), signal);
        }
        await this.update(buffer, () => buffer.appendBuffer(new Uint8Array(data)), signal);
        pendingBytes = 0;
        if (this.initial && containsTime(this.element.buffered, destination)) {
          this.initial = false;
          this.element.currentTime = destination;
          void this.element.play().catch(() => {}); // A real tap may be required on iOS.
        }
      } })) });
    this.outputs.push(output);
    // Separate SourceBuffers preserve each codec and avoid an audio producer
    // running far ahead while waiting for the other track's next keyframe.
    const source = isVideo
      ? new EncodedVideoPacketSource(codec as VideoCodec)
      : new EncodedAudioPacketSource(codec as AudioCodec);
    if (source instanceof EncodedVideoPacketSource) output.addVideoTrack(source);
    else output.addAudioTrack(source);
    await output.start();
    const iterator = packets.packets(first);
    try {
      while (!signal.aborted) {
        const next = await this.bounded(iterator.next(), signal);
        if (next.done) break;
        const packet = next.value;
        while ((packet.timestamp > Math.max(destination, this.element.currentTime) + 15 &&
          containsTime(buffer.buffered, Math.max(destination, this.element.currentTime))) ||
          ((this.source as MediaSource & { streaming?: boolean })?.streaming === false &&
            containsTime(this.element.buffered, this.element.currentTime))) {
          await this.bounded(new Promise(resolve => setTimeout(resolve, 100)), signal);
        }
        if (signal.aborted) return;
        pendingBytes += packet.data.byteLength;
        if (pendingBytes > 32 * 1024 * 1024) throw new Error('No remux fragment was produced within the memory limit. Try a lower-bitrate source.');
        if (source instanceof EncodedVideoPacketSource) await source.add(packet, { decoderConfig: config as VideoDecoderConfig });
        else await source.add(packet, { decoderConfig: config as AudioDecoderConfig });
      }
    } finally {
      void iterator.return().catch(() => {});
    }
    source.close();
    if (!signal.aborted) await output.finalize();
  }

  private async update(buffer: SourceBuffer, action: () => void, signal: AbortSignal) {
    let done = () => {};
    let failed = () => {};
    const work = new Promise<void>((resolve, reject) => {
      done = resolve;
      failed = () => reject(new Error('Native video rejected a remuxed segment.'));
      buffer.addEventListener('updateend', done, { once: true });
      buffer.addEventListener('error', failed, { once: true });
      action();
    });
    try { await this.bounded(work, signal); }
    finally { buffer.removeEventListener('updateend', done); buffer.removeEventListener('error', failed); }
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.abort.abort();
    this.element.removeEventListener('seeking', this.seeking);
    for (const output of this.outputs) void output.cancel().catch(() => {});
    this.outputs = [];
    this.input.dispose();
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.element.disableRemotePlayback = false;
  }
}
