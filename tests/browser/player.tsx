import { createRoot } from "react-dom/client";
import { useState } from "react";
import { Player } from "../../src/components/Player";
import { CompanionSettings } from "../../src/components/CompanionSettings";
import { platform } from "../../src/platform/index.ts";
import { readWebSettings } from "../../src/lib/webSettings";
import { saveCompanionPreferences } from "../../src/lib/companionClient";
import type { Meta, Stream } from "../../src/types";
import "../../src/styles.css";

const query = new URLSearchParams(location.search);
const file = query.get("file") || "direct.mp4";
saveCompanionPreferences({ mode: query.get("compatibility") ? "compatibility" : "automatic", resolution: "original" });
platform.auth.companionSession = async () => {
  if (query.has("noCompanion")) throw new Error("The companion is unavailable.");
  const response = await fetch("/api/companion/auth", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer test-nuvio-access" }, body: JSON.stringify({ backend: "https://api.nuvio.tv" }) });
  if (!response.ok) throw new Error("The companion is unavailable.");
  return response.json();
};
const settings = { ...readWebSettings(null).player, skipIntroEnabled: false, autoPlayNextEpisode: false, preferredSubtitleLanguage: "none" };
const meta: Meta = { id: "fixture", name: "Generated playback test", type: "movie", genres: [], cast: [], director: [], writer: [], trailers: [], externalRatings: [], videos: [], manifestUrl: "", addonName: "Local test fixtures" };
const stream: Stream = { url: `http://127.0.0.1:4320/${file}`, title: file, name: "Generated media", addonName: "Local test fixtures", subtitles: [{ id: "sample", lang: "en", label: "English · generated test", url: "http://127.0.0.1:4320/sample.srt" }], ...(file.startsWith("headers/") ? { behaviorHints: { proxyHeaders: { request: { Referer: "https://allowed.example/" } } } } : {}) };
const alternative: Stream = { ...stream, url: "http://127.0.0.1:4320/headers/audio.mkv", name: "Alternative generated media", title: "Generated audio-conversion source", behaviorHints: { proxyHeaders: { request: { Referer: "https://allowed.example/" } } } };
function Fixture() {
  const [open, setOpen] = useState(true);
  const [selected, setSelected] = useState(stream);
  const [resume, setResume] = useState(Number(query.get("resume") || 0) * 1000);
  return query.has("settings") ? <main style={{ maxWidth: 900, margin: "40px auto", padding: 20 }}><CompanionSettings /></main> : open ? <Player stream={selected} meta={meta} settings={settings} startPositionMs={resume}
    {...(query.has("sources") ? { sources: [stream, alternative], onSelectSource: (next: Stream, position: number) => {
      document.documentElement.dataset.sourceChange = JSON.stringify({ url: next.url, position });
      setResume(position); setSelected(next);
    } } : {})}
    onClose={() => setOpen(false)} onExternalPlay={() => setOpen(false)} onProgress={(position, duration, ended) => { document.documentElement.dataset.progress = JSON.stringify({ position, duration, ended }); }} /> : <p>Playback stopped</p>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
