import { X509Certificate } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { fromBER } from 'asn1js';
import { Certificate, CertificateRevocationList, CryptoEngine } from 'pkijs';

const authority = 'https://www.argentina.gob.ar/jefatura/innovacion-ciencia-y-tecnologia/innovacion/firma-digital';
const catalogue = authority + '/certificadores-licenciados';
const rootSources = [
  { url: 'https://acraiz.gov.ar/ca.crt', sha256: 'CC85ED4934C07C6B34C3429AB37FF3883EA988ECA5DAF117BD4D5F185B3BD463' },
  { url: 'https://acraiz.gov.ar/acraizra.crt', sha256: '975C663546ED8923D132256F2F3300838E3FE01E04E37739E954FF931E9F8BA4' },
];
const crlSources = {
  'raiz-2007': 'https://acraiz.cdp1.gov.ar/ca.crl',
  'raiz-2016': 'https://acraiz.cdp1.gov.ar/acraizra.crl',
  onti: 'https://pki.jgm.gov.ar/crl/FD.crl',
  pfdr: 'https://firmar.gob.ar/crl/FD.crl',
};

async function download(url, maxBytes = 2 * 1024 * 1024) {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(75_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel();
    throw new Error('supera el límite del paquete local');
  }
  const raw = Buffer.from(await response.arrayBuffer());
  if (raw.length > maxBytes) throw new Error('supera el límite del paquete local');
  return raw;
}

const roots = [];
for (const source of rootSources) {
  const cert = new X509Certificate(await download(source.url));
  if (cert.fingerprint256.replaceAll(':', '') !== source.sha256 || !cert.ca || !cert.verify(cert.publicKey)) {
    throw new Error(`La raíz no coincide con la huella revisada de ${source.url}`);
  }
  roots.push({ ...source, der: cert.raw.toString('base64') });
}
const page = (await download(catalogue)).toString('utf8');
const intermediateSources = [...new Set(Array.from(page.matchAll(
  /href="(https:\/\/www\.acraiz\.gob\.ar\/Content\/Archivos\/certificados\/licenciados(?:_acraiz2016)?\/[^"\/]+\.crt)"/ig),
match => match[1]))];
if (!intermediateSources.length) throw new Error('La página oficial no publicó certificados reconocibles.');

const officialRoots = roots.map(root => new X509Certificate(Buffer.from(root.der, 'base64')));
const intermediates = new Set();
for (const url of intermediateSources) {
  const cert = new X509Certificate(await download(url));
  if (!cert.ca || !officialRoots.some(root => cert.checkIssued(root) && cert.verify(root.publicKey))) {
    throw new Error(`El certificado intermedio no encadena a las raíces revisadas: ${url}`);
  }
  intermediates.add(cert.raw.toString('base64'));
}

const issuers = [...roots.map(root => root.der), ...intermediates].map(der => {
  const bytes = Buffer.from(der, 'base64');
  return { cert: Certificate.fromBER(bytes), sha256: new X509Certificate(bytes).fingerprint256.replaceAll(':', '').toLowerCase() };
});
const engine = new CryptoEngine({ name: 'WebCrypto', crypto });
const crls = [];
const assetDirectory = new URL('../trust/crl/', import.meta.url);
await mkdir(assetDirectory, { recursive: true });
for (const [name, url] of Object.entries(crlSources)) {
  try {
    const raw = await download(url);
    const pem = raw.toString('ascii', 0, 40).startsWith('-----BEGIN')
      ? raw.toString('ascii').match(/-----BEGIN X509 CRL-----([\s\S]+?)-----END X509 CRL-----/) : null;
    const buffer = pem ? Buffer.from(pem[1], 'base64') : raw;
    const decoded = fromBER(buffer, { maxNodes: 150_000 });
    if (decoded.offset !== buffer.length) throw new Error('estructura ASN.1 no admitida');
    const crl = new CertificateRevocationList({ schema: decoded.result });
    const signedBy = [];
    for (const issuer of issuers.filter(({ cert }) => crl.issuer.isEqual(cert.subject))) {
      if (await crl.verify({ issuerCertificate: issuer.cert }, engine).catch(() => false)) signedBy.push(issuer.sha256);
    }
    if (!signedBy.length || !crl.nextUpdate) throw new Error('firma o vigencia no verificable');
    const file = `${name}.crl.gz`;
    await writeFile(new URL(file, assetDirectory), gzipSync(buffer, { level: 9 }));
    crls.push({ url, file, signedBy, thisUpdate: crl.thisUpdate.value, nextUpdate: crl.nextUpdate.value });
  } catch (error) {
    console.warn(`CRL omitida (${url}): ${error.message}`);
  }
}

const bundle = { source: catalogue, updatedAt: new Date().toISOString(), roots,
  intermediateSources, intermediates: [...intermediates], crls };
await writeFile(new URL('../trust/argentina.json', import.meta.url), JSON.stringify(bundle, null, 2) + '\n');
console.log(`${roots.length} raíces, ${intermediates.size} intermedias, ${crls.length} CRL autenticadas`);
