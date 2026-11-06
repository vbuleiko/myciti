/**
 * Signed-distance-field image of the bus marker: a disc with a pointed "nose" at the top
 * (rotated by the travel bearing on the map). As an SDF icon it can be tinted per route with
 * `icon-color` and outlined with `icon-halo-*`.
 */
export function busMarkerSdf(size = 64, pixelRatio = 2): { width: number; height: number; data: Uint8Array; pixelRatio: number } {
  const S = size * pixelRatio;
  const c = S / 2;
  const R = S * 0.3; // disc radius
  // nose triangle: apex near the top edge, base inside the disc
  const apex: [number, number] = [c, S * 0.06];
  const b1: [number, number] = [c - R * 0.62, c - R * 0.55];
  const b2: [number, number] = [c + R * 0.62, c - R * 0.55];
  const buffer = 8 * pixelRatio; // SDF spread in px
  const data = new Uint8Array(S * S * 4);

  const segDist = (px: number, py: number, a: [number, number], b: [number, number]) => {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy));
  };
  const cross = (o: [number, number], a: [number, number], px: number, py: number) =>
    (a[0] - o[0]) * (py - o[1]) - (a[1] - o[1]) * (px - o[0]);

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const dDisc = Math.hypot(px - c, py - c) - R;
      const inside =
        Math.sign(cross(apex, b2, px, py)) === Math.sign(cross(b2, b1, px, py)) &&
        Math.sign(cross(b2, b1, px, py)) === Math.sign(cross(b1, apex, px, py));
      const edge = Math.min(segDist(px, py, apex, b1), segDist(px, py, b1, b2), segDist(px, py, b2, apex));
      const dTri = inside ? -edge : edge;
      const d = Math.min(dDisc, dTri); // union
      // TinySDF encoding: 0.75 (192) at the edge, falls off over `buffer` px
      const a = Math.max(0, Math.min(255, Math.round(255 - 255 * (d / buffer + 0.25))));
      const i = (y * S + x) * 4;
      data[i] = 255;
      data[i + 1] = 255;
      data[i + 2] = 255;
      data[i + 3] = a;
    }
  }
  return { width: S, height: S, data, pixelRatio };
}
