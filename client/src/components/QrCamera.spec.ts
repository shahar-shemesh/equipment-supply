import { act, createElement, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import QrScanner from "qr-scanner";
import { QrCamera } from "./QrCamera";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

//Keep the real scanner lifecycle: its delayed stream cleanup is absent from the dialog's mock.
it("keeps the current stream alive after StrictMode restarts the camera", async () => {
  vi.useFakeTimers();
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("isSecureContext", true);
  vi.stubGlobal("Worker", class {});
  class Stream {
    track = { stop: vi.fn(), getSettings: () => ({ facingMode: "environment" }) };
    getTracks() { return [this.track]; }
    getVideoTracks() { return [this.track]; }
    removeTrack() {}
  }
  vi.stubGlobal("MediaStream", Stream);
  const streams: Stream[] = [];
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: vi.fn(async () => {
    const stream = new Stream();
    streams.push(stream);
    return stream;
  }) } });
  vi.spyOn(QrScanner, "createQrEngine").mockResolvedValue({ detect: async () => [] } as any);
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(StrictMode, null, createElement(QrCamera, { onScan: vi.fn() }))));
    const video = host.querySelector("video");
    const current = video.srcObject as unknown as Stream;
    expect(current).toBeTruthy();
    await act(async () => vi.advanceTimersByTimeAsync(350));
    expect(video.srcObject).toBe(current);
    expect(current.track.stop).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    await act(async () => vi.advanceTimersByTimeAsync(350));
    expect(streams.every((stream) => stream.track.stop.mock.calls.length > 0)).toBe(true);
    host.remove();
  }
});
