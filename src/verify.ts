import 'reflect-metadata';
import { fromBER } from 'asn1js';
import {
  CrossReferenceStream, PDFArray, PDFDictionary, PDFDocument, PDFIndirectObject, PDFName, PDFNumeric,
  PDFObject, PDFObjectReader, PDFStream, PDFTextString, type PDFDocumentUpdate,
} from '@peculiar/pdf-core';
import { Certificate, CertificateRevocationList, ContentInfo, SignedData } from 'pkijs';
import {
  certificateName, certificatePath, certificates, checkCms, checkTimestamp, cmsEvidence, decodeCms, decodeOcsp, equal, readCms, revocation,
  sha256Hex, SIGNATURE_TIMESTAMP, type Check, type Revocation, type TrustMaterial,
} from './pki';
import trustBundle from '../trust/argentina.json';

export interface SignatureResult {
  kind: 'signature' | 'document-timestamp';
  signer: string;
  issuer: string;
  integrity: Check;
  confidence: Check;
  revocation: Revocation;
  laterChanges: boolean | null;
  timestamp: Check;
  verifiedTimestamp?: string;
}

let bundledTrust: TrustMaterial | undefined;

function decodeBase64(value: string) {
  return Uint8Array.from(atob(value), char => char.charCodeAt(0));
}

