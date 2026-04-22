#!/usr/bin/env node
/**
 * Self-signed TLS cert for local HTTPS (Quest / WebXR) and WSS.
 */
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const os = require("os");

const root = __dirname;
const certPath = path.join(root, "cert.pem");
const keyPath = path.join(root, "key.pem");
const force = process.argv.includes("--force");

function collectLanIps() {
  const out = new Set(["127.0.0.1"]);
  const manual = (process.env.CERT_IPS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const ip of manual) out.add(ip);
  try {
    const ifaces = os.networkInterfaces();
    for (const values of Object.values(ifaces)) {
      if (!Array.isArray(values)) continue;
      for (const addr of values) {
        if (!addr || addr.family !== "IPv4" || addr.internal) continue;
        out.add(addr.address);
      }
    }
  } catch (_) {
    // Some restricted/sandboxed environments cannot enumerate interfaces.
    // Keep localhost and any CERT_IPS provided by the caller.
  }
  for (const ip of collectLanIpsByRoute()) out.add(ip);
  return Array.from(out);
}

function collectLanIpsByRoute() {
  const out = new Set();
  // macOS: discover primary interface and get IPv4.
  if (process.platform === "darwin") {
    try {
      const route = execSync("route -n get default", {
        stdio: ["ignore", "pipe", "ignore"],
        encoding: "utf8",
      });
      const match = route.match(/interface:\s*([^\s]+)/);
      if (match && match[1]) {
        const iface = match[1].trim();
        const ip = execSync(`ipconfig getifaddr ${iface}`, {
          stdio: ["ignore", "pipe", "ignore"],
          encoding: "utf8",
        }).trim();
        if (isValidIpv4(ip) && ip !== "127.0.0.1") out.add(ip);
      }
    } catch (_) {}
  }

  // Linux: parse `ip route get` output.
  if (process.platform === "linux") {
    try {
      const route = execSync("ip route get 1.1.1.1", {
        stdio: ["ignore", "pipe", "ignore"],
        encoding: "utf8",
      });
      const match = route.match(/\bsrc\s+([0-9.]+)/);
      if (match && isValidIpv4(match[1])) out.add(match[1]);
    } catch (_) {}
  }

  // Windows: best-effort parse from route print output.
  if (process.platform === "win32") {
    try {
      const route = execSync("route print 0.0.0.0", {
        stdio: ["ignore", "pipe", "ignore"],
        encoding: "utf8",
      });
      const matches = route.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g) || [];
      for (const ip of matches) {
        if (isValidIpv4(ip) && !ip.startsWith("127.")) out.add(ip);
      }
    } catch (_) {}
  }

  return Array.from(out);
}

function isValidIpv4(ip) {
  if (!ip || typeof ip !== "string") return false;
  const parts = ip.split(".");
  if (parts.length !== 4) return false;
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return false;
    const n = Number(p);
    if (n < 0 || n > 255) return false;
  }
  return true;
}

function buildOpenSslConfig(localIps) {
  const lines = [
    "[req]",
    "default_bits = 2048",
    "prompt = no",
    "default_md = sha256",
    "x509_extensions = v3_req",
    "distinguished_name = dn",
    "",
    "[dn]",
    "CN = localhost",
    "",
    "[v3_req]",
    "subjectAltName = @alt_names",
    "",
    "[alt_names]",
    "DNS.1 = localhost",
  ];
  localIps.forEach((ip, idx) => {
    lines.push(`IP.${idx + 1} = ${ip}`);
  });
  return lines.join("\n") + "\n";
}

function openssl() {
  try {
    const ips = collectLanIps();
    const cfgPath = path.join(root, ".tmp-openssl-san.cnf");
    fs.writeFileSync(cfgPath, buildOpenSslConfig(ips), "utf8");
    execSync(
      `openssl req -x509 -newkey rsa:2048 -nodes -keyout "${keyPath}" -out "${certPath}" -days 3650 -config "${cfgPath}" -extensions v3_req`,
      { stdio: "inherit" }
    );
    fs.unlinkSync(cfgPath);
    console.log("Created cert.pem and key.pem (OpenSSL with SAN localhost + LAN IPs).");
  } catch (e) {
    if (e && e.message) {
      console.error(String(e.message));
    }
    console.error("OpenSSL failed. Install OpenSSL or run manually:");
    console.error(
      "  node generate-cert.js --force"
    );
    process.exit(1);
  }
}

if (!force && fs.existsSync(certPath) && fs.existsSync(keyPath)) {
  console.log("cert.pem / key.pem already exist; skip.");
} else {
  if (force) {
    try {
      if (fs.existsSync(certPath)) fs.unlinkSync(certPath);
      if (fs.existsSync(keyPath)) fs.unlinkSync(keyPath);
    } catch (_) {}
  }
  openssl();
}
