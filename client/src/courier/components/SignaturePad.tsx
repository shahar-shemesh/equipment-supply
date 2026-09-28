import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import ErrorIcon from "@mui/icons-material/Error";

type Point = { x: number; y: number };
type Props = { onChange: (dataUrl: string, strokes: Point[][]) => void; error?: string; strokes?: Point[][] };

//touch + mouse signature on a canvas. pointer events cover both, touch-action none keeps the page from scrolling under the finger.
//value is a png data url, empty string when nothing was drawn. `strokes` seeds the pad with a persisted signature (the
//draft saved on the device), the same fraction based points onChange hands back next to the png
export function SignaturePad({ onChange, error, strokes: initial }: Props) {
  const { t } = useTranslation();
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  //every stroke as points in fractions of the canvas size (0..1), not pixels: the bitmap is wiped when the tablet
  //rotates or the window resizes, and the signature is drawn again scaled to the new size instead of being clipped
  //on the side that got narrower (the start side in rtl, where the signer begins).
  //copied from the prop so drawing never mutates the draft row the parent still holds
  const strokes = useRef<Point[][]>(initial?.length ? initial.map((s) => s.map((p) => ({ x: p.x, y: p.y }))) : []);
  //the png last handed to the parent. a replay that renders the same bytes (a restore at the same size) is not a change
  const lastPng = useRef("");
  const [empty, setEmpty] = useState(!initial?.length);

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
        //a tap is a single point: a zero length line with the round cap is a dot, same as up() drew it
        if (stroke.length === 1) ctx.lineTo(stroke[0].x * w, stroke[0].y * h);
        ctx.stroke();
      }
      //the png the form holds was rendered at the old size. the first fire after a restore usually renders the same
      //bytes as the saved png, and then nothing is emitted, so restoring a draft does not write it again
      if (strokes.current.length) emit(c.toDataURL("image/png"));
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

  //hands the png and a copy of the strokes up, only when the png differs from the last one handed up
  function emit(png: string) {
    if (png === lastPng.current) return;
    lastPng.current = png;
    onChange(png, strokes.current.map((s) => s.slice()));
  }

  //css pixels for drawing, fractions for the stroke store
  function pos(e: React.PointerEvent) {
    const r = canvasRef.current.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function fraction(p: Point) {
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
    const c = canvasRef.current;
    const stroke = strokes.current[strokes.current.length - 1];
    //a tap without a move left a moveTo and nothing on the bitmap: draw the dot, so what is shown, stored and sent agree
    if (stroke.length === 1) {
      const ctx = c.getContext("2d");
      ctx.lineTo(stroke[0].x * c.offsetWidth, stroke[0].y * c.offsetHeight);
      ctx.stroke();
      if (empty) setEmpty(false);
    }
    emit(c.toDataURL("image/png"));
  }

  function clear() {
    strokes.current = [];
    const c = canvasRef.current;
    c.getContext("2d").clearRect(0, 0, c.width, c.height);
    setEmpty(true);
    lastPng.current = "";
    onChange("", []);
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