async function packagedCrls(issuer: Certificate, date: Date) {
  if (typeof chrome === 'undefined' || !chrome.runtime?.id) return [];
  const fingerprint = await sha256Hex(issuer.toSchema().toBER(false));
  const applicable = trustBundle.crls.filter(item => item.signedBy.includes(fingerprint) &&
    Date.parse(item.thisUpdate) <= date.getTime() && Date.parse(item.nextUpdate) >= date.getTime());
  return (await Promise.all(applicable.map(async item => {
    try {
      const response = await fetch(chrome.runtime.getURL(`crl/${item.file}`), {
        credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok || !response.body) return null;
      const content = response.body.pipeThrough(new DecompressionStream('gzip'));
      const bytes = await new Response(content).arrayBuffer();
      const decoded = fromBER(bytes, { maxNodes: 150_000 });
      return decoded.offset === bytes.byteLength ? new CertificateRevocationList({ schema: decoded.result }) : null;
    } catch {
      return null;
    }
  }))).filter((crl): crl is CertificateRevocationList => crl !== null);
}

function defaultTrust(): TrustMaterial {
  return bundledTrust ??= {
    roots: trustBundle.roots.map(item => Certificate.fromBER(decodeBase64(item.der))),
    intermediates: trustBundle.intermediates.map(item => Certificate.fromBER(decodeBase64(item))),
    crls: [],
  };
}

function entry(node: PDFDictionary, key: string) {
  return node.has(key) ? node.get(key) : undefined;
}

function name(node: PDFDictionary, key: string) {
  const value = entry(node, key);
  return value instanceof PDFName ? value.text : '';
}

function isLinearizedBase(document: PDFDocument, first: PDFDocumentUpdate, firstOffset: number, main: PDFDocumentUpdate) {
  if (main.previous || !first.xref || !main.xref || first.view.length >= main.view.length) return false;
  const mainOffset = first.xref.Prev;
  if (mainOffset === null || mainOffset <= first.view.length || mainOffset > main.xref.view.byteOffset) return false;
  try {
    const reader = PDFObject.getReader(document.view);
    PDFObjectReader.skip(reader);
    const firstObject = PDFIndirectObject.fromPDF(reader);
    if (reader.position > firstOffset || !(firstObject.value instanceof PDFDictionary) ||
      firstObject.value instanceof PDFStream) return false;
    const value = (key: string) => {
      const item = entry(firstObject.value as PDFDictionary, key);
      return item instanceof PDFNumeric ? item.value : NaN;
    };
    if (value('Linearized') !== 1 || value('L') !== main.view.length) return false;
    const table = value('T');
    if (!Number.isSafeInteger(table)) return false;
    return main.xref instanceof CrossReferenceStream
      ? table <= mainOffset && mainOffset - table <= 2 &&
        document.view.subarray(table, mainOffset).every(byte => byte === 10 || byte === 13)
      : table >= mainOffset && table < main.view.length;
  } catch {
    return false;
  }
}

function revisionBoundaries(document: PDFDocument) {
  const invalid = () => new Error('El PDF tiene una estructura de revisiones inválida.');
  const ends = new Set<number>();
  let offset = document.update.startXref;
  let linearized = false;
  for (let update: PDFDocumentUpdate | null = document.update; update; update = update.previous) {
    if (!update.xref) throw invalid();
    const previous = update.previous;
    const linkedOffset = update.xref.Prev;
    const forwards = previous !== null && linkedOffset !== null && linkedOffset > offset;
    if (forwards && !isLinearizedBase(document, update, offset, previous)) throw invalid();
    if (previous && (linkedOffset === null || linkedOffset === offset ||
      (!forwards && previous.view.length >= update.view.length))) throw invalid();

    // ISO 32000-2 Annex F uses two cross-reference sections for a single linearized base.
    if (forwards) linearized = true;
    else ends.add(update.view.length);
    const limit = forwards ? previous!.view.length - 1 : update.xref.view.byteOffset;
    if (update.getObjects().some(object => object.offset > limit)) throw invalid();
    offset = linkedOffset ?? 0;
  }
  if (document.wrongStructure && !linearized) throw invalid();
  return ends;
}

function findSignatures(document: PDFDocument) {
  const found = new Map<string, PDFDictionary>();
  const visited = new WeakSet<PDFObject>();
  function walk(value: PDFObject) {
    if (visited.has(value)) return;
    visited.add(value);
    if (value instanceof PDFDictionary) {
      const type = name(value, 'Type');
      if (type === 'Sig' || type === 'DocTimeStamp' ||
          (value.has('Contents') && value.has('ByteRange') && (value.has('Filter') || value.has('SubFilter')))) {
        const key = value.view.buffer === document.view.buffer
          ? String(value.view.byteOffset) : `compressed-${found.size}`;
        if (!found.has(key)) found.set(key, value);
        return;
      }
      for (const child of value.items.values()) walk(child);
    } else if (value instanceof PDFArray) {
      for (const child of value.items) walk(child);
    }
  }

  for (let update: typeof document.update | null = document.update; update; update = update.previous) {
    // Each revision's own xref entries include fields that were removed or replaced later.
    for (const object of update.items) {
      if (object.type === 'n' || object.type === 'c') walk(object.value);
    }
  }
  return [...found.values()];
}

function signedRevision(dictionary: PDFDictionary, pdf: Uint8Array<ArrayBuffer>, revisionEnds: Set<number>) {
  const ranges = entry(dictionary, 'ByteRange');
  const contents = entry(dictionary, 'Contents');
  if (!(ranges instanceof PDFArray) || !(contents instanceof PDFTextString) || ranges.items.length !== 4) return null;
  const [start, gapStart, gapEnd, tailLength] = ranges.items.map(value => value instanceof PDFNumeric ? value.value : NaN);
  const end = gapEnd + tailLength;
  if (![start, gapStart, gapEnd, tailLength, end].every(Number.isSafeInteger) ||
      start !== 0 || gapStart <= 0 || gapEnd <= gapStart || tailLength <= 0 || end > pdf.length ||
      contents.view.buffer !== pdf.buffer || gapStart !== contents.view.byteOffset - pdf.byteOffset ||
      gapEnd !== gapStart + contents.view.length) return null;
  // The range must cover a real revision. Some producers omit the final CR/LF from that range.
  if (![...revisionEnds].some(boundary => boundary >= end && boundary - end <= 2 &&
      pdf.subarray(end, boundary).every(byte => byte === 10 || byte === 13)) &&
      ![...revisionEnds].some(boundary => boundary < end &&
        pdf.subarray(boundary, end).every(byte => [0, 9, 10, 12, 13, 32].includes(byte)))) return null;

  const signed = new Uint8Array(gapStart + tailLength);
  signed.set(pdf.subarray(0, gapStart));
  signed.set(pdf.subarray(gapEnd, end), gapStart);
  return { signed: signed.buffer, cmsBytes: contents.toUint8Array(), end };
}

async function documentEvidence(document: PDFDocument, trust: TrustMaterial): Promise<TrustMaterial> {
  const cache = new WeakMap<Certificate, Map<number, Promise<CertificateRevocationList[]>>>();
  const evidence = { ...trust, crls: [...trust.crls], intermediates: [...trust.intermediates], ocsps: [...trust.ocsps ?? []] };
  const load = trust === bundledTrust ? packagedCrls : trust.loadCrls;
  if (load) evidence.loadCrls = (issuer, date) => {
    const onDates = cache.get(issuer) ?? new Map<number, Promise<CertificateRevocationList[]>>();
    cache.set(issuer, onDates);
    const time = date.getTime();
    if (!onDates.has(time)) onDates.set(time, load(issuer, date));
    return onDates.get(time)!;
  };
  const dss = entry(document.catalog, 'DSS');
  if (!(dss instanceof PDFDictionary)) return evidence;
  for (const key of ['CRLs', 'Certs', 'OCSPs'] as const) {
    const streams = entry(dss, key);
    if (!(streams instanceof PDFArray)) continue;
    for (let i = 0; i < Math.min(streams.length, 100); i++) {
      try {
        const stream = streams.get(i);
        if (!(stream instanceof PDFStream)) continue;
        const buffer = await stream.decode();
        if (buffer.byteLength > 16 * 1024 * 1024) continue;
        if (key === 'CRLs') evidence.crls.push(CertificateRevocationList.fromBER(buffer));
        else if (key === 'Certs') evidence.intermediates.push(Certificate.fromBER(buffer));
        else {
          const ocsp = decodeOcsp(buffer);
          if (ocsp) evidence.ocsps.push(ocsp);
        }
      } catch { /* An invalid evidence object does not invalidate a signature. */ }
    }
  }
  return evidence;
}

function emptyResult(kind: SignatureResult['kind'], laterChanges: boolean | null): SignatureResult {
  return { kind, signer: 'No identificado', issuer: 'No identificado', integrity: 'unknown',
    confidence: 'unknown', revocation: 'unknown', timestamp: 'unknown', laterChanges };
}

async function withTimestamp(cms: SignedData, index: number, trust: TrustMaterial) {
  const signer = cms.signerInfos[index];
  const attrs = signer.unsignedAttrs?.attributes.filter(attribute => attribute.type === SIGNATURE_TIMESTAMP) ?? [];
  let invalid = false;
  for (const attribute of attrs) {
    for (const value of attribute.values) {
      try {
        const token = readCms(new ContentInfo({ schema: value }));
        const proof = await checkTimestamp(token, signer.signature.getValue(), trust);
        if ('time' in proof && proof.time) return { state: proof.state, time: proof.time };
        if (proof.state === 'invalid') invalid = true;
      } catch { /* Other timestamp tokens may still be available. */ }
    }
  }
  return { state: invalid ? 'invalid' as Check : 'unknown' as Check };
}

export async function verifyPdf(bytes: Uint8Array<ArrayBuffer>, trust: TrustMaterial = defaultTrust()) {
  const pdf = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes : bytes.slice();
  const document = await PDFDocument.fromPDF(pdf);
  if (document.update.Encrypt) throw new Error('El PDF está cifrado. No se pudo leer su estructura de firmas.');
  const revisionEnds = revisionBoundaries(document);
  const dictionaries = findSignatures(document);
  if (!dictionaries.length) return [];
  const evidence = await documentEvidence(document, trust);
  const now = new Date();
  const results: { end: number; signature: SignatureResult }[] = [];
  for (const dictionary of dictionaries) {
    const subFilter = name(dictionary, 'SubFilter');
    const kind = subFilter === 'ETSI.RFC3161' || name(dictionary, 'Type') === 'DocTimeStamp'
      ? 'document-timestamp' : 'signature';
    const revision = signedRevision(dictionary, pdf, revisionEnds);
    const end = revision?.end ?? Number.MAX_SAFE_INTEGER;
    const base = emptyResult(kind, revision ? end < pdf.length : null);
    if (!revision) {
      results.push({ end, signature: { ...base, integrity: 'invalid' } });
      continue;
    }
    if (!['adbe.pkcs7.detached', 'ETSI.CAdES.detached', 'adbe.pkcs7.sha1', 'ETSI.RFC3161'].includes(subFilter)) {
      results.push({ end, signature: base });
      continue;
    }
    let cms: SignedData;
    try {
      cms = decodeCms(revision.cmsBytes);
    } catch {
      results.push({ end, signature: base });
      continue;
    }
    const cryptoEvidence = cmsEvidence(cms, evidence);
    if (kind === 'document-timestamp') {
      const proof = await checkTimestamp(cms, revision.signed, cryptoEvidence);
      const cert = 'cert' in proof ? proof.cert : null;
      const time = 'time' in proof ? proof.time : undefined;
      const path = cert ? await certificatePath(cert, certificates(cms), cryptoEvidence, time ?? now) : null;
      results.push({ end, signature: { ...base, integrity: proof.integrity, timestamp: proof.state,
        signer: certificateName(cert?.subject), issuer: certificateName(cert?.issuer),
        confidence: path ? 'valid' : 'unknown', revocation: await revocation(path, cryptoEvidence, time ?? now),
        verifiedTimestamp: time?.toISOString() } });
      continue;
    }

    const content = cms.encapContentInfo.eContent;
    const isSha1 = subFilter === 'adbe.pkcs7.sha1';
    const expectedContent = isSha1 && content
      ? equal(new Uint8Array(content.getValue()), new Uint8Array(await crypto.subtle.digest('SHA-1', revision.signed)))
      : !isSha1 && !content;
    if (cms.encapContentInfo.eContentType !== SignedData.ID_DATA || !cms.signerInfos.length) {
      results.push({ end, signature: base });
      continue;
    }
    for (let index = 0; index < cms.signerInfos.length; index++) {
      const checked = await checkCms(cms, index, revision.signed, subFilter === 'ETSI.CAdES.detached');
      const cert = checked.cert;
      const integrity = expectedContent ? checked.integrity : 'invalid';
      const stamp = integrity === 'valid' ? await withTimestamp(cms, index, cryptoEvidence) : { state: 'unknown' as Check };
      const date = stamp.time ?? now;
      const path = cert ? await certificatePath(cert, certificates(cms), cryptoEvidence, date) : null;
      results.push({ end, signature: { ...base, integrity,
        signer: certificateName(cert?.subject), issuer: certificateName(cert?.issuer),
        confidence: path ? 'valid' : 'unknown', revocation: await revocation(path, cryptoEvidence, date),
        timestamp: stamp.state, verifiedTimestamp: stamp.time?.toISOString() } });
    }
  }
  return results.sort((a, b) => a.end - b.end).map(result => result.signature);
}
