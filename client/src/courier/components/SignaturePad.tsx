import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import ErrorIcon from "@mui/icons-material/Error";

//touch + mouse signature on a canvas. pointer events cover both, touch-action none keeps the page from scrolling under the finger.
//value is a png data url, empty string when nothing was drawn
export function SignaturePad({ onChange, error }: { onChange: (dataUrl: string) => void; error?: string }) {
  const { t } = useTranslation();
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  //every stroke as points in fractions of the canvas size (0..1), not pixels: the bitmap is wiped when the tablet
  //rotates or the window resizes, and the signature is drawn again scaled to the new size instead of being clipped
  //on the side that got narrower (the start side in rtl, where the signer begins)
  const strokes = useRef<{ x: number; y: number }[][]>([]);
  const [empty, setEmpty] = useState(true);

  //bitmap = css size * device pixel ratio, set on mount and again on every resize of the wrapper. a resize also resets
  //the context, so the pen settings come back with it. onChange is read once: the parent passes a state setter
  useEffect(() => {
    const observer = new ResizeObserver(() => {
      const c = canvasRef.current;
      const ratio = window.devicePixelRatio || 1;
      const w = c.offsetWidth;
      const h = c.offsetHeight;
      c.width = w * ratio;
      c.height = h * ratio;
      const ctx = c.getContext("2d");
      ctx.scale(ratio, ratio);
      pen(ctx);
      for (const stroke of strokes.current) {
        ctx.beginPath();
        ctx.moveTo(stroke[0].x * w, stroke[0].y * h);
        for (let i = 1; i < stroke.length; i++) ctx.lineTo(stroke[i].x * w, stroke[i].y * h);
        ctx.stroke();
      }
      //the png the form holds was rendered at the old size
      if (strokes.current.length) onChange(c.toDataURL("image/png"));
    });
    observer.observe(wrapRef.current);
    return () => observer.disconnect();
  }, []);

  function pen(ctx: CanvasRenderingContext2D) {
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#1A2B3D";
  }

  //css pixels for drawing, fractions for the stroke store
  function pos(e: React.PointerEvent) {
    const r = canvasRef.current.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function fraction(p: { x: number; y: number }) {
    const c = canvasRef.current;
    return { x: p.x / c.offsetWidth, y: p.y / c.offsetHeight };
  }

  function down(e: React.PointerEvent) {
    drawing.current = true;
    canvasRef.current.setPointerCapture(e.pointerId);
    const p = pos(e);
    strokes.current.push([fraction(p)]);
    const ctx = canvasRef.current.getContext("2d");
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
  }

  function move(e: React.PointerEvent) {
    if (!drawing.current) return;
    const p = pos(e);
    strokes.current[strokes.current.length - 1].push(fraction(p));
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
    strokes.current = [];
    const c = canvasRef.current;
    c.getContext("2d").clearRect(0, 0, c.width, c.height);
    setEmpty(true);
    onChange("");
  }

  return (
    <div className={`signature-pad ${error ? "signature-pad--error" : ""}`}>
      <label>{t("signature")}<span className="req">*</span></label>
      <div ref={wrapRef} className="signature-pad__canvas-wrap">
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
