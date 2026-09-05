import type Hls from "hls.js";
import type { Stream } from "../types.ts";
import { platform } from "../platform/index.ts";
import { audioIsSilent } from "./playback.ts";
import { browserCapabilities, companionRequest, readCompanionPreferences, setPlaybackDiagnostics, stopCompanion } from "./companionClient.ts";
import type { CompanionPlayback, PlaybackMode } from "./companionPolicy.ts";

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
  constructor(element: HTMLVideoElement, stream: Stream, start: number, language: string, callbacks: Callbacks) {
    this.element = element; this.stream = stream; this.resume = start; this.audioLanguage = language; this.callbacks = callbacks;
  }
  get currentTime() { return this.pendingPosition ?? (this.session?.offset ?? 0) + (this.element.currentTime || 0); }
  get duration() { return this.session?.probe.duration || (Number.isFinite(this.element.duration) ? this.element.duration : 0); }
  setPlaybackIntent(playing: boolean) { this.wantsPlayback = playing; }
  private updateDiagnostics() {
    const end = this.element.buffered.length ? this.element.buffered.end(this.element.buffered.length - 1) : this.element.currentTime;
    setPlaybackDiagnostics({ browser: navigator.userAgent, pwa: matchMedia("(display-mode: standalone)").matches, capabilities: this.caps, mode: this.mode, startupMs: this.startupMs, source: this.session?.probe, speed: this.session?.speed, bufferSeconds: Math.max(0, end - this.element.currentTime), lastError: this.lastError });
  }
  async start() {
    const element = this.element;
    const listen = (name: string, handler: () => void) => element.addEventListener(name, handler, { signal: this.controller.signal });
    listen("error", () => void this.fallback());
    listen("playing", () => { clearTimeout(this.timer); this.attaching = false; this.pendingPosition = null; this.startupMs ??= Math.round(performance.now() - this.startedAt); if (!this.wantsPlayback) element.pause(); this.callbacks.state({ waiting: false, playing: this.wantsPlayback, error: "" }); this.updateDiagnostics(); });
    listen("pause", () => { if (!this.changing && !this.attaching) { this.wantsPlayback = false; this.callbacks.state({ playing: false }); void this.ping(); } });
    listen("play", () => { if (!this.changing && !this.attaching) { this.wantsPlayback = true; void this.ping(); } });
    listen("waiting", () => { this.callbacks.state({ waiting: true }); this.armTimeout(15_000); });
    listen("ended", () => this.callbacks.state({ playing: false, waiting: false }));
    listen("timeupdate", () => { this.callbacks.time(this.currentTime, this.duration); this.updateDiagnostics(); });
    listen("durationchange", () => this.callbacks.time(this.currentTime, this.duration));
    listen("loadedmetadata", () => {
      if (this.resume > 0 && !this.session) { element.currentTime = this.resume; this.resume = 0; }
      this.syncNativeTracks();
    });
    const hide = () => this.stop();
    window.addEventListener("pagehide", hide, { signal: this.controller.signal });
    this.silentWatch = setInterval(() => {
      if (!element.paused && element.currentTime > 2 && audioIsSilent(element)) void this.fallback();
    }, 2500);
    if (!this.stream.url) { this.finalError("This source has no HTTP video link. Use an external player."); return; }
    if (Object.keys(this.stream.behaviorHints?.proxyHeaders?.request ?? {}).length || this.preferences.mode === "compatibility" || location.protocol === "https:" && this.stream.url.startsWith("http:")) await this.fallback();
    else {
      await this.attach(this.stream.url, /\.m3u8(?:[?#]|$)/i.test(this.stream.url));
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
  private armTimeout(ms = 12_000) { clearTimeout(this.timer); this.timer = setTimeout(() => void this.fallback(), ms); }
  private async attach(url: string, hls: boolean) {
    if (this.stopped) return;
    this.attachedUrl = url; this.attachedHls = hls;
    this.attaching = true;
    this.changing = true; this.hls?.destroy(); this.hls = null;
    this.element.pause(); this.element.removeAttribute("src"); this.element.load();
    this.callbacks.state({ waiting: true, error: "", mode: this.mode }); this.armTimeout(this.session ? 25_000 : 12_000);
    if (hls && (!this.caps.nativeHls || this.forceMse)) {
      const { default: HlsClass } = await import("hls.js");
      if (this.stopped) return;
      if (!HlsClass.isSupported()) { this.finalError("This browser does not support HLS playback. Use a browser with HLS or Media Source support."); return; }
      const player = new HlsClass({ enableWorker: true, lowLatencyMode: false, maxBufferLength: 20, maxMaxBufferLength: 40, startPosition: this.session ? 0 : this.resume, liveSyncDurationCount: 1 });
      this.hls = player;
      let retries = 0;
      player.on(HlsClass.Events.ERROR, (_event, data) => {
        if (!data.fatal || this.stopped) return;
        if (retries++ < 1 && data.type === HlsClass.ErrorTypes.MEDIA_ERROR) player.recoverMediaError();
        else void this.fallback();
      });
      player.on(HlsClass.Events.AUDIO_TRACKS_UPDATED, () => {
        if (!this.session || this.session.mode === "relay") this.callbacks.audio(player.audioTracks.map((t, id) => ({ id, label: t.name || t.lang || `Audio ${id + 1}` })), player.audioTrack);
      });
      player.on(HlsClass.Events.AUDIO_TRACK_SWITCHED, (_event, data) => { if (!this.session || this.session.mode === "relay") this.callbacks.audio(player.audioTracks.map((t, id) => ({ id, label: t.name || t.lang || `Audio ${id + 1}` })), data.id); });
      player.on(HlsClass.Events.SUBTITLE_TRACKS_UPDATED, () => this.publishSubtitles(player.subtitleTrack));
      player.on(HlsClass.Events.MANIFEST_PARSED, () => { this.changing = false; void this.element.play().catch(() => { this.attaching = false; clearTimeout(this.timer); this.callbacks.state({ playing: false, waiting: false }); void this.ping(); }); });
      player.attachMedia(this.element); player.loadSource(url);
    } else {
      if (!this.session) this.mode = hls ? "native-hls" : "direct";
      this.element.src = url; this.element.load(); this.changing = false;
      void this.element.play().catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "NotAllowedError") { this.attaching = false; clearTimeout(this.timer); this.callbacks.state({ playing: false, waiting: false }); void this.ping(); }
        else if (!this.stopped && !this.changing) void this.fallback();
      });
    }
    if (hls && (!this.caps.nativeHls || this.forceMse) && !this.session) this.mode = "hls-js";
    this.callbacks.state({ mode: this.mode }); this.updateDiagnostics();
  }
  private async fallback() {
    if (this.stopped || this.failed || this.falling) return;
    this.falling = true; clearTimeout(this.timer); clearTimeout(this.audioTimer);
    const position = Math.max(this.currentTime, this.resume);
    this.callbacks.state({ waiting: true, error: "" });
    try {
      // Some browsers advertise native HLS but reject an fMP4 stream they can decode via MSE.
      // Try the other browser transport before spending CPU on another conversion.
      if (this.attachedHls && this.caps.nativeHls && this.caps.mse && !this.forceMse) {
        this.forceMse = true;
        await this.attach(this.attachedUrl, true);
        return;
      }
      const value = this.session
        ? await companionRequest<CompanionPlayback>(`/sessions/${this.session.id}/change`, { position, recover: true }, this.controller.signal)
        : await companionRequest<CompanionPlayback>("/sessions", { url: this.stream.url, headers: this.stream.behaviorHints?.proxyHeaders?.request, capabilities: this.caps, preferences: this.preferences, position, preferredAudio: this.audioLanguage, previous: [this.mode] }, this.controller.signal);
      if (this.stopped) { stopCompanion(value.id); return; }
      this.session = value; this.mode = value.mode; this.pendingPosition = position;
      this.resume = value.mode === "relay" ? position : 0;
      await this.attach(value.url, value.mode !== "relay" || /hls/.test(value.probe.container));
      if (value.mode === "relay" && position > 0) this.element.addEventListener("loadedmetadata", () => { this.element.currentTime = position; }, { once: true, signal: this.controller.signal });
      this.syncCompanionAudio();
      this.heartbeat ??= setInterval(() => void this.ping(), 20_000);
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
    if (!this.session || this.stopped || this.failed || this.changing) return;
    try {
      const generation = this.session.generation;
      const value = await companionRequest<CompanionPlayback>(`/sessions/${this.session.id}/heartbeat`, { paused: !this.wantsPlayback, generation }, this.controller.signal);
      if (this.stopped || generation !== this.session?.generation) return;
      this.session = value;
      this.updateDiagnostics(); if (this.session.error) await this.fallback();
    } catch (error) { if (!this.stopped) this.finalError(error instanceof Error ? error.message : "The companion disconnected."); }
  }
  private syncCompanionAudio() {
    if (!this.session || this.session.mode === "relay" && /hls/.test(this.session.probe.container)) return;
    this.callbacks.audio(this.session.probe.audio.map((t) => ({ id: t.index, label: [t.title || t.language || `Audio ${t.index}`, t.codec.toUpperCase(), t.channels ? `${t.channels} ch` : ""].filter(Boolean).join(" · ") })), this.session.audioIndex);
  }
  private syncNativeTracks() {
    const element = this.element as HTMLVideoElement & { audioTracks?: ArrayLike<{ label?: string; language?: string; enabled: boolean }> };
    if (element.audioTracks?.length && (!this.session || this.session.mode === "relay")) {
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
    while (this.changing && !this.stopped && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    if (this.stopped) return;
    if (this.changing) { this.finalError("The playback change timed out. Choose the source again."); return; }
    const target = Math.max(0, Math.min(position, this.duration ? this.duration - 0.1 : position));
    if (!this.session || this.session.mode === "relay" && audioIndex === undefined) { this.element.currentTime = target; return; }
    this.changing = true;
    this.callbacks.state({ waiting: true }); this.pendingPosition = target;
    try {
      const value = await companionRequest<CompanionPlayback>(`/sessions/${this.session.id}/change`, { position: target, audioIndex }, this.controller.signal);
      if (this.stopped) return;
      this.session = value; this.mode = value.mode;
      await this.attach(value.url, true); this.syncCompanionAudio();
    } catch (error) { if (!this.stopped) this.finalError(error instanceof Error ? error.message : "Seeking failed."); }
    finally { this.changing = false; }
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
    this.failed = true; clearTimeout(this.timer); clearTimeout(this.audioTimer); clearInterval(this.heartbeat); clearInterval(this.silentWatch); this.lastError = message; this.callbacks.state({ error: message, waiting: false, playing: false }); this.updateDiagnostics();
    if (this.session) stopCompanion(this.session.id);
    this.hls?.stopLoad(); this.element.pause();
  }
  stop() {
    if (this.stopped) return;
    this.stopped = true; this.controller.abort(); clearTimeout(this.timer); clearTimeout(this.audioTimer); clearInterval(this.heartbeat); clearInterval(this.silentWatch);
    this.hls?.destroy(); if (this.session) stopCompanion(this.session.id);
    for (const url of this.trackUrls) URL.revokeObjectURL(url);
    for (const track of this.subtitleTracks.values()) track.remove();
    this.element.pause(); this.element.removeAttribute("src"); this.element.load();
  }
}
