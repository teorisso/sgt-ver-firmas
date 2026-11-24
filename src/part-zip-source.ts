import { partArchiveUrl, zipConfirmEvent, zipGenerationTimeout, zipPopupPath, zipResultEvent } from './part-zip-route';
import { zipSizeLimit, zipTooLarge } from './part-zip';
import { sgtUrl } from './sgt';
import { isVisible } from './viewer';

const unavailable = 'No se pudo obtener el ZIP del SGT. Verificá la sesión y volvé a intentarlo.';

function findZipPopup(doc: Document) {
  return Array.from(doc.querySelectorAll<HTMLIFrameElement>('.gx-popup iframe[src]')).filter(frame =>
    sgtUrl(frame.getAttribute('src') ?? '', doc.baseURI)?.pathname.toLowerCase() === zipPopupPath && isVisible(frame));
}

function confirmZip(popup: Document, signal: AbortSignal) {
  return new Promise<URL>((resolve, reject) => {
    function stop() {
      popup.removeEventListener(zipResultEvent, receive);
      signal.removeEventListener('abort', abort);
    }
    function abort() {
      stop();
      reject(signal.reason);
    }
    function receive(event: Event) {
      stop();
      const value = (event as CustomEvent<unknown>).detail;
      const archive = typeof value === 'string' ? partArchiveUrl(value, popup.URL) : null;
      if (archive) resolve(archive);
      else reject(new Error(unavailable));
    }
    signal.throwIfAborted();
    popup.addEventListener(zipResultEvent, receive);
    signal.addEventListener('abort', abort, { once: true });
    popup.dispatchEvent(new CustomEvent(zipConfirmEvent));
  });
}

async function readArchive(url: URL, popupUrl: string, signal: AbortSignal) {
  const response = await fetch(url.href, {
    credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store', referrer: popupUrl, signal,
  }).catch(() => { throw new Error(unavailable); });
  if (!response.ok || response.status === 206 || !response.body) throw new Error(unavailable);
  if (Number(response.headers.get('content-length')) > zipSizeLimit) {
    await response.body.cancel();
    throw new Error(zipTooLarge);
  }
  let length = 0;
  const stream = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      length += chunk.byteLength;
      if (length > zipSizeLimit) throw new Error(zipTooLarge);
      controller.enqueue(chunk);
    },
  }));
  return new Response(stream, { headers: { 'content-type': 'application/zip' } }).blob();
}

export async function getSgtPartZip(native: HTMLInputElement, signal: AbortSignal) {
  const doc = native.ownerDocument;
  if (!native.isConnected || !isVisible(native) || native.disabled || findZipPopup(doc).length) {
    throw new Error('Cerrá la ventana de descarga del SGT y volvé a intentar desde e-Partes.');
  }
  let frame: HTMLIFrameElement | undefined;
  try {
    signal.throwIfAborted();
    native.click();
    const deadline = performance.now() + 10_000;
    while (performance.now() < deadline) {
      signal.throwIfAborted();
      const frames = findZipPopup(doc);
      if (frames.length > 1) throw new Error(unavailable);
      frame = frames[0];
      const popup = frame?.contentDocument;
      if (popup?.readyState === 'complete' &&
        sgtUrl(popup.URL, doc.baseURI)?.pathname.toLowerCase() === zipPopupPath) {
        const generation = AbortSignal.any([signal, AbortSignal.timeout(zipGenerationTimeout + 1_000)]);
        const archive = await confirmZip(popup, generation);
        return await readArchive(archive, popup.URL, AbortSignal.any([signal, AbortSignal.timeout(180_000)]));
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(unavailable);
  } finally {
    frame?.closest('.gx-popup')?.querySelector<HTMLElement>('.gx-popup-close')?.click();
  }
}
