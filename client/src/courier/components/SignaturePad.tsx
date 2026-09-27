import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import ErrorIcon from "@mui/icons-material/Error";

//touch + mouse signature on a canvas. pointer events cover both, touch-action none keeps the page from scrolling under the finger.
//value is a png data url, empty string when nothing was drawn
export function SignaturePad({ onChange, error }: { onChange: (dataUrl: string) => void; error?: string }) {
  const { t } = useTranslation();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const [empty, setEmpty] = useState(true);

  //size the bitmap to the css size once, scaled for retina screens
  useEffect(() => {
    const c = canvasRef.current;
    const ratio = window.devicePixelRatio || 1;
    c.width = c.offsetWidth * ratio;
    c.height = c.offsetHeight * ratio;
    const ctx = c.getContext("2d");
    ctx.scale(ratio, ratio);
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#1A2B3D";
  }, []);

  function pos(e: React.PointerEvent) {
    const r = canvasRef.current.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function down(e: React.PointerEvent) {
    drawing.current = true;
    canvasRef.current.setPointerCapture(e.pointerId);
    const p = pos(e);
    const ctx = canvasRef.current.getContext("2d");
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
  }

  function move(e: React.PointerEvent) {
    if (!drawing.current) return;
    const p = pos(e);
    const ctx = canvasRef.current.getContext("2d");
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    if (empty) setEmpty(false);
  }

  function up() {
    if (!drawing.current) return;
    drawing.current = false;
    onChange(canvasRef.current.toDataURL("image/png"));
  }

  function clear() {
    const c = canvasRef.current;
    c.getContext("2d").clearRect(0, 0, c.width, c.height);
    setEmpty(true);
    onChange("");
  }

  return (
    <div className={`signature-pad ${error ? "signature-pad--error" : ""}`}>
      <label>{t("signature")}<span className="req">*</span></label>
      <div className="signature-pad__canvas-wrap">
        <canvas ref={canvasRef} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} style={{ touchAction: "none" }} />
        {empty && <span className="signature-pad__hint">{t("signature_here")}</span>}
      </div>
      <div className="signature-pad__footer">
        <button type="button" className="link-button" onClick={clear}>{t("signature_clear")}</button>
        {error && <span className="signature-pad__error"><ErrorIcon fontSize="inherit" /> {error}</span>}
      </div>
    </div>
  );
}
