import { fromBER, GeneralizedTime, ObjectIdentifier, OctetString, Sequence } from 'asn1js';
import {
  BasicOCSPResponse, CertID, Certificate, CertificateChainValidationEngine, CertificateRevocationList,
  ContentInfo, CryptoEngine, OCSPResponse, OtherRevocationInfoFormat, RelativeDistinguishedNames,
  SignedData, SignedDataVerifyError, TSTInfo, type SignedDataVerifyResult,
} from 'pkijs';

export type Check = 'valid' | 'invalid' | 'unknown';
export type Revocation = 'good' | 'revoked' | 'unknown';
export interface TrustMaterial {
  roots: Certificate[];
  intermediates: Certificate[];
  crls: CertificateRevocationList[];
  ocsps?: BasicOCSPResponse[];
  loadCrls?: (issuer: Certificate, date: Date) => Promise<CertificateRevocationList[]>;
}

const cryptoEngine = new CryptoEngine({ name: 'WebCrypto', crypto: globalThis.crypto });
const ESS_V1 = '1.2.840.113549.1.9.16.2.12';
const ESS_V2 = '1.2.840.113549.1.9.16.2.47';
export const SIGNATURE_TIMESTAMP = '1.2.840.113549.1.9.16.2.14';
export const TST_INFO = '1.2.840.113549.1.9.16.1.4';
const OCSP_BASIC = '1.3.6.1.5.5.7.48.1.1';

export function decodeOcsp(data: ArrayBuffer) {
  try {
    const wrapper = OCSPResponse.fromBER(data);
    if (wrapper.responseStatus.valueBlock.valueDec !== 0 || wrapper.responseBytes?.responseType !== OCSP_BASIC) return null;
    return BasicOCSPResponse.fromBER(wrapper.responseBytes.response.getValue());
  } catch {
    return BasicOCSPResponse.fromBER(data); // The PDF DSS may contain a raw BasicOCSPResponse.
  }
}

export function cmsEvidence(cms: SignedData, trust: TrustMaterial): TrustMaterial {
  const crls = [...trust.crls];
  const ocsps = [...trust.ocsps ?? []];
  for (const entry of cms.crls ?? []) {
    if (entry instanceof CertificateRevocationList) crls.push(entry);
    else if (entry instanceof OtherRevocationInfoFormat && entry.otherRevInfoFormat === '1.3.6.1.5.5.7.16.2') {
      try {
        const ocsp = decodeOcsp(entry.otherRevInfo.toBER(false));
        if (ocsp) ocsps.push(ocsp);
      } catch { /* Unusable evidence. */ }
    }
  }
  return { ...trust, crls, ocsps };
}

export function equal(a: Uint8Array, b: Uint8Array) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export async function sha256Hex(bytes: BufferSource) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
}

export function decodeCms(bytes: Uint8Array) {
  const parsed = fromBER(bytes);
  if (parsed.offset < 0 || bytes.subarray(parsed.offset).some(byte => byte !== 0)) {
    throw new Error('Contenedor CMS inválido');
  }
  return readCms(new ContentInfo({ schema: parsed.result }));
}

export function readCms(info: ContentInfo) {
  if (info.contentType !== ContentInfo.SIGNED_DATA) throw new Error('Tipo CMS no admitido');
  return new SignedData({ schema: info.content });
}

export function certificates(cms: SignedData) {
  return (cms.certificates ?? []).filter((cert): cert is Certificate => cert instanceof Certificate);
}

export async function checkCms(cms: SignedData, signer: number, bytes: ArrayBuffer, requireEss = false) {
  let result: SignedDataVerifyResult;
  try {
    result = await cms.verify({ signer, data: bytes, checkChain: false, extendedMode: true }, cryptoEngine);
  } catch (error) {
    if (!(error instanceof SignedDataVerifyError)) return { integrity: 'unknown' as Check };
    const mismatch = error.signatureVerified === false ||
      (error.code === 15 && error.message === "Error during verification: Message digest doesn't match");
    return { integrity: mismatch ? 'invalid' as Check : 'unknown' as Check, cert: error.signerCertificate };
  }
  const cert = result.signerCertificate;
  if (!result.signatureVerified || !cert) return { integrity: 'invalid' as Check, cert };

  const attrs = cms.signerInfos[signer].signedAttrs?.attributes ?? [];
  if (attrs.length) {
    const contentTypes = attrs.filter(attr => attr.type === '1.2.840.113549.1.9.3');
    const digests = attrs.filter(attr => attr.type === '1.2.840.113549.1.9.4');
    const type = contentTypes[0]?.values[0];
    if (contentTypes.length !== 1 || contentTypes[0].values.length !== 1 ||
      !(type instanceof ObjectIdentifier) || type.valueBlock.toString() !== cms.encapContentInfo.eContentType ||
      digests.length !== 1 || digests[0].values.length !== 1) return { integrity: 'invalid' as Check, cert };
  }

  const bindings = attrs.filter(attr => attr.type === ESS_V1 || attr.type === ESS_V2);
  if (requireEss && !bindings.length) return { integrity: 'unknown' as Check, cert };
  for (const binding of bindings) {
    try {
      const spec = binding.values[0].valueBlock.value[0].valueBlock.value[0];
      const items = spec.valueBlock.value;
      const algorithm = binding.type === ESS_V1 ? 'SHA-1' : items[0] instanceof Sequence
        ? cryptoEngine.getAlgorithmByOID(items[0].valueBlock.value[0].valueBlock.toString(), true).name
        : 'SHA-256';
      const hash = items.find((item: unknown) => item instanceof OctetString);
      const digest = await cryptoEngine.digest(algorithm, cert.toSchema(true).toBER(false));
      if (binding.values.length !== 1 || !hash || !equal(hash.valueBlock.valueHexView, new Uint8Array(digest))) {
        return { integrity: 'invalid' as Check, cert };
      }
    } catch {
      return { integrity: 'unknown' as Check, cert };
    }
  }
  return { integrity: 'valid' as Check, cert };
}

