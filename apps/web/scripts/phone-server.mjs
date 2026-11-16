// Serves the production build over HTTPS on the local network so a phone can use its camera
// (browsers only allow getUserMedia on HTTPS or localhost). The certificate is self-signed,
// so the phone shows a warning once that has to be accepted.
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import next from "next";
import selfsigned from "selfsigned";

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.PORT ?? 3443);

if (!fs.existsSync(path.join(dir, ".next", "BUILD_ID"))) {
  console.error("Brak builda. Najpierw uruchom: npm run build");
  process.exit(1);
}

const ips = Object.values(os.networkInterfaces())
  .flat()
  .filter((a) => a && a.family === "IPv4" && !a.internal)
  .map((a) => a.address);

async function certificate() {
  const certDir = path.join(dir, ".cert");
  const files = { key: path.join(certDir, "key.pem"), cert: path.join(certDir, "cert.pem"), hosts: path.join(certDir, "hosts.json") };
  const hosts = ["localhost", "127.0.0.1", ...ips];
  try {
    const prev = JSON.parse(fs.readFileSync(files.hosts, "utf8"));
    if (hosts.every((h) => prev.hosts.includes(h)) && new Date(prev.expires) > new Date()) {
      return { key: fs.readFileSync(files.key), cert: fs.readFileSync(files.cert) };
    }
  } catch {
    // no usable cached certificate
  }
  const expires = new Date();
  expires.setDate(expires.getDate() + 365);
  const pems = await selfsigned.generate([{ name: "commonName", value: "ai-trainer.local" }], {
    keySize: 2048,
    algorithm: "sha256",
    notAfterDate: expires,
    extensions: [
      { name: "basicConstraints", cA: false },
      { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
      { name: "extKeyUsage", serverAuth: true },
      {
        name: "subjectAltName",
        altNames: [{ type: 2, value: "localhost" }, ...["127.0.0.1", ...ips].map((ip) => ({ type: 7, ip }))],
      },
    ],
  });
  fs.mkdirSync(certDir, { recursive: true });
  fs.writeFileSync(files.key, pems.private);
  fs.writeFileSync(files.cert, pems.cert);
  fs.writeFileSync(files.hosts, JSON.stringify({ hosts, expires: expires.toISOString() }));
  return { key: pems.private, cert: pems.cert };
}

const app = next({ dev: false, dir });
const handle = app.getRequestHandler();
await app.prepare();
const tls = await certificate();
https.createServer(tls, (req, res) => handle(req, res)).listen(port, "0.0.0.0", () => {
  console.log(`\nAI Trainer działa przez HTTPS na porcie ${port}.`);
  console.log(`Komputer: https://localhost:${port}/lab`);
  if (ips.length === 0) console.log("Nie znaleziono adresu w sieci lokalnej. Sprawdź połączenie z Wi-Fi.");
  for (const ip of ips) console.log(`Telefon (ta sama sieć Wi-Fi): https://${ip}:${port}/lab`);
  console.log("\nTelefon pokaże ostrzeżenie o certyfikacie: wybierz Zaawansowane, a potem Przejdź do strony.");
  console.log("Jeśli Windows zapyta o zaporę, zezwól na dostęp w sieciach prywatnych.\n");
});
