import { isPartPreviewUrl } from './sgt';

export interface CaseLink {
  caseId: string;
  part: string;
}

const casePattern = '[a-z]{1,4}\\s+\\d{1,8}\\s*-\\s*\\d{4}\\s*-\\s*\\d{1,12}\\s*-\\s*[a-z]{1,6}';
const caseHeading = new RegExp(`^(?:tr[aá]mite\\s*:\\s*)?(${casePattern})(?=$|\\s)`, 'i');
const exactCase = new RegExp(`^${casePattern}$`, 'i');
const numberedPart = /^e[ -]?parte\s+(?:nro\.?|n[uú]m(?:ero)?\.?|n[°º.]?)\s*(\d{1,9})(?=$|[\s:–—-])/i;

function canonicalCase(value: string) {
  return value.replace(/\s*-\s*/g, '-').replace(/\s+/g, ' ').toUpperCase();
}

function partNumber(value: string) {
  const number = value.trim().replace(/^0+(?=\d)/, '');
  return /^[1-9]\d{0,8}$/.test(number) ? number : null;
}

export function gridCaseLink(control: HTMLElement, doc: Document): CaseLink | null {
  const caseId = caseHeading.exec(doc.title.trim())?.[1];
  const row = control.closest('tr');
  if (!caseId || !row) return null;
  // GeneXus exposes the e-Parte number in a named field on the same row as «Ver e-Parte».
  const fields = Array.from(row.querySelectorAll<HTMLElement>('[id]')).filter(element =>
    /^(?:span_)?W\d+TRAMITEPARTEORDEN_\d+$/i.test(element.id));
  const part = fields.length === 1 ? partNumber(fields[0].textContent ?? '') : null;
  return part ? { caseId: canonicalCase(caseId), part } : null;
}

export function previewCaseLink(doc: Document): CaseLink | null {
  if (!isPartPreviewUrl(doc.URL)) return null;
  const text = doc.body?.innerText || doc.body?.textContent || '';
  const links = new Map<string, CaseLink>();
  for (const label of [doc.title, ...text.split('\n')]) {
    const line = label.trim();
    const heading = caseHeading.exec(line);
    if (!heading) continue;
    const part = partNumber(numberedPart.exec(line.slice(heading[0].length).trim())?.[1] ?? '');
    if (!part) continue;
    const caseId = canonicalCase(heading[1]);
    links.set(`${caseId}/${part}`, { caseId, part });
  }
  return links.size === 1 ? [...links.values()][0] : null;
}

export function isCaseLink(value: unknown): value is CaseLink {
  if (!value || typeof value !== 'object') return false;
  const data = value as Partial<CaseLink>;
  return typeof data.caseId === 'string' && exactCase.test(data.caseId) &&
    typeof data.part === 'string' && /^[1-9]\d{0,8}$/.test(data.part);
}
