import { BitString, Integer, ObjectIdentifier, OctetString, Primitive, Sequence, Utf8String } from 'asn1js';
import {
  AlgorithmIdentifier, Attribute, AttributeTypeAndValue, BasicConstraints, BasicOCSPResponse, CertID, Certificate,
  CertificateRevocationList, ContentInfo, CryptoEngine, EncapsulatedContentInfo, Extension,
  ExtKeyUsage, IssuerAndSerialNumber, MessageImprint, ResponseData, RevokedCertificate, SignedAndUnsignedAttributes,
  SignedData, SignerInfo, SingleResponse, Time, TSTInfo,
} from 'pkijs';

const engine = new CryptoEngine({ name: 'test', crypto });
const sha256 = '2.16.840.1.101.3.4.2.1';
const encode = (str: string) => new TextEncoder().encode(str);
const sequence = (...value: (Sequence | OctetString)[]) => new Sequence({ value });

async function issue(name: string, serial: number, now: Date,
  issuer?: { cert: Certificate; keys: CryptoKeyPair }, tsa = false) {
  const keys = await crypto.subtle.generateKey({
    name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256',
  }, true, ['sign', 'verify']);
  const cert = new Certificate({ version: 2, serialNumber: new Integer({ value: serial }) });
  cert.subject.typesAndValues.push(new AttributeTypeAndValue({ type: '2.5.4.3', value: new Utf8String({ value: name }) }));
  cert.issuer = issuer?.cert.subject ?? cert.subject;
  cert.notBefore.value = new Date(now.getTime() - 10 * 86_400_000);
  cert.notAfter.value = new Date(now.getTime() + 10 * 86_400_000);
  cert.extensions = [new Extension({ extnID: '2.5.29.15', critical: true, extnValue: new BitString({
    valueHex: new Uint8Array([issuer ? 0x80 : 0x06]).buffer,
  }).toBER(false) })];
  if (!issuer) cert.extensions.push(new Extension({ extnID: '2.5.29.19', critical: true,
    extnValue: new BasicConstraints({ cA: true }).toSchema().toBER(false) }));
  if (tsa) cert.extensions.push(new Extension({ extnID: '2.5.29.37', critical: true,
    extnValue: new ExtKeyUsage({ keyPurposes: ['1.3.6.1.5.5.7.3.8'] }).toSchema().toBER(false) }));
  await cert.subjectPublicKeyInfo.importKey(keys.publicKey, engine);
  await cert.sign(issuer?.keys.privateKey ?? keys.privateKey, 'SHA-256', engine);
  return { cert: Certificate.fromBER(cert.toSchema().toBER(false)), keys };
}

async function crlFor(root: Awaited<ReturnType<typeof issue>>, cert: Certificate, now: Date, revoked = false, stale = false) {
  const list = new CertificateRevocationList({ issuer: root.cert.subject,
    thisUpdate: new Time({ type: 0, value: new Date(now.getTime() - 86_400_000) }),
    nextUpdate: new Time({ type: 0, value: new Date(now.getTime() + (stale ? -1000 : 86_400_000)) }) });
  if (revoked) list.revokedCertificates = [new RevokedCertificate({ userCertificate: cert.serialNumber,
    revocationDate: new Time({ type: 0, value: new Date(now.getTime() - 3_600_000) }) })];
  await list.sign(root.keys.privateKey, 'SHA-256', engine);
  return CertificateRevocationList.fromBER(list.toSchema().toBER(false));
}

async function ocspFor(cert: Certificate, issuer: Certificate, key: CryptoKey, now: Date) {
  const certID = await CertID.create(cert, { issuerCertificate: issuer, hashAlgorithm: 'SHA-256' }, engine);
  const response = new BasicOCSPResponse({ tbsResponseData: new ResponseData({
    responderID: issuer.subject,
    producedAt: new Date(now.getTime() - 1000),
    responses: [new SingleResponse({ certID, certStatus: new Primitive({ idBlock: { tagClass: 3, tagNumber: 0 } }),
      thisUpdate: new Date(now.getTime() - 2000), nextUpdate: new Date(now.getTime() + 86_400_000) })],
  }) });
  await response.sign(key, 'SHA-256', engine);
  return BasicOCSPResponse.fromBER(response.toSchema().toBER(false));
}

