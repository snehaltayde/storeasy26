// THE console image upload path (MED-01). MediaAdmin and MediaPicker both call
// uploadImage, so a phone photo gets the same resize, dimensions and preview
// wherever it is picked. Decisions live in lib/media-upload-plan.js; this file
// carries them out. The canvas and network parts are passed in as defaults, so
// node can run everything here except browserCodec and xhrSend themselves (those
// are covered by the browser drill in docs/cms-reviews/P1-MED-01.md).
//
// Never throws for a bad file: every failure comes back as { ok: false, message }
// with a message a founder can act on.
import {
  classifyUpload,
  encodeSteps,
  endedUpSmaller,
  fitEdges,
  hasTransparency,
  isAnimated,
  keepOriginal,
  plainServerMessage,
  renameFor,
  RESIZED_MAX_BYTES,
  shouldResize,
  sniffImage,
  TARGET_LONG_EDGE,
  thumbSize,
  uploadMessage,
} from "./media-upload-plan.js";

// ---- browser parts -----------------------------------------------------------

function draw(bitmap, width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, width, height);
  return { canvas, ctx };
}

export const browserCodec = {
  // Throws when this browser can't read the file (HEIC outside Safari, damage).
  // Resolves null when it has no way to try, and the server then decides.
  async decode(file) {
    if (typeof createImageBitmap !== "function") return null;
    try {
      return await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch (e) {
      // an older browser can reject the option itself; a damaged file fails again here
      if (e?.name === "TypeError") return await createImageBitmap(file);
      throw e;
    }
  },
  // A check that can't run counts as transparent: never risk flattening.
  hasAlpha(bitmap, { width, height }) {
    try {
      const { ctx } = draw(bitmap, width, height);
      return hasTransparency(ctx.getImageData(0, 0, width, height).data);
    } catch {
      return true;
    }
  },
  // Resolves null on failure. The blob's type is what the browser really wrote:
  // Safari answers a WebP request with a PNG.
  encode(bitmap, { mime, quality, width, height }) {
    const { canvas } = draw(bitmap, width, height);
    return new Promise((resolve) => canvas.toBlob(resolve, mime, quality));
  },
};

// fetch can't report upload progress; XHR can. status 0 means no answer came.
export function xhrSend(form, onPercent) {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/admin/media");
    xhr.upload.onprogress = (e) => e.lengthComputable && onPercent(Math.round((e.loaded / e.total) * 100));
    xhr.onload = () => {
      let json = {};
      try {
        json = JSON.parse(xhr.responseText);
      } catch {
        // a platform error page, not our route; the status still says enough
      }
      resolve({ status: xhr.status, json });
    };
    xhr.onerror = xhr.onabort = xhr.ontimeout = () => resolve({ status: 0, json: {} });
    xhr.send(form);
  });
}

// ---- the path ----------------------------------------------------------------

async function tryDecode(file, codec) {
  try {
    return { image: await codec.decode(file), failed: false };
  } catch {
    return { image: null, failed: true };
  }
}

// Walk the plan until something fits. A browser that answers with a different
// type can't write that format, so the rest of that format's steps are skipped.
async function encodeToFit(image, steps, codec) {
  const cannotWrite = new Set();
  let produced = false;
  for (const step of steps) {
    if (cannotWrite.has(step.mime)) continue;
    let blob = null;
    try {
      blob = await codec.encode(image, step);
    } catch {
      // out of memory on this size; a smaller step may still work
    }
    if (!blob) continue;
    if (blob.type !== step.mime) {
      cannotWrite.add(step.mime);
      continue;
    }
    produced = true;
    if (blob.size <= RESIZED_MAX_BYTES) return { blob, step, produced };
  }
  return { blob: null, step: null, produced };
}

async function makeThumb(image, { mime, width, height }, codec) {
  const size = thumbSize({ mime, width, height });
  if (!size) return null;
  try {
    const blob = await codec.encode(image, { mime: "image/webp", quality: 0.82, ...size });
    return blob ? { blob, ...size } : null;
  } catch {
    return null; // a preview is optional; the original still uploads
  }
}

