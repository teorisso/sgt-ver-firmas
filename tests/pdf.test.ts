import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyPdf } from '../src/verify';
import { createFixtures } from './fixtures';

const fixtures = createFixtures();

test('PDF sin firma devuelve una lista vacía', async () => {
  assert.deepEqual(await verifyPdf((await fixtures).unsigned), []);
});

test('encuentra la firma invisible y distingue integridad de confianza y revocación', async () => {
  const [signature, ...rest] = await verifyPdf((await fixtures).single);
  assert.equal(rest.length, 0);
  assert.equal(signature.signer, 'Empresa sintética 1');
  assert.equal(signature.issuer, 'CA sintética');
  assert.equal(signature.integrity, 'valid');
  assert.equal(signature.confidence, 'unknown');
  assert.equal(signature.revocation, 'unknown');
  assert.equal(signature.timestamp, 'unknown');
  assert.equal(signature.laterChanges, false);
});

test('encuentra dos firmas de revisiones distintas y marca bytes posteriores', async () => {
  const results = await verifyPdf((await fixtures).multiple);
  assert.deepEqual(results.map(s => [s.signer, s.integrity, s.laterChanges]), [
    ['Empresa sintética 1', 'valid', true], ['Empresa sintética 2', 'valid', false],
  ]);
});

test('detecta una alteración dentro de la revisión firmada', async () => {
  const results = await verifyPdf((await fixtures).altered);
  assert.deepEqual(results.map(s => s.integrity), ['invalid']);
});

test('verifica una firma incremental sobre un PDF linearizado', async () => {
  const [signature] = await verifyPdf((await fixtures).linearized);
  assert.equal(signature.integrity, 'valid');
  assert.equal(signature.laterChanges, false);
});

test('rechaza un enlace hacia delante si el índice base contradice la longitud declarada', async () => {
  const { linearized } = await fixtures;
  const malformed = new TextEncoder().encode(new TextDecoder().decode(linearized)
    .replace(/(?<=\/Linearized 1 \/L )\d{10}/, '0000000001'));
  await assert.rejects(verifyPdf(malformed), /estructura de revisiones inválida/);
});

test('valida una cadena anclada, una CRL firmada y un sello RFC 3161', async () => {
  const sample = await fixtures;
  const [signature] = await verifyPdf(sample.timestamped, sample.trust);
  assert.equal(signature.integrity, 'valid');
  assert.equal(signature.confidence, 'valid');
  assert.equal(signature.revocation, 'good');
  assert.equal(signature.timestamp, 'valid');
});

test('distingue una revocación comprobada de una CRL de otro emisor o vencida', async () => {
  const sample = await fixtures;
  const [revoked] = await verifyPdf(sample.single, { ...sample.trust, crls: [sample.revoked] });
  assert.equal(revoked.revocation, 'revoked');
  const [unknown] = await verifyPdf(sample.single, { ...sample.trust, crls: [sample.stale] });
  assert.equal(unknown.revocation, 'unknown');
});

test('acepta una respuesta OCSP vigente del emisor y descarta una respuesta de otro firmante', async () => {
  const sample = await fixtures;
  const [good] = await verifyPdf(sample.single, { ...sample.trust, crls: [], ocsps: [sample.ocsp] });
  assert.equal(good.revocation, 'good');
  const [forged] = await verifyPdf(sample.single, { ...sample.trust, crls: [], ocsps: [sample.forgedOcsp] });
  assert.equal(forged.revocation, 'unknown');
});

test('lee el OCSP incorporado en una actualización DSS del PDF', async () => {
  const sample = await fixtures;
  const [signature] = await verifyPdf(sample.withDss, { ...sample.trust, crls: [] });
  assert.equal(signature.revocation, 'good');
  assert.equal(signature.integrity, 'valid');
  assert.equal(signature.laterChanges, true);
});
