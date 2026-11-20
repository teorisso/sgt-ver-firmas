import { ORIGIN, sgtUrl } from './sgt';

const viewerSelector = 'iframe,object,embed[src]';
const MAX_BYTES = 80 * 1024 * 1024;

export function isVisible(element: Element) {
  return isRendered(element) && !element.closest('[aria-hidden="true"]');
}

export function isRendered(element: Element) {
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  return Array.from(element.getClientRects()).some(rect => rect.width > 0 && rect.height > 0) &&
    !element.closest('[hidden]') && style?.visibility !== 'hidden' && style?.visibility !== 'collapse';
}

function localDocument(frame: HTMLIFrameElement | HTMLObjectElement) {
  try {
    const document = frame.contentDocument;
    return document && (document.URL === 'about:blank' || sgtUrl(document.URL, ORIGIN)) ? document : null;
  } catch {
    return null;
  }
}

export function sameOriginDocuments(top: Document) {
  const result: Document[] = [];
  function visit(doc: Document) {
    if (result.includes(doc)) return;
    result.push(doc);
    for (const frame of doc.querySelectorAll<HTMLIFrameElement | HTMLObjectElement>('iframe,object')) {
      if (!isRendered(frame)) continue;
      const inner = localDocument(frame);
      if (inner) visit(inner);
    }
  }
  visit(top);
  return result;
}

export interface Viewer {
  element: Element;
  url: URL;
  labelledPdf: boolean;
}

export function visibleViewers(documents: Document[]): Viewer[] {
  return documents.flatMap(doc => Array.from(doc.querySelectorAll(viewerSelector)).flatMap(element => {
    if (!isRendered(element)) return [];
    const object = element.localName === 'object';
    const frame = element.localName === 'iframe';
    const inner = frame ? localDocument(element as HTMLIFrameElement) : null;
    const attribute = element.getAttribute(object ? 'data' : 'src') ||
      (object ? element.querySelector('param[name="src" i],param[name="filename" i]')?.getAttribute('value') : inner?.URL);
    const url = sgtUrl(attribute ?? '', doc.baseURI);
    if (!url) return [];
    const type = (element.getAttribute('type') ??
      element.querySelector('param[name="type" i]')?.getAttribute('value'))?.split(';')[0].trim().toLowerCase();
    const pdfDocument = inner?.contentType === 'application/pdf';
    const labelledPdf = type === 'application/pdf' || pdfDocument || /\.pdf$/i.test(url.pathname);
    if (!labelledPdf && !frame) return [];
    if (frame && !labelledPdf) {
      // An iframe containing a HTML page is a wrapper. Its own viewer is scanned separately.
      if (inner?.URL !== 'about:blank' && inner?.contentType === 'text/html') {
        const nativePdf = inner.querySelector('embed[type="application/pdf" i],embed[type="application/x-google-chrome-pdf" i]');
        if (!nativePdf || sgtUrl(nativePdf.getAttribute('src') ?? '', inner.baseURI)) return [];
      }
    }
    const loaded = pdfDocument ? sgtUrl(inner.URL, doc.baseURI) : null;
    return [{ element, url: loaded ?? url, labelledPdf }];
  }));
}

export function withinViewerScope(element: Element, scope: Element) {
  let current: Element | null = element;
  while (current) {
    if (scope.contains(current)) return true;
    current = containingFrame(current);
  }
  return false;
}

export function containingFrame(element: Element) {
  try { return element.ownerDocument.defaultView?.frameElement ?? null; }
  catch { return null; }
}

export async function fetchPdf(url: URL, signal: AbortSignal) {
  const source = sgtUrl(url.href, ORIGIN);
  if (!source) throw new Error('El visor no pertenece al dominio del SGT.');
  let response: Response;
  try {
    response = await fetch(source.href, { credentials: 'same-origin', mode: 'same-origin',
      cache: 'no-store', redirect: 'error', signal });
  } catch {
    throw new Error('No se pudo leer el PDF del SGT. Volvé a abrir el adjunto y verificá la sesión.');
  }
  if (!response.ok || response.status === 206 || !response.body) {
    throw new Error('El SGT no entregó un PDF completo. Volvé a abrir el adjunto.');
  }
  if (Number(response.headers.get('content-length')) > MAX_BYTES) throw new Error('El PDF supera el límite de 80 MiB.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BYTES) {
        await reader.cancel();
        throw new Error('El PDF supera el límite de 80 MiB.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  if (!new TextDecoder().decode(bytes.subarray(0, 8)).startsWith('%PDF-')) {
    throw new Error('La respuesta del visor no contiene un PDF. Volvé a abrir el adjunto y verificá la sesión.');
  }
  return bytes;
}
