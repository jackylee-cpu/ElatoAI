import crypto from "node:crypto";
import jwt from "jsonwebtoken";

/**
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

export const newDeviceSecret = () => crypto.randomBytes(32).toString("base64url");

export const hashDeviceSecret = (secret: string) =>
    crypto.createHash("sha256").update(secret).digest("hex");

export const deviceSecretMatches = (secret: string, storedHash: string) => {
    const presented = Buffer.from(hashDeviceSecret(secret), "hex");
    const stored = Buffer.from(storedHash, "hex");
    return presented.length === stored.length &&
        crypto.timingSafeEqual(presented, stored);
};

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