async function signedCms(data: ArrayBuffer, identity: Awaited<ReturnType<typeof issue>>,
  contentType: string = SignedData.ID_DATA, embedded?: ArrayBuffer) {
  const { cert, keys } = identity;
  const digest = await crypto.subtle.digest('SHA-256', embedded ?? data);
  const fingerprint = await crypto.subtle.digest('SHA-256', cert.toSchema().toBER(false));
  const attrs = [
    new Attribute({ type: '1.2.840.113549.1.9.3', values: [new ObjectIdentifier({ value: contentType })] }),
    new Attribute({ type: '1.2.840.113549.1.9.4', values: [new OctetString({ valueHex: digest })] }),
    new Attribute({ type: '1.2.840.113549.1.9.16.2.47',
      values: [sequence(sequence(sequence(new OctetString({ valueHex: fingerprint }))))] }),
  ];
  const cms = new SignedData({
    version: embedded ? 3 : 1,
    encapContentInfo: new EncapsulatedContentInfo({ eContentType: contentType,
      ...(embedded ? { eContent: new OctetString({ valueHex: embedded }) } : {}) }),
    certificates: [cert],
    signerInfos: [new SignerInfo({ version: 1,
      sid: new IssuerAndSerialNumber({ issuer: cert.issuer, serialNumber: cert.serialNumber }),
      signedAttrs: new SignedAndUnsignedAttributes({ type: 0, attributes: attrs }) })],
  });
  await cms.sign(keys.privateKey, 0, 'SHA-256', data, engine);
  return cms;
}

function wrap(cms: SignedData) {
  return new ContentInfo({ contentType: ContentInfo.SIGNED_DATA, content: cms.toSchema() });
}

const marker = '0000000000 0000000000 0000000000 0000000000';
const padding = '0'.repeat(24_576);
const pageContents = 'BT (PDF sintetico original) Tj ET';

function revision(previous: string, objects: [number, string][], size: number) {
  let output = previous || '%PDF-1.7\n';
  const offsets = new Map<number, number>();
  for (const [id, content] of objects) {
    offsets.set(id, output.length);
    output += `${id} 0 obj\n${content}\nendobj\n`;
  }
  const xref = output.length;
  output += 'xref\n';
  if (!previous) output += '0 1\n0000000000 65535 f \n';
  for (const [id, offset] of offsets) output += `${id} 1\n${('0000000000' + offset).slice(-10)} 00000 n \n`;
  const prior = previous.match(/startxref\n(\d+)\n%%EOF\n$/)?.[1];
  return output + `trailer\n<< /Root 1 0 R /Size ${size} ${prior ? '/Prev ' + prior : ''} >>\nstartxref\n${xref}\n%%EOF\n`;
}

async function addSignature(pdf: string, id: number, sign: (data: ArrayBuffer) => Promise<ContentInfo>) {
  const widget = id + 1;
  const fields = id === 5 ? '6 0 R' : '6 0 R 8 0 R';
  let unsigned = revision(pdf, [
    [1, `<< /Type /Catalog /Pages 2 0 R /AcroForm << /SigFlags 3 /Fields [${fields}] >> >>`],
    [id, `<< /Type /Sig /Filter /Adobe.PPKLite /SubFilter /ETSI.CAdES.detached /ByteRange [${marker}] /Contents <${padding}> >>`],
    [widget, `<< /Type /Annot /Subtype /Widget /FT /Sig /T (Firma invisible ${id}) /Rect [0 0 0 0] /P 3 0 R /V ${id} 0 R >>`],
  ], widget + 1);
  const start = unsigned.lastIndexOf('<' + padding);
  const end = start + padding.length + 2;
  const byteRange = [0, start, end, unsigned.length - end].map(value => String(value).padStart(10, '0')).join(' ');
  const markerOffset = unsigned.lastIndexOf(marker);
  unsigned = unsigned.slice(0, markerOffset) + byteRange + unsigned.slice(markerOffset + marker.length);
  const content = await sign(encode(unsigned.slice(0, start) + unsigned.slice(end)).buffer);
  const hex = Buffer.from(content.toSchema().toBER(false)).toString('hex').toUpperCase();
  if (hex.length > padding.length) throw new Error('La firma de prueba excede el espacio reservado.');
  return unsigned.slice(0, start + 1) + hex.padEnd(padding.length, '0') + unsigned.slice(end - 1);
}

