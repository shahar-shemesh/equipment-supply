import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Button } from "@mui/material";
import QrScanner from "qr-scanner";

export function QrCamera({ onScan }: { onScan: (text: string) => void }) {
  const { t } = useTranslation();
  const container = useRef<HTMLDivElement>(null);
  const callback = useRef(onScan);
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  const [attempt, setAttempt] = useState(0);
  callback.current = onScan; //parent renders should not reopen the camera or keep an old lookup callback

  useEffect(() => {
    setError("");
    setReady(false);
    if (!window.isSecureContext) {
      setError("find_camera_https");
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setError("find_camera_unavailable");
      return;
    }
    let disposed = false;
    let scanned = false;
    let decodeErrors = 0;
    //Each scanner owns its video. The library's delayed stop must never see a newer stream.
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.setAttribute("aria-label", t("find_title"));
    container.current.appendChild(video);
    //The box is sized by hand, not by object-fit: ios 26 webkit painted a 3:4 portrait stream contained in the 408x200
    //box 29px wide instead of 150 (the horizontal scale applied twice). Same contain math, in pixels, so the frame
    //fills its element and the browser has nothing to fit.
    const fit = () => {
      const box = container.current;
      if (!box || !video.videoWidth || !video.videoHeight) return;
      const scale = Math.min(box.clientWidth / video.videoWidth, box.clientHeight / video.videoHeight);
      video.style.width = `${Math.round(video.videoWidth * scale)}px`;
      video.style.height = `${Math.round(video.videoHeight * scale)}px`;
    };
    video.addEventListener("loadedmetadata", fit);
    video.addEventListener("resize", fit); //a stream can change its frame size after it starts
    window.addEventListener("resize", fit);
    const scanner = new QrScanner(video, (result) => {
      if (disposed || scanned) return;
      scanned = true; //lock before notifying React; another frame may already be waiting
      void scanner.pause(true);
      scanner.stop();
      callback.current(result.data);
    }, {
      preferredCamera: "environment", maxScansPerSecond: 8, returnDetailedScanResult: true,
      //The preview shows the full frame. A code near its edge must not fall outside an invisible crop.
      calculateScanRegion: (frame) => {
        const scale = Math.min(1, 1024 / Math.max(frame.videoWidth, frame.videoHeight));
        return { x: 0, y: 0, width: frame.videoWidth, height: frame.videoHeight, downScaledWidth: Math.round(frame.videoWidth * scale), downScaledHeight: Math.round(frame.videoHeight * scale) };
      },
      onDecodeError: (err) => {
        if (disposed || scanned) return;
        if (err === QrScanner.NO_QR_CODE_FOUND) {
          decodeErrors = 0; //normal camera frames without a code are not scanner failures
          return;
        }
        //A single slow frame can time out. Repeated worker failures need an explicit restart.
        if (++decodeErrors < 3) return;
        void scanner.pause(true);
        scanner.stop();
        setError("find_decoder_failed");
      },
    });

    scanner.start().then(() => {
      //The library stops late streams when destroyed while permission was still pending.
      if (!disposed) setReady(true);
    }).catch(async (err) => {
      if (disposed) return;
      //A stream may already be attached if video playback, rather than permission, failed.
      const stream = video.srcObject as MediaStream;
      stream?.getTracks().forEach((track) => track.stop());
      video.srcObject = null;
      scanner.destroy();
      //The library can report permission denial as "Camera not found" after trying its camera constraints.
      const permission = await navigator.permissions?.query({ name: "camera" as PermissionName }).catch(() => null);
      if (disposed) return;
      const reason = `${err?.name || ""} ${err?.message || err}`;
      setError(permission?.state === "denied" || /NotAllowed|Permission|denied/i.test(reason) ? "find_camera_denied" : "find_camera_unavailable");
    });

    return () => {
      disposed = true;
      window.removeEventListener("resize", fit);
      //Stop the tracks now; delayed library callbacks only retain this detached video.
      void scanner.pause(true);
      scanner.destroy(); //releases the stream, worker and visibility listeners
      video.remove();
    };
  }, [attempt]);

  return <>
    <div className="find-dialog__camera" ref={container} />
    {error ? <Alert severity="warning">{t(error)}</Alert> : <p role="status">{t(ready ? "find_camera_hint" : "find_camera_starting")}</p>}
    <Button onClick={() => setAttempt((value) => value + 1)} fullWidth>{t("find_camera_restart")}</Button>
  </>;
}
