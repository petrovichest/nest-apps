const shells = [
  "M8 11h28l4 5v13l-6 8H10l-6-8V16Z",
  "M14 9h16c8 0 12 7 12 15 0 9-7 14-15 14H17C9 38 2 33 2 24 2 16 6 9 14 9Z",
  "M13 10h18l9 10v10l-8 8H12l-8-8V20Z",
  "M15 8h14l8 6 4 12-6 9-6 3H15l-6-3-6-9 4-12Z",
  "M10 12h24a5 5 0 0 1 5 5v13a8 8 0 0 1-8 8H13a8 8 0 0 1-8-8V17a5 5 0 0 1 5-5Z",
  "M22 7c10 0 17 7 17 16v9l-6 6H11l-6-6v-9C5 14 12 7 22 7Z",
  "M8 10h28l5 12-5 12-6 4H14l-6-4-5-12Z",
  "M13 10h18l7 5 2 15-5 7H9l-5-7 2-15Z",
];

const antennas = [
  "M20 13V7a3 3 0 1 1 4 0v6Z",
  "M9 14V6h5l4 8Zm17 0 4-8h5v8Z",
  "M24 12V6l5-3h6v3h-6v6Z",
  "M15 13V6l4-3h6l4 3v7h-4V7h-6v6Z",
  "M13 14V8L9 5V3h5l4 4v7Z",
  "M15 13V8h14v5Z",
  "M13 13V7h3V3h3v10Zm13 0V7h4v6Z",
  "M15 13V9l7-6 7 6v4Z",
];

const mounts = [
  "M3 19h4v11H3a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2Zm34 0h4a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-4Z",
  "M1 24l7-7v14Zm42 0-7-7v14Z",
  "M3 17h5v10H3Zm33 0h5v10h-5Z",
  "M2 26h6v7H2Zm34 0h6v7h-6Z",
];

const visors = [
  "M10 15h24l3 5-3 7H10l-3-7Z",
  "M14 14h16a7 7 0 1 1 0 14H14a7 7 0 1 1 0-14Z",
  "M11 15h22l4 3v8l-4 2H11l-4-2v-8Z",
  "M22 13a15 8 0 1 1 0 16 15 8 0 1 1 0-16Z",
  "M9 16h26l2 4-3 6H10l-3-6Z",
  "M9 16h26a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2Z",
  "M9 15h26l2 4-4 9H11l-4-9Z",
  "M9 14h10l3 2 3-2h10l2 5-3 9h-9l-3-2-3 2h-9l-3-9Z",
];

const eyes = [
  <path d="M13 19h6v4h-6Zm12 0h6v4h-6Z" />,
  <path d="M18 21a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm14 0a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />,
  <path d="M11 22l4-4 4 4-1.6 1.6-2.4-2.4-2.4 2.4Zm14 0 4-4 4 4-1.6 1.6-2.4-2.4-2.4 2.4Z" />,
  <path
    fillRule="evenodd"
    d="M22 17a4 4 0 1 1 0 8 4 4 0 1 1 0-8Zm0 2a2 2 0 1 0 0 4 2 2 0 1 0 0-4Z"
  />,
  <path d="M12 20h20v2.5H12Z" />,
  <path d="M14 18h3v7h-3Zm13 0h3v7h-3Z" />,
  <path d="m12 18 8 2.5-2 3.5-6-2Zm20 0-8 2.5 2 3.5 6-2Z" />,
  <path d="m15 17 4 4-4 4-4-4Zm14 0 4 4-4 4-4-4Z" />,
];

// Outer edge, enamel, bevel and visor light. These colors belong to the artwork.
const palettes = [
  ["#3c566d", "#8eb7d0", "#cee6f1", "#bdefff"],
  ["#735745", "#d4ad77", "#f2d9ac", "#ffe4ab"],
  ["#3d6257", "#8ab6a3", "#c9e6d5", "#bcf4dc"],
  ["#614965", "#b29bc0", "#e0c9e8", "#f3d5ff"],
  ["#734f48", "#d79784", "#f4c6b5", "#ffdccc"],
  ["#596146", "#aab487", "#dce1bb", "#e9f3b8"],
  ["#48536c", "#94a4cc", "#cbd6ef", "#d6e2ff"],
  ["#52615d", "#a1b7af", "#dce8e3", "#dcf8ef"],
];

function mixId(id: string, seed: number): number {
  // Mix the entire ID for each lane, including the last digits of UUIDs with a common prefix.
  let word = seed;
  for (let index = 0; index < id.length; index++) {
    word = Math.imul(word ^ id.charCodeAt(index), 0x01000193);
  }
  word = Math.imul(word ^ (word >>> 16), 0x85ebca6b);
  word = Math.imul(word ^ (word >>> 13), 0xc2b2ae35);
  return (word ^ (word >>> 16)) >>> 0;
}

function serialPaths(id: string, words: number[]): string[] {
  // Preserve every bit of a canonical UUID in the four-tone panel below the visor.
  // Arbitrary legacy IDs use the mixed words to keep the panel the same size.
  const serial =
    id.length === 36 && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(id)
      ? id.replaceAll("-", "")
      : words.map((word) => word.toString(16).padStart(8, "0")).join("");
  const paths = ["", "", "", ""];
  for (let cell = 0; cell < 64; cell++) {
    const digit = Number.parseInt(serial[Math.floor(cell / 2)]!, 16);
    const tone = (digit >> (cell % 2 === 0 ? 2 : 0)) & 3;
    paths[tone] += `M${14 + (cell % 16)} ${30 + Math.floor(cell / 16)}h1v1h-1Z`;
  }
  return paths;
}

export function WorkerAvatar({ id, projectKey }: { id: string; projectKey?: string | null }) {
  const structure = mixId(id, 0x811c9dc5);
  const expression = mixId(id, 0x9e3779b9);
  const trim = mixId(id, 0x27d4eb2f);
  const color = mixId(id, 0x165667b1);
  const project = projectKey ? mixId(projectKey, 0x165667b1) : undefined;
  const sharedDetail = project === undefined ? undefined : project % 3;
  const sharedStyle = (project ?? 0) >>> 8;
  const shell = shells[structure & 7]!;
  const antenna = antennas[(sharedDetail === 0 ? sharedStyle : structure >>> 3) & 7]!;
  const mount = mounts[(sharedDetail === 1 ? sharedStyle : trim) & 3]!;
  const visor = visors[expression & 7]!;
  // Use separate bits so portraits with the same visor can differ at card size.
  const eyeShape = eyes[(expression >>> 16) & 7]!;
  const [edge, enamel, bevel, light] = palettes[color & 7]!;
  const panelColor = sharedDetail === 2 ? palettes[sharedStyle & 7]![0] : edge;
  const panel = serialPaths(id, [structure, expression, trim, color]);

  return (
    <svg className="worker-avatar" aria-hidden="true" width={44} height={44} viewBox="0 0 44 44">
      <path d={antenna} fill={edge} />
      <path d={mount} fill={edge} />
      <path d={shell} fill={enamel} stroke={edge} strokeWidth="1.35" strokeLinejoin="round" />
      <path d="M14 12.5h16" fill="none" stroke={bevel} strokeWidth="1.5" strokeLinecap="round" />
      <path d={visor} fill="#212a2d" stroke={bevel} strokeWidth="1.25" />
      <g fill={light}>{eyeShape}</g>
      <rect x="13" y="29" width="18" height="6" rx="2" fill={panelColor} />
      {panel.map((path, tone) => (
        <path key={tone} d={path} fill={bevel} opacity={0.18 + tone * 0.18} />
      ))}
    </svg>
  );
}
