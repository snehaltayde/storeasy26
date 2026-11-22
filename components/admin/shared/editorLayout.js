// The full-width editor's numbers (ED-01), in one plain module so the shell's
// classes, the unit suite and the browser drill all read the same values.
// No JSX and no imports: plain node runs it.
//
// Widths at a glance (the console navigation is folded away on editor routes;
// each pane's 1px divider is inside its own width):
//   1440 wide: tree 224 | preview 928 (frame 912) | inspector 288
//   1280 wide: tree 224 | preview 768 (frame 752) | inspector 288
//   1024 wide: tree in a drawer | preview 736 (frame 720) | inspector 288
//   under 1024: the inspector goes under the preview, which takes the full width

// Routes that get the editor layout instead of the console's capped page.
export const EDITOR_ROUTES = ["/admin/storefront/designer"];

export function isEditorRoute(pathname) {
  if (typeof pathname !== "string") return false;
  return EDITOR_ROUTES.some((r) => pathname === r || pathname.startsWith(`${r}/`));
}

// Pane widths in px. The shell's Tailwind classes must say the same thing
// (w-56 = 14rem = 224px, w-72 = 18rem = 288px); the unit suite checks that.
export const TREE_WIDTH = 224;
export const INSPECTOR_WIDTH = 288;
// Space between the preview frame and the edge of its grey canvas, each side.
export const CANVAS_PAD = 8;

// Breakpoints, in px of browser width. Tailwind's xl and lg.
export const TREE_DOCKED_FROM = 1280; // below this the tree opens as a drawer
export const SIDE_BY_SIDE_FROM = 1024; // below this the inspector sits under the preview

// Each device renders its page at a real width. Desktop is a real desktop
// width, so the store shows its desktop layout, then shrinks to fit.
export const DEVICES = [
  { key: "mobile", label: "Mobile", width: 375 },
  { key: "tablet", label: "Tablet", width: 768 },
  { key: "desktop", label: "Desktop", width: 1280 },
];

export const deviceFor = (key) => DEVICES.find((d) => d.key === key) || DEVICES[DEVICES.length - 1];

// How a device's page fits the space the canvas has. The page always renders
// at the device's own width; when that is wider than the space, it is shrunk
// as a whole (never cut off and never re-laid out narrower), and the caption
// says so. `shown` is the on-screen width.
export function frameFit(deviceWidth, space) {
  const room = Math.max(0, Math.floor(space));
  if (!(deviceWidth > 0) || room === 0) return { width: deviceWidth, scale: 1, shown: 0, scaled: false };
  if (deviceWidth <= room) return { width: deviceWidth, scale: 1, shown: deviceWidth, scaled: false };
  const scale = room / deviceWidth;
  return { width: deviceWidth, scale, shown: room, scaled: true };
}

// The inline styles the preview canvas gives its frame, for a device and the
// space measured inside the canvas ({ w, h } in px). `box` is the on-screen
// box; `frame` makes the page inside render at the device's own width and
// shrink as a whole. Both are null until the space is known.
export function frameStyles(deviceKey, space) {
  const d = deviceFor(deviceKey);
  const fit = frameFit(d.width, space?.w ?? 0);
  if (!fit.shown || !(space?.h > 0)) return { device: d, fit, box: null, frame: null };
  return {
    device: d,
    fit,
    box: { width: fit.shown, height: Math.floor(space.h) },
    frame: {
      position: "absolute",
      top: 0,
      left: 0,
      width: d.width,
      height: Math.floor(space.h / fit.scale),
      border: 0,
      transform: fit.scaled ? `scale(${fit.scale})` : "none",
      transformOrigin: "0 0",
    },
  };
}

// Plain words for the caption over the frame.
export function fitCaption(device, fit) {
  const d = typeof device === "string" ? deviceFor(device) : device;
  if (!fit || !fit.shown) return `${d.label}, ${d.width} px wide`;
  if (!fit.scaled) return `${d.label}, ${d.width} px wide, actual size`;
  return `${d.label}, ${d.width} px wide, shown at ${Math.round(fit.scale * 100)}% to fit`;
}

// What the shell lays out at a given browser width, in px. The browser drill
// measures the real page against these numbers.
export function editorGeometry(viewport, { tree = true } = {}) {
  const docked = tree && viewport >= TREE_DOCKED_FROM;
  const sideBySide = viewport >= SIDE_BY_SIDE_FROM;
  const preview = sideBySide ? viewport - (docked ? TREE_WIDTH : 0) - INSPECTOR_WIDTH : viewport;
  const frameSpace = preview - 2 * CANVAS_PAD;
  return {
    treeDocked: docked,
    treeDrawer: tree && !docked,
    tree: docked ? TREE_WIDTH : 0,
    inspector: sideBySide ? INSPECTOR_WIDTH : viewport,
    preview,
    frameSpace,
  };
}
