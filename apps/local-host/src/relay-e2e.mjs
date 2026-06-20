import crypto from "node:crypto";

const CURVE = "prime256v1";
const VERSION = 1;
const ALGORITHM = "P256-HKDF-SHA256-CHACHA20-POLY1305";
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export function createRelayE2EPeer({ role, pairingCode }) {
  if (role !== "host" && role !== "client") {
    throw new Error("role must be host or client");
  }
  const normalizedPairingCode = String(pairingCode || "").trim().toUpperCase();
  const ecdh = crypto.createECDH(CURVE);
  ecdh.generateKeys();

  let session;
  let outgoingSeq = 0;

  return {
    version: VERSION,
    algorithm: ALGORITHM,
    publicKey: ecdh.getPublicKey(null, "uncompressed").toString("base64url"),
    deriveSession(peerPublicKey) {
      const sharedSecret = ecdh.computeSecret(Buffer.from(String(peerPublicKey), "base64url"));
      const salt = Buffer.from(`codebuddy-remote relay e2e v1\n${normalizedPairingCode}`);
      session = {
        hostToClient: deriveKey(sharedSecret, salt, "host-to-client"),
        clientToHost: deriveKey(sharedSecret, salt, "client-to-host"),
      };
    },
    encryptPayload(payload) {
      assertSession(session);
      outgoingSeq += 1;
      const direction = outgoingDirection(role);
      const key = keyForDirection(session, direction);
      const nonce = crypto.randomBytes(NONCE_BYTES);
      const aad = aadFor(direction, outgoingSeq);
      const cipher = crypto.createCipheriv("chacha20-poly1305", key, nonce, {
        authTagLength: TAG_BYTES,
      });
      cipher.setAAD(aad);
      const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
      const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const tag = cipher.getAuthTag();
      return {
        type: "encrypted",
        version: VERSION,
        alg: ALGORITHM,
        seq: outgoingSeq,
        nonce: nonce.toString("base64url"),
        ciphertext: Buffer.concat([encrypted, tag]).toString("base64url"),
      };
    },
    decryptPayload(envelope) {
      assertSession(session);
      assertEnvelope(envelope);
      const direction = incomingDirection(role);
      const key = keyForDirection(session, direction);
      const nonce = Buffer.from(envelope.nonce, "base64url");
      const sealed = Buffer.from(envelope.ciphertext, "base64url");
      if (sealed.length <= TAG_BYTES) throw new Error("encrypted payload is too short");
      const encrypted = sealed.subarray(0, sealed.length - TAG_BYTES);
      const tag = sealed.subarray(sealed.length - TAG_BYTES);
      const decipher = crypto.createDecipheriv("chacha20-poly1305", key, nonce, {
        authTagLength: TAG_BYTES,
      });
      decipher.setAAD(aadFor(direction, envelope.seq));
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]);
      return JSON.parse(plaintext.toString("utf8"));
    },
  };
}

export function isRelayEncryptedPayload(payload) {
  return Boolean(payload && typeof payload === "object" && payload.type === "encrypted");
}

function deriveKey(sharedSecret, salt, direction) {
  return Buffer.from(
    crypto.hkdfSync("sha256", sharedSecret, salt, Buffer.from(direction), 32)
  );
}

function outgoingDirection(role) {
  return role === "host" ? "host-to-client" : "client-to-host";
}

function incomingDirection(role) {
  return role === "host" ? "client-to-host" : "host-to-client";
}

function keyForDirection(session, direction) {
  return direction === "host-to-client" ? session.hostToClient : session.clientToHost;
}

function aadFor(direction, seq) {
  return Buffer.from(`codebuddy-remote relay e2e v1\n${direction}\n${seq}`);
}

function assertSession(session) {
  if (!session) throw new Error("relay e2e session is not established");
}

function assertEnvelope(envelope) {
  if (!isRelayEncryptedPayload(envelope)) throw new Error("payload is not encrypted");
  if (envelope.version !== VERSION) throw new Error("unsupported encrypted payload version");
  if (envelope.alg !== ALGORITHM) throw new Error("unsupported encrypted payload algorithm");
  if (!Number.isSafeInteger(envelope.seq) || envelope.seq < 1) {
    throw new Error("encrypted payload seq is required");
  }
  if (typeof envelope.nonce !== "string" || !envelope.nonce) {
    throw new Error("encrypted payload nonce is required");
  }
  if (typeof envelope.ciphertext !== "string" || !envelope.ciphertext) {
    throw new Error("encrypted payload ciphertext is required");
  }
}
