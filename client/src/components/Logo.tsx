//stand in for the ministry logo that sits in the header of every screen. an svg of the real one goes here once we get it
export function Logo({ dark = false }: { dark?: boolean }) {
  const color = dark ? "#0A52BD" : "#FFFFFF";
  return (
    <svg className="logo" width="32" height="32" viewBox="0 0 32 32" aria-hidden="true">
      <path d="M6 26 L6 12 L10 8 L10 26 Z" fill={color} opacity="0.7" />
      <path d="M13 26 L13 8 L17 4 L17 26 Z" fill={color} />
      <path d="M20 26 L20 12 L24 8 L24 26 Z" fill={color} opacity="0.7" />
      <path d="M4 27 H28" stroke={color} strokeWidth="2" />
    </svg>
  );
}
