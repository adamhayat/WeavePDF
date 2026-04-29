import { readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Mimic the main-process sign flow in a standalone script.
import forge from "node-forge";
import { SignPdf } from "@signpdf/signpdf";
import { P12Signer } from "@signpdf/signer-p12";
import { plainAddPlaceholder } from "@signpdf/placeholder-plain";
import { PDFDocument } from "pdf-lib";

// 1. Generate a self-signed cert.
const keys = forge.pki.rsa.generateKeyPair(2048);
const cert = forge.pki.createCertificate();
cert.publicKey = keys.publicKey;
cert.serialNumber = "01" + Date.now().toString(16);
cert.validity.notBefore = new Date();
cert.validity.notAfter = new Date();
cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);
const attrs = [
  { name: "commonName", value: "QA Tester" },
  { name: "emailAddress", value: "qa@example.com" },
];
cert.setSubject(attrs);
cert.setIssuer(attrs);
cert.setExtensions([
  { name: "basicConstraints", cA: false },
  { name: "keyUsage", digitalSignature: true, nonRepudiation: true, keyEncipherment: true },
  { name: "extKeyUsage", clientAuth: true, emailProtection: true },
]);
cert.sign(keys.privateKey, forge.md.sha256.create());
const pass = forge.util.encode64(forge.random.getBytesSync(24));
const asn1 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], pass, { algorithm: "3des" });
const p12 = Buffer.from(forge.asn1.toDer(asn1).getBytes(), "binary");
console.log("Generated P12:", p12.length, "bytes");

// 2. Sign the fixture. Normalize xref first — @signpdf can't handle object streams.
const raw = readFileSync("resources/fixtures/sample.pdf");
const pdfDoc = await PDFDocument.load(raw, { ignoreEncryption: true, updateMetadata: false });
const fixture = Buffer.from(await pdfDoc.save({ useObjectStreams: false }));
const withPlaceholder = plainAddPlaceholder({
  pdfBuffer: fixture,
  reason: "QA smoke test",
  contactInfo: "qa@example.com",
  name: "QA Tester",
  location: "test",
});
const signer = new P12Signer(p12, { passphrase: pass });
const signpdf = new SignPdf();
const signed = await signpdf.sign(withPlaceholder, signer);
console.log("Signed bytes:", signed.length, "(grew", signed.length - fixture.length, "bytes)");

// 3. Write and check with qpdf.
const outPath = join(tmpdir(), `weavepdf-sig-test-${Date.now()}.pdf`);
writeFileSync(outPath, signed);
console.log("Wrote:", outPath);

const r = spawn("/opt/homebrew/bin/qpdf", ["--check", outPath]);
let stdout = "";
let stderr = "";
r.stdout.on("data", d => stdout += d);
r.stderr.on("data", d => stderr += d);
await new Promise((res) => r.on("exit", res));
console.log("qpdf --check:", stdout.trim().slice(0, 200));
if (stderr) console.log("qpdf stderr:", stderr.trim().slice(0, 200));
