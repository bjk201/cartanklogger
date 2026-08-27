/**
 * Universeller Floating-Tooltip für ALLE Chart.js-Charts.
 *
 * Grundprinzip: Ein einziges Tooltip-Element hängt am <body> (nicht im Karten-DOM)
 * und wird im Viewport-Koordinatensystem positioniert. Dadurch kann es niemals von
 * overflow:hidden-Kacheln oder Kartenrändern abgeschnitten werden.
 *
 * Verhalten (identisch zur KM-Kachel):
 *  - Standardmäßig oberhalb des Cursor-/Datenpunkts
 *  - Flip nach unten, wenn oben kein Platz ist
 *  - Horizontales Klemmen an den Viewport-Rand mit echter Elementbreite
 */
import './chartTooltip.css';

const EL_ID = 'ctl-floating-tooltip';

function ensureEl(): HTMLElement {
  let el = document.getElementById(EL_ID);
  if (!el) {
    el = document.createElement('div');
    el.id = EL_ID;
    el.setAttribute('aria-hidden', 'true');
    document.body.appendChild(el);
  }
  return el;
}

const esc = (s: unknown) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function attachFloatingTooltip() {
  const el = ensureEl();

  return function external(context: any) {
    const { tooltip: tt, chart } = context;

    if (tt.opacity === 0 || !tt.dataPoints?.length) {
      el.style.opacity = '0';
      return;
    }

    const title = tt.title && tt.title.length ? String(tt.title[0]) : '';
    const colors: string[] = (tt.labelColors || []).map((c: any) =>
      typeof c === 'string' ? c : c?.borderColor || c?.backgroundColor || '#94a3b8'
    );

    const rows = (tt.body || [])
      .map((b: any, i: number) => {
        const col = esc(colors[i] || '#94a3b8');
        const lines = b.lines.map(esc).join('<br>');
        return (
          '<span class="ctl-ft__row"><i class="ctl-ft__dot" style="background:' +
          col + '"></i><span>' + lines + '</span></span>'
        );
      })
      .join('');

    el.innerHTML =
      (title ? '<div class="ctl-ft__title">' + esc(title) + '</div>' : '') + rows;

    // Synchron messen (Element hängt sichtbar-flex am Body, nur opacity 0)
    const w = el.offsetWidth;
    const h = el.offsetHeight;

    // Canvas-relativer Ankerpunkt -> Viewport-Koordinaten
    const rect = chart.canvas.getBoundingClientRect();
    const anchorX = rect.left + tt.caretX;
    const anchorY = rect.top + tt.caretY;

    // Vertikal: oben genug Platz? sonst unterhalb des Punkts
    const above = anchorY - h - 12;
    const below = anchorY + 14;
    let top = above;
    if (above < 8) top = below;
    if (top + h > window.innerHeight - 8) top = Math.max(8, window.innerHeight - h - 8);

    // Horizontal an Viewport-Ränder klemmen (Element wird per left=zentriert um Anker)
    const leftCenter = anchorX - w / 2;
    const left = Math.min(Math.max(leftCenter, 8), window.innerWidth - w - 8);

    el.style.left = Math.round(left) + 'px';
    el.style.top = Math.round(top) + 'px';
    el.style.opacity = '1';
  };
}
