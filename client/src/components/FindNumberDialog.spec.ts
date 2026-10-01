import { act, createElement, StrictMode } from "react";
import { createRoot, Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FindNumberDialog } from "./FindNumberDialog";

const camera = vi.hoisted(() => ({ instances: [] as any[], start: null as any }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("qr-scanner", () => ({ default: class {
  static NO_QR_CODE_FOUND = "No QR code found";
  decode: (result: any) => void;
  options: any;
  start = vi.fn(() => camera.start());
  stop = vi.fn();
  pause = vi.fn(() => Promise.resolve(true));
  destroy = vi.fn();
  constructor(_video: any, decode: any, options: any) {
    this.decode = decode;
    this.options = options;
    camera.instances.push(this);
  }
} }));

let root: Root;
let host: HTMLDivElement;
let lookup: any;
let onFound: any;
let onClose: any;

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("isSecureContext", true);
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: vi.fn() } });
  camera.instances = [];
  camera.start = () => Promise.resolve();
  lookup = vi.fn().mockResolvedValue(42);
  onFound = vi.fn();
  onClose = vi.fn();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

/*──────────────────────────────────────────────────────────────────────────*/

async function render() {
  await act(async () => root.render(createElement(StrictMode, null, createElement(FindNumberDialog, { lookup, onFound, onClose }))));
}

/*──────────────────────────────────────────────────────────────────────────*/

async function click(label: string) {
  const button = Array.from(document.querySelectorAll("button")).find((b) => b.textContent === label || b.getAttribute("aria-label") === label);
  expect(button).toBeTruthy();
  await act(async () => button.click());
}

/*──────────────────────────────────────────────────────────────────────────*/

describe("QR lookup dialog", () => {
  it("scans the full camera image without distorting portrait or landscape frames", async () => {
    await render();
    const region = camera.instances.at(-1).options.calculateScanRegion;
    expect(region({ videoWidth: 1280, videoHeight: 720 })).toEqual({ x: 0, y: 0, width: 1280, height: 720, downScaledWidth: 1024, downScaledHeight: 576 });
    expect(region({ videoWidth: 720, videoHeight: 1280 })).toEqual({ x: 0, y: 0, width: 720, height: 1280, downScaledWidth: 576, downScaledHeight: 1024 });
  });

  it("reports repeated decoder failures and can restart without reopening the dialog", async () => {
    await render();
    const scanner = camera.instances.at(-1);
    await act(async () => {
      scanner.options.onDecodeError("No QR code found");
      scanner.options.onDecodeError("No QR code found");
      scanner.options.onDecodeError("No QR code found");
    });
    expect(document.body.textContent).not.toContain("find_decoder_failed");
    await act(async () => {
      for (let i = 0; i < 3; i++) scanner.options.onDecodeError(new Error("Worker timeout"));
    });
    expect(document.body.textContent).toContain("find_decoder_failed");
    await click("find_camera_restart");
    expect(document.body.textContent).not.toContain("find_decoder_failed");
    expect(scanner.destroy).toHaveBeenCalled();
    await act(async () => camera.instances.at(-1).decode({ data: "1234567" }));
    expect(lookup).toHaveBeenCalledWith("1234567");
  });

  it("looks up one number once even when two frames decode it", async () => {
    await render();
    const scanner = camera.instances.at(-1);
    await act(async () => {
      scanner.decode({ data: "001234" });
      scanner.decode({ data: "001234" });
    });
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledWith("001234");
    expect(onFound).toHaveBeenCalledWith(42);
    expect(scanner.pause).toHaveBeenCalledWith(true);
    expect(scanner.destroy).toHaveBeenCalled();
  });

  it("rejects a URL with digits and allows an explicit retry", async () => {
    await render();
    await act(async () => camera.instances.at(-1).decode({ data: "https://example.com/1234" }));
    expect(lookup).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("find_not_found");
    await click("find_scan_again");
    await act(async () => camera.instances.at(-1).decode({ data: "1234" }));
    expect(lookup).toHaveBeenCalledWith("1234");
  });

  it("keeps failed lookups stopped until retry and shows the ownership error", async () => {
    lookup.mockRejectedValue({ response: { status: 403 } });
    await render();
    const scanner = camera.instances.at(-1);
    await act(async () => scanner.decode({ data: "1234" }));
    expect(document.body.textContent).toContain("find_not_mine");
    await act(async () => scanner.decode({ data: "1234" }));
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(onFound).not.toHaveBeenCalled();
  });

  it("ignores a lookup response after the user closes the dialog", async () => {
    let finish: (id: number) => void;
    lookup.mockImplementation(() => new Promise<number>((resolve) => { finish = resolve; }));
    await render();
    await act(async () => camera.instances.at(-1).decode({ data: "1234" }));
    await click("find_close");
    await act(async () => finish(42));
    expect(onFound).not.toHaveBeenCalled();
  });

  it("releases the camera on manual entry, including late permission", async () => {
    let finish: () => void;
    camera.start = () => new Promise<void>((resolve) => { finish = resolve; });
    await render();
    const scanner = camera.instances.at(-1);
    await click("find_manual");
    expect(scanner.pause).toHaveBeenCalledWith(true);
    expect(scanner.destroy).toHaveBeenCalledOnce();
    await act(async () => finish());
    await act(async () => scanner.decode({ data: "1234" }));
    expect(lookup).not.toHaveBeenCalled();
    expect(document.querySelector("input")).toBeTruthy();
  });

  it("keeps manual entry available without HTTPS", async () => {
    vi.stubGlobal("isSecureContext", false);
    await render();
    expect(camera.instances).toHaveLength(0);
    expect(document.body.textContent).toContain("find_camera_https");
    await click("find_manual");
    expect(document.querySelector("input")).toBeTruthy();
  });

  it("submits manual entry through the same lookup without losing leading zeros", async () => {
    await render();
    await click("find_manual");
    const input = document.querySelector("input");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "001234");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => document.querySelector("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(lookup).toHaveBeenCalledWith("001234");
    expect(onFound).toHaveBeenCalledWith(42);
  });

  it("shows a camera error when startup fails", async () => {
    camera.start = () => Promise.reject(new DOMException("Permission denied", "NotAllowedError"));
    await render();
    expect(document.body.textContent).toContain("find_camera_denied");
    await click("find_manual");
    expect(document.querySelector("input")).toBeTruthy();
  });
});