export function certificateName(name?: Certificate['subject']) {
  if (!name) return 'No identificado';
  for (const oid of ['2.5.4.3', '2.5.4.10', '2.5.4.5']) {
    const value = name.typesAndValues.find(attr => attr.type === oid)?.value.valueBlock.value;
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return 'No identificado';
}

export async function certificatePath(cert: Certificate, extra: Certificate[], trust: TrustMaterial, date: Date) {
  const keyUsage = cert.extensions?.find(ext => ext.extnID === '2.5.29.15')?.parsedValue?.valueBlock?.valueHexView;
  if (keyUsage && !(keyUsage[0] & 0xc0)) return null;
  if (cert.extensions?.some(ext => ext.extnID === '2.5.29.19' && ext.parsedValue?.cA)) return null;
  try {
    const engine = new CertificateChainValidationEngine({
      certs: [...trust.intermediates, ...extra.filter(candidate => candidate !== cert), cert],
      trustedCerts: trust.roots,
      checkDate: date,
    });
    const result = await engine.verify({ passedWhenNotRevValues: true }, cryptoEngine);
    return result.result && result.certificatePath && result.certificatePath.length > 1
      ? result.certificatePath : null;
  } catch {
    return null;
  }
}

async function ocspStatus(response: BasicOCSPResponse, cert: Certificate, issuer: Certificate, date: Date): Promise<Revocation> {
  const { producedAt, responderID, responses, responseExtensions } = response.tbsResponseData;
  if (producedAt > date || responseExtensions?.some(ext => ext.critical)) return 'unknown';
  const relevant = [];
  for (const status of responses) {
    if (!status.certID.serialNumber.isEqual(cert.serialNumber) || !status.nextUpdate ||
      status.thisUpdate > producedAt || status.nextUpdate < date ||
      status.singleExtensions?.some(ext => ext.critical)) continue;
    const hash = cryptoEngine.getAlgorithmByOID(status.certID.hashAlgorithm.algorithmId, true).name;
    const expected = await CertID.create(cert, { issuerCertificate: issuer, hashAlgorithm: hash }, cryptoEngine);
    if (status.certID.isEqual(expected)) relevant.push(status);
  }
  if (relevant.length !== 1) return 'unknown';

  let authenticated = false;
  for (const candidate of [issuer, ...response.certs ?? []]) {
    if (candidate.notBefore.value > producedAt || candidate.notAfter.value < producedAt) continue;
    const keyBytes = candidate.subjectPublicKeyInfo.subjectPublicKey.valueBlock.valueHexView;
    const matchesId = responderID instanceof RelativeDistinguishedNames ? responderID.isEqual(candidate.subject)
      : responderID instanceof OctetString &&
        equal(new Uint8Array(await cryptoEngine.digest('SHA-1', Uint8Array.from(keyBytes))), responderID.valueBlock.valueHexView);
    if (!matchesId) continue;
    if (candidate !== issuer) {
      const eku = candidate.extensions?.find(ext => ext.extnID === '2.5.29.37')?.parsedValue?.keyPurposes;
      const usage = candidate.extensions?.find(ext => ext.extnID === '2.5.29.15')?.parsedValue?.valueBlock?.valueHexView;
      const noCheck = candidate.extensions?.some(ext => ext.extnID === '1.3.6.1.5.5.7.48.1.5');
      if (!eku?.includes('1.3.6.1.5.5.7.3.9') || (usage && !(usage[0] & 0x80)) || !noCheck ||
        !candidate.issuer.isEqual(issuer.subject) || !await candidate.verify(issuer, cryptoEngine)) continue;
    }
    if (await cryptoEngine.verifyWithPublicKey(Uint8Array.from(response.tbsResponseData.tbsView), response.signature,
      candidate.subjectPublicKeyInfo, response.signatureAlgorithm)) { authenticated = true; break; }
  }
  if (!authenticated) return 'unknown';
  const status = relevant[0].certStatus;
  if (status.idBlock.tagClass !== 3) return 'unknown';
  if (!status.idBlock.isConstructed && status.idBlock.tagNumber === 0 && !status.valueBlock.valueHexView.length) return 'good';
  const time = status.valueBlock.value?.[0];
  if (status.idBlock.tagNumber === 1 && time instanceof GeneralizedTime && time.toDate() <= date) return 'revoked';
  return 'unknown';
}

export async function revocation(path: Certificate[] | null, trust: TrustMaterial, date: Date): Promise<Revocation> {
  if (!path) return 'unknown';
  let complete = true;
  for (let i = 0; i < path.length - 1; i++) {
    const cert = path[i];
    const issuer = path[i + 1];
    let ocspGood = false;
    for (const response of trust.ocsps ?? []) {
      try {
        const status = await ocspStatus(response, cert, issuer, date);
        if (status === 'revoked') return 'revoked';
        if (status === 'good') ocspGood = true;
      } catch { /* Unusable evidence. */ }
    }
    const usage = issuer.extensions?.find(ext => ext.extnID === '2.5.29.15')?.parsedValue?.valueBlock?.valueHexView;
    const usable: CertificateRevocationList[] = [];
    const published = await trust.loadCrls?.(issuer, date) ?? [];
    const crls = [...published, ...trust.crls];
    for (const crl of crls) {
      if (!crl.issuer.isEqual(issuer.subject) || crl.thisUpdate.value > date ||
          !crl.nextUpdate || crl.nextUpdate.value < date || (usage && !(usage[0] & 0x02))) continue;
      // Only complete, direct CRLs. A delta, partition or indirect CRL cannot prove absence.
      if (crl.crlExtensions?.extensions.some(ext => ['2.5.29.27', '2.5.29.28', '2.5.29.46'].includes(ext.extnID) ||
          (ext.critical && !['2.5.29.20', '2.5.29.35'].includes(ext.extnID)))) continue;
      if (crl.revokedCertificates?.some(entry => entry.crlEntryExtensions?.extensions.some(ext =>
        ext.extnID === '2.5.29.29' || ext.critical))) continue;
      try {
        if (await crl.verify({ issuerCertificate: issuer }, cryptoEngine)) usable.push(crl);
      } catch { /* Unusable evidence. */ }
    }
    usable.sort((a, b) => b.thisUpdate.value.getTime() - a.thisUpdate.value.getTime());
    const freshest = usable[0];
    if (!freshest && !ocspGood) complete = false;
    else if (freshest && usable.some(crl => crl.thisUpdate.value.getTime() === freshest.thisUpdate.value.getTime() &&
      crl.revokedCertificates?.some(entry => entry.userCertificate.isEqual(cert.serialNumber) &&
        entry.revocationDate.value <= date))) return 'revoked';
  }
  return complete ? 'good' : 'unknown';
}

export async function checkTimestamp(cms: SignedData, data: ArrayBuffer, trust: TrustMaterial) {
  const unknown = { state: 'unknown' as Check, integrity: 'unknown' as Check };
  const eContent = cms.encapContentInfo.eContent;
  if (cms.encapContentInfo.eContentType !== TST_INFO || !eContent || cms.signerInfos.length !== 1) return unknown;
  try {
    const time = TSTInfo.fromBER(eContent.getValue()).genTime;
    if (!Number.isFinite(time.getTime()) || time > new Date()) return unknown;
    const proof = await checkCms(cms, 0, data, true);
    const unconfirmed = { state: proof.integrity === 'invalid' ? 'invalid' as Check : 'unknown' as Check,
      integrity: proof.integrity, cert: proof.cert };
    if (proof.integrity !== 'valid' || !proof.cert) return unconfirmed;
    const eku = proof.cert.extensions?.find(ext => ext.extnID === '2.5.29.37');
    if (!eku?.critical || eku.parsedValue?.keyPurposes?.length !== 1 ||
        eku.parsedValue.keyPurposes[0] !== '1.3.6.1.5.5.7.3.8') return unconfirmed;
    const evidence = cmsEvidence(cms, trust);
    const path = await certificatePath(proof.cert, certificates(cms), evidence, time);
    const status = await revocation(path, evidence, time);
    if (status === 'revoked') return { ...unconfirmed, state: 'invalid' as Check };
    return status === 'good' ? { ...unconfirmed, state: 'valid' as Check, time } : unconfirmed;
  } catch {
    return unknown;
  }
}
