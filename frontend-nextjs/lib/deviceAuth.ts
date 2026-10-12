import crypto from "node:crypto";
import jwt from "jsonwebtoken";

/**
 * The tokens the voice server accepts, and how a board earns its own.
 *
 * Two kinds, both HS256 with DEVICE_JWT_SECRET and told apart by audience and
 * `typ`, so neither opens the other's socket (server/fastapi/device_auth.py):
 *   device token     -- 24 hours, names a board, for /ws/esp32
 *   web voice token  --  5 minutes, names a signed-in account, for /ws/nextjs
 *
 * How a board proves who it is.
 *
 * The first time a board calls /api/generate_auth_token it is issued a random
 * secret, which it keeps in NVS; only its hash is stored, in
 * `device_secrets`. From then on it trades that secret for a short-lived
 * device token, which is what it opens the voice websocket with.
 *
 * The token is signed with DEVICE_JWT_SECRET, never the Supabase JWT secret,
 * so PostgREST rejects it outright: a stolen device token reads no table. It
 * names the device, not its owner -- ownership can change while a token is
 * live, so the voice server looks the owner up on every connection.
 * server/fastapi/device_auth.py verifies it.
 */

export const DEVICE_TOKEN_TTL_SECONDS = 24 * 60 * 60;
const DEVICE_TOKEN_AUDIENCE = "aibuddy-device";
// Only has to outlive the gap between asking for it and the socket opening:
// the voice server checks it once, on connect, and the session can run longer.
const WEB_VOICE_TOKEN_TTL_SECONDS = 5 * 60;
const WEB_VOICE_TOKEN_AUDIENCE = "aibuddy-web";

export const newDeviceSecret = () => crypto.randomBytes(32).toString("base64url");

export const hashDeviceSecret = (secret: string) =>
    crypto.createHash("sha256").update(secret).digest("hex");

export const deviceSecretMatches = (secret: string, storedHash: string) => {
    const presented = Buffer.from(hashDeviceSecret(secret), "hex");
    const stored = Buffer.from(storedHash, "hex");
    return presented.length === stored.length &&
        crypto.timingSafeEqual(presented, stored);
};

/**
 * How a board gets an owner (P0-11). The signed-in app asks for a bind ticket
 * and hands it to the board over Bluetooth with the WiFi password; the board
 * presents it with its secret, and becomes that account's. 128 random bits
 * keep it short enough for a Bluetooth write. Stored hashed, like the secret.
 */
export const BIND_TICKET_TTL_SECONDS = 5 * 60;
export const BIND_TICKETS_PER_MINUTE = 5;

export const newBindTicket = () => crypto.randomBytes(16).toString("base64url");

export const hashBindTicket = (ticket: string) => hashDeviceSecret(ticket);

const signingKey = () => {
    const key = process.env.DEVICE_JWT_SECRET;
    if (!key || key.length < 32) {
        throw new Error("DEVICE_JWT_SECRET is not set (or shorter than 32 chars)");
    }
    return key;
};

export const signDeviceToken = (device: { device_id: string; mac_address: string }) =>
    jwt.sign({ typ: "device", mac: device.mac_address }, signingKey(), {
        algorithm: "HS256",
        subject: device.device_id,
        audience: DEVICE_TOKEN_AUDIENCE,
        expiresIn: DEVICE_TOKEN_TTL_SECONDS,
    });

/**
 * A ticket for /ws/nextjs naming this account. The voice server takes the
 * user id from it -- and the character from that account -- instead of from
 * the query string, which anyone could edit. Server-side only: call it from a
 * server action after checking the session.
 */
export const signWebVoiceToken = (userId: string) =>
    jwt.sign({ typ: "web" }, signingKey(), {
        algorithm: "HS256",
        subject: userId,
        audience: WEB_VOICE_TOKEN_AUDIENCE,
        expiresIn: WEB_VOICE_TOKEN_TTL_SECONDS,
    });

/** The device a token names, or null for anything that is not a live device token. */
export const verifyDeviceToken = (token: unknown) => {
    if (typeof token !== "string" || !token) {
        return null;
    }
    try {
        const claims = jwt.verify(token, signingKey(), {
            algorithms: ["HS256"],
            audience: DEVICE_TOKEN_AUDIENCE,
        }) as jwt.JwtPayload;
        if (claims.typ !== "device" || !claims.sub || typeof claims.mac !== "string") {
            return null;
        }
        return { deviceId: claims.sub, mac: claims.mac };
    } catch {
        return null;
    }
};