// Decide what goes up the wire: { ok, file, width, height, thumb, reduced } or
// { ok: false, message }.
export async function prepareImage(file, codec = browserCodec) {
  let kind = classifyUpload({ type: file.type, name: file.name });
  if (kind.action === "refuse") return { ok: false, message: uploadMessage.notImage(file.name) };
  // No browser can open an empty file, and "may be damaged" isn't the real reason.
  if (!file.size) return { ok: false, message: uploadMessage.empty(file.name) };
  if (kind.unnamed) {
    const real = sniffImage(new Uint8Array(await file.slice(0, 12).arrayBuffer()));
    if (real) kind = classifyUpload({ type: real });
  }
  // an inferred type has to travel with the file, or the server refuses it
  const original = file.type === kind.mime ? file : new File([file], file.name, { type: kind.mime });

  const { image, failed } = await tryDecode(file, codec);
  if (!image) {
    if (kind.unnamed) return { ok: false, message: uploadMessage.notImage(file.name) };
    if (kind.action === "convert") return { ok: false, message: kind.heic ? uploadMessage.heic(file.name) : uploadMessage.unreadable(file.name) };
    // Every browser in use opens JPEG, PNG and WebP, so a failure here means damage.
    // The server only checks the first bytes, so it would store a broken image.
    if (kind.action === "resize" && (failed || file.size > RESIZED_MAX_BYTES)) return { ok: false, message: uploadMessage.unreadable(file.name) };
    // can't be read here but might be fine (SVG, an old browser): the server decides
    return { ok: true, file: original, width: null, height: null, thumb: null };
  }

  try {
    const { width, height } = image;
    if (kind.action === "as-is") return { ok: true, file: original, width, height, thumb: null };

    const untouched = async () => ({ ok: true, file: original, width, height, thumb: await makeThumb(image, { mime: kind.mime, width, height }, codec) });
    if (!shouldResize({ size: file.size, width, height, action: kind.action })) return await untouched();

    // Re-encoding keeps one frame and has to know about transparency. The browser
    // takes the type from the file's name, and images saved from the web often have
    // the wrong one, so from here the bytes decide, not the name.
    const bytes = new Uint8Array(await file.arrayBuffer());
    const real = sniffImage(bytes);
    if (real === "image/gif" || isAnimated(bytes)) {
      // Under the wrong name the server would refuse it, so say so without sending it.
      if (real !== kind.mime) return { ok: false, message: uploadMessage.notWhatItSays(file.name) };
      return file.size > RESIZED_MAX_BYTES ? { ok: false, message: uploadMessage.animatedTooBig(file.name) } : await untouched();
    }

    // JPEG can't be transparent; anything else gets looked at, at the size it
    // will actually be written.
    const hasAlpha = real !== "image/jpeg" && (await codec.hasAlpha(image, fitEdges(width, height, TARGET_LONG_EDGE)));
    const { blob, step, produced } = await encodeToFit(image, encodeSteps({ width, height, hasAlpha }), codec);
    if (keepOriginal({ size: file.size, encodedSize: blob?.size, action: kind.action })) return await untouched();
    if (!blob) return { ok: false, message: produced ? uploadMessage.tooDetailed(file.name) : uploadMessage.unreadable(file.name) };

    const output = new File([blob], renameFor(file.name, step.mime), { type: step.mime });
    return {
      ok: true,
      file: output,
      width: step.width,
      height: step.height,
      thumb: await makeThumb(image, { mime: step.mime, width: step.width, height: step.height }, codec),
      reduced: endedUpSmaller({ width, height }, step),
    };
  } finally {
    image.close?.();
  }
}

function buildForm({ file, width, height, thumb }) {
  const form = new FormData();
  form.set("file", file);
  if (width) {
    form.set("width", String(width));
    form.set("height", String(height));
  }
  if (thumb) {
    form.set("thumb", thumb.blob, "thumb.webp");
    form.set("thumbWidth", String(thumb.width));
    form.set("thumbHeight", String(thumb.height));
  }
  return form;
}

// One image, start to finish. onProgress gets { name, stage, percent } and
// progressLabel turns that into words. Resolves { ok: true, media, thumb, notice }
// or { ok: false, message }. notice is set when the founder should be told the
// image ended up smaller than expected.
export async function uploadImage(file, { onProgress, codec = browserCodec, send = xhrSend } = {}) {
  const name = file.name;
  try {
    onProgress?.({ name, stage: "preparing" });
    const prepared = await prepareImage(file, codec);
    if (!prepared.ok) return prepared;
    onProgress?.({ name, stage: "uploading", percent: 0 });
    const { status, json } = await send(buildForm(prepared), (percent) => onProgress?.(percent >= 100 ? { name, stage: "saving" } : { name, stage: "uploading", percent }));
    if (status < 200 || status >= 300 || !json?.ok) return { ok: false, message: plainServerMessage({ status, json, name }) };
    return { ok: true, media: json.media, thumb: json.thumb, notice: prepared.reduced ? uploadMessage.madeSmaller(name, prepared) : null };
  } catch {
    return { ok: false, message: uploadMessage.failed(name) };
  }
}
