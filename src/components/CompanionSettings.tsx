import { useEffect, useState } from "react";
import { t } from "../lib/i18n.ts";
import { browserCapabilities, companionRequest, playbackDiagnostics, readCompanionPreferences, saveCompanionPreferences } from "../lib/companionClient.ts";
import type { PlaybackPreferences } from "../lib/companionPolicy.ts";
import { copyText } from "../lib/copyText.ts";

export function CompanionSettings() {
  const [preferences, setPreferences] = useState(readCompanionPreferences);
  const [health, setHealth] = useState("");
  const [diagnostics, setDiagnostics] = useState("");
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/companion/healthz", { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(3000)]) })
      .then((r) => { if (!r.ok) throw new Error(); return r.json() as Promise<{ ffmpeg: string }>; })
      .then((value) => { if (!value.ffmpeg) throw new Error(); setHealth(t("companion.connected")); }).catch(() => { if (!controller.signal.aborted) setHealth(t("companion.unavailable")); });
    return () => controller.abort();
  }, []);
  function update(value: PlaybackPreferences) { setPreferences(value); saveCompanionPreferences(value); }
  async function inspect() {
    const server = await companionRequest<unknown>("/diagnostics").catch(() => ({ status: "unavailable" }));
    const data = JSON.stringify({ browser: navigator.userAgent, pwa: matchMedia("(display-mode: standalone)").matches, capabilities: browserCapabilities(), playback: playbackDiagnostics(), companion: server }, (key, value: unknown) => ["url", "title", "authorization", "cookie", "csrf", "id"].includes(key) ? undefined : value, 2)
      .replace(/https?:\/\/[^\s"<>]+/gi, "[address omitted]").replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[token omitted]");
    setDiagnostics(data); setCopied(false);
  }
  return <div className="setting-card settings-category-card">
    <header><h2>{t("companion.title")}</h2><span>{t("companion.local")}</span></header>
    <label className="setting-select-row"><span><strong>{t("companion.preference")}</strong><small>{t("companion.automaticDescription")}</small></span>
      <select value={preferences.mode} onChange={(e) => update({ ...preferences, mode: e.target.value as PlaybackPreferences["mode"] })}>
        <option value="automatic">{t("companion.automatic")}</option><option value="direct">{t("companion.preferDirect")}</option><option value="compatibility">{t("companion.compatibility")}</option>
      </select>
    </label>
    <label className="setting-select-row"><span><strong>{t("companion.resolution")}</strong><small>{t("companion.resolutionDescription")}</small></span>
      <select value={preferences.resolution} onChange={(e) => update({ ...preferences, resolution: e.target.value as PlaybackPreferences["resolution"] })}>
        <option value="original">{t("companion.original")}</option><option value="1080">1080p</option><option value="720">720p</option>
      </select>
    </label>
    <p role="status">{health || t("common.loading")}</p>
    <button className="secondary" aria-expanded={!!diagnostics} onClick={() => void inspect()}>{t("companion.diagnostics")}</button>
    {diagnostics && <><pre className="companion-diagnostics" tabIndex={0}>{diagnostics}</pre><button className="secondary" onClick={() => void copyText(diagnostics).then(setCopied)}>{t(copied ? "companion.copied" : "companion.copy")}</button></>}
  </div>;
}
