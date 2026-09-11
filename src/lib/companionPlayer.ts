import type Hls from "hls.js";
import type { Stream } from "../types.ts";
import { platform } from "../platform/index.ts";
import { audioIsSilent } from "./playback.ts";
import { browserCapabilities, companionRequest, readCompanionPreferences, setPlaybackDiagnostics, stopCompanion } from "./companionClient.ts";
import type { CompanionPlayback, PlaybackMode } from "./companionPolicy.ts";
import { CompanionHttpError, isHlsSource, isTransientCompanionError, shouldEscalateStall } from "./companionTransport.ts";

type Callbacks = {
  unavailable?(): void;
  state(value: { waiting?: boolean; playing?: boolean; error?: string; mode?: string }): void;
  time(position: number, duration: number): void;
  audio(tracks: Array<{ id: number; label: string }>, selected: number): void;
  subtitles(tracks: Array<{ id: number; lang: string; label: string }>, selected: number): void;
};

/** Drives the existing <video> and controls; account progress contracts are untouched. */
export class CompanionPlayer {
  private element: HTMLVideoElement;
  private stream: Stream;
  private callbacks: Callbacks;
  private hls: Hls | null = null;
  private session: CompanionPlayback | null = null;
  private controller = new AbortController();
  private timer?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private silentWatch?: ReturnType<typeof setInterval>;
  private falling = false;
  private changing = false;
  private stopped = false;
  private failed = false;
  private startedAt = performance.now();
  private startupMs?: number;
  private lastError?: string;
  private mode: PlaybackMode = "direct";
  private resume: number;
  private audioLanguage: string;
  private pendingPosition: number | null = null;
  private caps = browserCapabilities();
  private preferences = readCompanionPreferences();
  private trackUrls: string[] = [];
  private subtitleSources: NonNullable<Stream["subtitles"]> = [];
  private subtitleTracks = new Map<number, HTMLTrackElement>();
  private subtitleGeneration = 0;
  private audioTimer?: ReturnType<typeof setTimeout>;
  private forceMse = false;
  private attachedHls = false;
  private attachedUrl = "";
  private attaching = false;
  private wantsPlayback = true;
  private seekQueue: Promise<void> = Promise.resolve();
  private hasPlayed = false;
  private transportInspected = false;
  private transportRetries = 0;
  private heartbeatFailures = 0;
  private heartbeatFlight = false;
  private attachment = 0;
  private changeFlight = false;
  private steadyFrom = 0;
  private steadyPosition = 0;
  constructor(element: HTMLVideoElement, stream: Stream, start: number, language: string, callbacks: Callbacks) {
    this.element = element; this.stream = stream; this.resume = start; this.audioLanguage = language; this.callbacks = callbacks;
  }
  get currentTime() { return this.pendingPosition ?? (this.session?.offset ?? 0) + (this.element.currentTime || 0); }
  get duration() { return this.session?.probe.duration || (Number.isFinite(this.element.duration) ? this.element.duration : 0); }
  setPlaybackIntent(playing: boolean) { this.wantsPlayback = playing; }
  private updateDiagnostics() {
    const end = this.element.buffered.length ? this.element.buffered.end(this.element.buffered.length - 1) : this.element.currentTime;
    const quality = this.element.getVideoPlaybackQuality?.();
    setPlaybackDiagnostics({ browser: navigator.userAgent, pwa: matchMedia("(display-mode: standalone)").matches, capabilities: this.caps, mode: this.mode, preferences: this.preferences, startupMs: this.startupMs, source: this.session?.probe, speed: this.session?.speed, bufferSeconds: Math.max(0, end - this.element.currentTime), decodedFrames: quality?.totalVideoFrames, droppedFrames: quality?.droppedVideoFrames, lastError: this.lastError });
  }
  async start() {
    const element = this.element;
    const listen = (name: string, handler: () => void) => element.addEventListener(name, handler, { signal: this.controller.signal });
    listen("error", () => void this.fallback(element.error?.code === 2 ? "network" : "unsupported"));
    listen("playing", () => { clearTimeout(this.timer); this.hasPlayed = true; this.steadyFrom = performance.now(); this.steadyPosition = this.currentTime; this.attaching = false; this.pendingPosition = null; this.startupMs ??= Math.round(performance.now() - this.startedAt); if (!this.wantsPlayback) element.pause(); this.callbacks.state({ waiting: false, playing: this.wantsPlayback, error: "" }); this.updateDiagnostics(); });
    listen("pause", () => { if (!this.changing && !this.attaching) { clearTimeout(this.timer); this.wantsPlayback = false; this.callbacks.state({ playing: false, waiting: false }); void this.ping(); } });
    listen("play", () => { if (!this.changing && !this.attaching) { this.wantsPlayback = true; void this.ping(); } });
    listen("waiting", () => { if (this.wantsPlayback) { this.callbacks.state({ waiting: true }); this.armTimeout(20_000); } });
    listen("ended", () => this.callbacks.state({ playing: false, waiting: false }));
    listen("timeupdate", () => {
      if (!element.paused && performance.now() - this.steadyFrom > 30_000 && this.currentTime - this.steadyPosition > 15) this.transportRetries = 0;
      this.callbacks.time(this.currentTime, this.duration); this.updateDiagnostics();
    });
    listen("durationchange", () => this.callbacks.time(this.currentTime, this.duration));
    listen("loadedmetadata", () => {
      if (this.resume > 0 && (!this.session || this.session.mode === "relay")) { element.currentTime = this.resume; this.resume = 0; }
      this.syncNativeTracks();
    });
    const hide = () => this.stop();
    window.addEventListener("pagehide", hide, { signal: this.controller.signal });
    this.silentWatch = setInterval(() => {
      if (!element.paused && element.currentTime > 2 && (!this.session || this.session.probe.audio.length > 0) && audioIsSilent(element)) void this.fallback();
    }, 2500);
    if (!this.stream.url) { this.finalError("This source has no HTTP video link. Use an external player."); return; }
    if (Object.keys(this.stream.behaviorHints?.proxyHeaders?.request ?? {}).length || this.preferences.mode === "compatibility" || location.protocol === "https:" && this.stream.url.startsWith("http:")) await this.fallback();
    else {
      await this.attach(this.stream.url, isHlsSource(this.stream.url, this.stream.behaviorHints?.filename));
      // Matroska with unsupported audio can appear to play silently. Inspect it after the direct attempt.
      const text = `${this.stream.url} ${this.stream.behaviorHints?.filename ?? ""} ${this.stream.title}`;
      if (/\.mkv\b|dts|truehd|e-?ac-?3/i.test(text) && this.preferences.mode !== "direct") {
        this.audioTimer = setTimeout(() => {
          const decoded = (element as HTMLVideoElement & { webkitAudioDecodedByteCount?: number }).webkitAudioDecodedByteCount;
          // A browser demonstrably decoding both tracks keeps direct playback, even for MKV.
          if (!element.paused && !(decoded !== undefined && decoded > 0 && element.getVideoPlaybackQuality().totalVideoFrames > 0)) void this.fallback();
        }, 1500);
      }
    }
  }
  private armTimeout(ms = 12_000) { clearTimeout(this.timer); this.timer = setTimeout(() => { if (this.wantsPlayback) void this.fallback("stall"); }, ms); }
  private async attach(url: string, hls: boolean, startAt?: number) {
    if (this.stopped || this.failed) return;
    const attachment = ++this.attachment;
    this.attachedUrl = url; this.attachedHls = hls;
    this.attaching = true;
    this.changing = true; this.hls?.destroy(); this.hls = null;
    // The JSX autoplay attribute otherwise restarts MSE as soon as a paused
    // seek appends its first fragment. Only the explicit playback intent owns
    // play() here; loading a new source must never turn a pause into a play.
    this.element.autoplay = false;
    this.element.pause(); this.element.removeAttribute("src"); this.element.load();
    this.callbacks.state({ waiting: true, error: "", mode: this.mode }); this.armTimeout(this.session ? 25_000 : 12_000);
    if (hls && (!this.caps.nativeHls || this.forceMse)) {
      const { default: HlsClass } = await import("hls.js");
      if (this.stopped || this.failed || attachment !== this.attachment) return;
      if (!HlsClass.isSupported()) { this.finalError("This browser does not support HLS playback. Use a browser with HLS or Media Source support."); return; }
      const player = new HlsClass({ enableWorker: true, lowLatencyMode: false, maxBufferLength: 30, maxMaxBufferLength: 60, maxBufferSize: 64 * 1024 * 1024, backBufferLength: 30, startPosition: startAt ?? (this.session && this.session.mode !== "relay" ? 0 : this.resume), liveSyncDurationCount: 3 });
      this.hls = player;
      let retries = 0;
      player.on(HlsClass.Events.ERROR, (_event, data) => {
        if (!data.fatal || this.stopped || this.failed || attachment !== this.attachment) return;
        if (retries++ < 1 && data.type === HlsClass.ErrorTypes.MEDIA_ERROR) player.recoverMediaError();
        else void this.fallback(data.type === HlsClass.ErrorTypes.NETWORK_ERROR ? "network" : "unsupported");
      });
      player.on(HlsClass.Events.AUDIO_TRACKS_UPDATED, () => {
        if (!this.session || this.session.mode === "relay") this.callbacks.audio(player.audioTracks.map((t, id) => ({ id, label: t.name || t.lang || `Audio ${id + 1}` })), player.audioTrack);
      });
      player.on(HlsClass.Events.AUDIO_TRACK_SWITCHED, (_event, data) => { if (!this.session || this.session.mode === "relay") this.callbacks.audio(player.audioTracks.map((t, id) => ({ id, label: t.name || t.lang || `Audio ${id + 1}` })), data.id); });
      player.on(HlsClass.Events.SUBTITLE_TRACKS_UPDATED, () => this.publishSubtitles(player.subtitleTrack));
      player.on(HlsClass.Events.MANIFEST_PARSED, () => {
        if (this.stopped || this.failed || attachment !== this.attachment) return;
        this.changing = false;
        if (!this.wantsPlayback) { this.attaching = false; clearTimeout(this.timer); this.callbacks.state({ playing: false, waiting: false }); void this.ping(); return; }
        void this.element.play().catch((error: unknown) => {
          if (this.stopped || this.failed || attachment !== this.attachment) return;
          if (error instanceof DOMException && error.name === "NotAllowedError") { this.wantsPlayback = false; this.attaching = false; clearTimeout(this.timer); this.callbacks.state({ playing: false, waiting: false }); void this.ping(); }
          else if (!(error instanceof DOMException && error.name === "AbortError")) void this.fallback();
        });
      });
      player.attachMedia(this.element); player.loadSource(url);
    } else {
      if (!this.session) this.mode = hls ? "native-hls" : "direct";
      this.element.src = url; this.element.load(); this.changing = false;
      if (!this.wantsPlayback) { this.attaching = false; clearTimeout(this.timer); this.callbacks.state({ playing: false, waiting: false }); void this.ping(); return; }
      void this.element.play().catch((error: unknown) => {
        if (this.stopped || this.failed || attachment !== this.attachment) return;
        if (error instanceof DOMException && error.name === "NotAllowedError") { this.wantsPlayback = false; this.attaching = false; clearTimeout(this.timer); this.callbacks.state({ playing: false, waiting: false }); void this.ping(); }
        else if (!(error instanceof DOMException && error.name === "AbortError") && !this.changing) void this.fallback();
      });
    }
    if (hls && (!this.caps.nativeHls || this.forceMse) && !this.session) this.mode = "hls-js";
    this.callbacks.state({ mode: this.mode }); this.updateDiagnostics();
  }
  private async fallback(reason: "unsupported" | "stall" | "network" = "unsupported") {
    if (this.stopped || this.failed || this.falling || this.changeFlight) return;
    this.falling = true; clearTimeout(this.timer); clearTimeout(this.audioTimer);
    const position = this.hasPlayed ? this.currentTime : Math.max(this.currentTime, this.resume);
    this.callbacks.state({ waiting: true, error: "" });
    try {
      if (reason !== "unsupported" && (this.session && ![3, 4].includes(this.element.error?.code ?? 0) || !shouldEscalateStall(this.hasPlayed, this.element.error?.code))) {
        // A stream that already decoded is not an incompatible codec. Retry its
        // transport once at the saved position, without climbing the encode ladder.
        if (this.transportRetries++ >= 1) {
          this.finalError("This source is not delivering video fast enough. Try a smaller cached source, or compare playback on your home network.");
          return;
        }
        if (this.session && this.session.mode !== "relay") {
          const value = await companionRequest<CompanionPlayback>(`/sessions/${this.session.id}/change`, { position }, this.controller.signal);
          if (this.stopped || this.failed) return;
          this.session = value; this.pendingPosition = position;
          await this.attach(value.url, true);
        } else {
          this.resume = position; this.pendingPosition = position;
          await this.attach(this.attachedUrl, this.attachedHls);
        }
        return;
      }
      // Addon links often redirect to an extensionless playlist. Inspect only
      // after a failed native attempt; working direct files cost no extra fetch.
      if (!this.session && !this.attachedHls && !this.transportInspected && this.attachedUrl) {
        this.transportInspected = true;
        const controller = new AbortController();
        try {
          const response = await fetch(this.attachedUrl, { headers: { Range: "bytes=0-1023" }, signal: AbortSignal.any([controller.signal, this.controller.signal, AbortSignal.timeout(4000)]) });
          const hls = response.ok && isHlsSource(response.url, this.stream.behaviorHints?.filename, response.headers.get("content-type") ?? "");
          await response.body?.cancel();
          if (hls) { this.resume = position; await this.attach(this.attachedUrl, true); return; }
        } catch { /* Cross-origin providers are handled by the authenticated relay. */ }
        finally { controller.abort(); }
      }
      // Some browsers advertise native HLS but reject an fMP4 stream they can decode via MSE.
      // Try the other browser transport before spending CPU on another conversion.
      if (this.attachedHls && this.caps.nativeHls && this.caps.mse && !this.forceMse) {
        this.forceMse = true;
        this.pendingPosition = position;
        this.resume = !this.session || this.session.mode === "relay" ? position : 0;
        await this.attach(this.attachedUrl, true, Math.max(0, position - (this.session?.offset ?? 0)));
        return;
      }
      const value = this.session
        ? await companionRequest<CompanionPlayback>(`/sessions/${this.session.id}/change`, { position, recover: true }, this.controller.signal)
        : await companionRequest<CompanionPlayback>("/sessions", { url: this.stream.url, headers: this.stream.behaviorHints?.proxyHeaders?.request, capabilities: this.caps, preferences: this.preferences, position, preferredAudio: this.audioLanguage, previous: [this.mode] }, this.controller.signal);
      if (this.stopped || this.failed) { stopCompanion(value.id); return; }
      this.session = value; this.mode = value.mode; this.pendingPosition = position;
      this.resume = value.mode === "relay" ? position : 0;
      await this.attach(value.url, value.mode !== "relay" || /hls/.test(value.probe.container));
      this.syncCompanionAudio();
      this.heartbeat ??= setInterval(() => void this.ping(), 10_000);
      void this.ping();
    } catch (error) {
      if (!this.stopped) {
        const message = error instanceof Error ? error.message : "The companion could not prepare this source.";
        if (!this.session && /unavailable|not available/.test(message) && this.callbacks.unavailable) this.callbacks.unavailable();
        else this.finalError(message);
      }
    }
    finally { this.falling = false; }
  }
  private async ping() {
    if (!this.session || this.stopped || this.failed || this.changing || this.heartbeatFlight) return;
    this.heartbeatFlight = true;
    try {
      const generation = this.session.generation;
      const value = await companionRequest<CompanionPlayback>(`/sessions/${this.session.id}/heartbeat`, { paused: !this.wantsPlayback, generation }, this.controller.signal);
      if (this.stopped || generation !== this.session?.generation) return;
      this.heartbeatFailures = 0;
      this.session = value;
      this.updateDiagnostics(); if (this.session.error) await this.fallback(this.session.errorKind === "source" ? "network" : "unsupported");
    } catch (error) {
      if (this.stopped) return;
      if (isTransientCompanionError(error) && ++this.heartbeatFailures <= 3) {
        this.lastError = "The playback connection briefly dropped; reconnecting.";
        this.updateDiagnostics();
        return;
      }
      if (error instanceof CompanionHttpError && error.status === 404) {
        this.finalError("The playback session expired or the companion restarted. Choose the source again to resume.");
      } else this.finalError(error instanceof Error ? error.message : "The companion disconnected.");
    } finally { this.heartbeatFlight = false; }
  }
  private syncCompanionAudio() {
    if (!this.session || this.session.mode === "relay" && /hls/.test(this.session.probe.container)) return;
    this.callbacks.audio(this.session.probe.audio.map((t) => ({ id: t.index, label: [t.title || t.language || `Audio ${t.index}`, t.codec.toUpperCase(), t.channels ? `${t.channels} ch` : ""].filter(Boolean).join(" · ") })), this.session.audioIndex);
  }
  private syncNativeTracks() {
    const element = this.element as HTMLVideoElement & { audioTracks?: ArrayLike<{ label?: string; language?: string; enabled: boolean }> };
    if (element.audioTracks?.length && (!this.session || this.session.mode === "relay" && /hls/.test(this.session.probe.container))) {
      const tracks = Array.from(element.audioTracks);
      this.callbacks.audio(tracks.map((t, id) => ({ id, label: t.label || t.language || `Audio ${id + 1}` })), tracks.findIndex((t) => t.enabled));
    }
    const texts = Array.from(element.textTracks);
    if (texts.length) this.callbacks.subtitles(texts.map((t, id) => ({ id, lang: t.language, label: t.label || t.language })), texts.findIndex((t) => t.mode === "showing"));
  }
  seek(position: number, audioIndex?: number) {
    const next = this.seekQueue.then(() => this.seekNow(position, audioIndex));
    this.seekQueue = next.catch(() => undefined);
    return next;
  }
  private async seekNow(position: number, audioIndex?: number) {
    const deadline = Date.now() + 30_000;
    while ((this.changing || this.falling) && !this.stopped && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    if (this.stopped || this.failed) return;
    if (this.changing || this.falling) { this.finalError("The playback change timed out. Choose the source again."); return; }
    const target = Math.max(0, Math.min(position, this.duration ? this.duration - 0.1 : position));
    if (!this.session || this.session.mode === "relay" && audioIndex === undefined) { this.element.currentTime = target; this.callbacks.time(target, this.duration); return; }
    this.changing = true; this.changeFlight = true;
    this.callbacks.state({ waiting: true }); this.pendingPosition = target;
    // Native HLS may defer metadata/timeupdate until Play when paused. The
    // scrubber and caption clock still need the requested original position now.
    this.callbacks.time(target, this.duration);
    try {
      const value = await companionRequest<CompanionPlayback>(`/sessions/${this.session.id}/change`, { position: target, audioIndex }, this.controller.signal);
      if (this.stopped || this.failed) return;
      this.session = value; this.mode = value.mode;
      await this.attach(value.url, true); this.syncCompanionAudio();
    } catch (error) { if (!this.stopped) this.finalError(error instanceof Error ? error.message : "Seeking failed."); }
    finally { this.changing = false; this.changeFlight = false; }
  }
  async selectAudio(id: number) {
    if (this.session && !/hls/.test(this.session.probe.container) || this.session && this.session.mode !== "relay") { await this.seek(this.currentTime, id); return; }
    if (this.hls) { this.hls.audioTrack = id; return; }
    const list = (this.element as HTMLVideoElement & { audioTracks?: ArrayLike<{ enabled: boolean }> }).audioTracks;
    if (!list?.[id]) throw new Error("This browser cannot switch embedded audio tracks.");
    for (let i = 0; i < list.length; i++) list[i].enabled = i === id;
    this.syncNativeTracks();
  }
  async selectSubtitle(id: number) {
    const generation = ++this.subtitleGeneration;
    if (id >= 1000) {
      const source = this.subtitleSources[id - 1000];
      if (!source) return;
      let track = this.subtitleTracks.get(id);
      if (!track) {
        let vtt: string;
        try {
          const response = await platform.request(source.url, { signal: this.controller.signal, timeoutMs: 8000, maxBytes: 2 * 1024 * 1024 });
          if (!response.ok) throw new Error();
          if (response.body.trimStart().startsWith("WEBVTT")) vtt = response.body;
          else if (/\d{2}:\d{2}:\d{2},\d{3}\s+-->/.test(response.body)) vtt = "WEBVTT\n\n" + response.body.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2");
          else throw new Error();
        } catch {
          vtt = (await companionRequest<{ vtt: string }>("/subtitles", { url: source.url }, this.controller.signal)).vtt;
        }
        if (this.stopped || generation !== this.subtitleGeneration) return;
        const objectUrl = URL.createObjectURL(new Blob([vtt], { type: "text/vtt" })); this.trackUrls.push(objectUrl);
        track = document.createElement("track"); track.kind = "subtitles"; track.label = source.label || source.lang; track.srclang = source.lang; track.src = objectUrl;
        this.element.append(track); this.subtitleTracks.set(id, track);
      }
      if (this.hls) this.hls.subtitleTrack = -1;
      for (const text of Array.from(this.element.textTracks)) text.mode = text === track.track ? "showing" : "disabled";
      this.publishSubtitles(id); return;
    }
    if (this.hls && id < 1000) this.hls.subtitleTrack = id;
    for (let i = 0; i < this.element.textTracks.length; i++) this.element.textTracks[i].mode = !this.hls && i === id ? "showing" : "disabled";
    this.publishSubtitles(id);
  }
  setSubtitleSources(sources: NonNullable<Stream["subtitles"]>, preferred = "none") {
    this.subtitleSources = [...new Map([...(this.stream.subtitles ?? []), ...sources].map((source) => [source.url, source])).values()];
    this.publishSubtitles(-1);
    const language = preferred === "device" ? navigator.language.split("-")[0] : preferred;
    if (language !== "none") {
      const index = this.subtitleSources.findIndex((source) => source.lang.startsWith(language));
      if (index >= 0) void this.selectSubtitle(1000 + index).catch(() => undefined);
    }
  }
  private publishSubtitles(selected: number) {
    const hls = this.hls?.subtitleTracks.map((t, id) => ({ id, lang: t.lang || "", label: t.name || t.lang || `Subtitle ${id + 1}` })) ?? [];
    this.callbacks.subtitles([...hls, ...this.subtitleSources.map((t, i) => ({ id: 1000 + i, lang: t.lang, label: t.label || t.lang }))], selected);
  }
  private finalError(message: string) {
    if (this.failed || this.stopped) return;
    this.failed = true; this.attachment++; this.controller.abort(); clearTimeout(this.timer); clearTimeout(this.audioTimer); clearInterval(this.heartbeat); clearInterval(this.silentWatch); this.lastError = message; this.callbacks.state({ error: message, waiting: false, playing: false }); this.updateDiagnostics();
    if (this.session) stopCompanion(this.session.id);
    this.hls?.stopLoad(); this.element.pause();
  }
  stop() {
    if (this.stopped) return;
    this.stopped = true; this.attachment++; this.controller.abort(); clearTimeout(this.timer); clearTimeout(this.audioTimer); clearInterval(this.heartbeat); clearInterval(this.silentWatch);
    this.hls?.destroy(); if (this.session) stopCompanion(this.session.id);
    for (const url of this.trackUrls) URL.revokeObjectURL(url);
    for (const track of this.subtitleTracks.values()) track.remove();
    this.element.pause(); this.element.removeAttribute("src"); this.element.load();
  }
}
