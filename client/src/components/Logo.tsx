import logoSvg from "../assets/mod-cropped.svg?raw";

//the ministry logo, inlined so its paths (fill="currentColor") take the color of the header (white) or the login card
//and the drawer (primary blue). the export came with a hardcoded navy fill, it was swapped for currentColor in the file.
//the css in _basic.scss sets the height and keeps the ratio (59:64, close to square)
export function Logo({ dark = false }: { dark?: boolean }) {
  return <span className={`logo ${dark ? "logo--dark" : ""}`} aria-hidden="true" dangerouslySetInnerHTML={{ __html: logoSvg }} />;
}