function linearizedPdf() {
  const pad = (n: number) => String(n).padStart(10, '0');
  const header = (length: number, main: number) => '%PDF-1.7\n' +
    `9 0 obj\n<< /Linearized 1 /L ${pad(length)} /H [0 0] /O 3 /E ${pad(main)} /N 1 /T ${pad(main + 9)} >>\nendobj\n`;
  const first = (main: number) => 'xref\n9 1\n0000000009 00000 n \n' +
    `trailer\n<< /Root 1 0 R /Size 10 /Prev ${pad(main)} >>\nstartxref\n0\n%%EOF\n`;
  const beginning = header(0, 0) + first(0);
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Contents 4 0 R >>',
    `<< /Length ${pageContents.length} >>\nstream\n${pageContents}\nendstream`,
  ];
  let body = '';
  let index = 'xref\n0 5\n0000000000 65535 f \n';
  for (const [i, object] of objects.entries()) {
    index += `${pad(beginning.length + body.length)} 00000 n \n`;
    body += `${i + 1} 0 obj\n${object}\nendobj\n`;
  }
  const main = beginning.length + body.length;
  const end = body + index + `trailer\n<< /Size 10 >>\nstartxref\n${header(0, 0).length}\n%%EOF\n`;
  const length = beginning.length + end.length;
  return header(length, main) + first(main) + end;
}

export async function createFixtures() {
  const now = new Date();
  const root = await issue('CA sintética', 1, now);
  const [first, second, tsa] = await Promise.all([
    issue('Empresa sintética 1', 2, now, root),
    issue('Empresa sintética 2', 3, now, root),
    issue('TSA sintética', 4, now, root, true),
  ]);
  const unsigned = revision('', [
    [1, '<< /Type /Catalog /Pages 2 0 R >>'],
    [2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'],
    [3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Contents 4 0 R >>'],
    [4, `<< /Length ${pageContents.length} >>\nstream\n${pageContents}\nendstream`],
  ], 5);
  const single = await addSignature(unsigned, 5, async data => wrap(await signedCms(data, first)));
  const linearized = await addSignature(linearizedPdf(), 5, async data => wrap(await signedCms(data, first)));
  const multiple = await addSignature(single, 7, async data => wrap(await signedCms(data, second)));
  const timestamped = await addSignature(unsigned, 5, async data => {
    const cms = await signedCms(data, first);
    const signature = cms.signerInfos[0].signature.getValue();
    const token = new TSTInfo({ version: 1, policy: '1.2.3.4.5', serialNumber: new Integer({ value: 100 }), genTime: now,
      messageImprint: new MessageImprint({ hashAlgorithm: new AlgorithmIdentifier({ algorithmId: sha256 }),
        hashedMessage: new OctetString({ valueHex: await crypto.subtle.digest('SHA-256', signature) }) }) });
    const stamp = wrap(await signedCms(signature, tsa, '1.2.840.113549.1.9.16.1.4', token.toSchema().toBER(false)));
    cms.signerInfos[0].unsignedAttrs = new SignedAndUnsignedAttributes({ type: 1, attributes: [
      new Attribute({ type: '1.2.840.113549.1.9.16.2.14', values: [stamp.toSchema()] }),
    ] });
    return wrap(cms);
  });
  const [good, revoked, stale, ocsp, forgedOcsp] = await Promise.all([
    crlFor(root, first.cert, now), crlFor(root, first.cert, now, true), crlFor(root, first.cert, now, false, true),
    ocspFor(first.cert, root.cert, root.keys.privateKey, now), ocspFor(first.cert, root.cert, second.keys.privateKey, now),
  ]);
  const ocspHex = Buffer.from(ocsp.toSchema().toBER(false)).toString('hex') + '>';
  const withDss = revision(single, [
    [1, '<< /Type /Catalog /Pages 2 0 R /AcroForm << /SigFlags 3 /Fields [6 0 R] >> /DSS << /OCSPs [9 0 R] >> >>'],
    [9, `<< /Length ${ocspHex.length} /Filter /ASCIIHexDecode >>\nstream\n${ocspHex}\nendstream`],
  ], 10);
  return { unsigned: encode(unsigned), single: encode(single), multiple: encode(multiple),
    linearized: encode(linearized),
    altered: encode(single.replace('PDF sintetico original', 'PDF sintetico alterado')),
    timestamped: encode(timestamped), trust: { roots: [root.cert], intermediates: [], crls: [good] },
    revoked, stale, ocsp, forgedOcsp, withDss: encode(withDss) };
}
