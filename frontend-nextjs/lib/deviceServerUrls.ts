/**
 * Where boards should find the voice server and this backend (P2-22).
 *
 * Both ride on the token answer, so moving the FastAPI server -- or this
 * backend -- is a change to this deployment's environment, not a firmware
 * release:
 *
 *   DEVICE_VOICE_URL    wss://elatoai.hkqft.com/fastapi/ws/esp32
 *   DEVICE_BACKEND_URL  https://elatoai.hkqft.com
 *
 * Both are read at runtime (not NEXT_PUBLIC_*), so a container restart picks
 * up a new value. Unset, the field is left out and boards keep what they have.
 * A value that does not parse is left out too, with an error in the log: a
 * typo here would otherwise send every board that boots to a dead address.
 *
 * The firmware treats both as suggestions. It keeps the last voice URL that
 * worked and only adopts a new backend once a token request there succeeds, so
 * a wrong but well-formed value costs a failed attempt, not the board.
 */

export type DeviceServerUrls = { voiceUrl: string | null; backendUrl: string | null };

/**
 * The voice websocket URL as boards should get it, or null when it is not one.
 * Plaintext ws:// is only for a LAN dev server, never a production build.
 */
export const parseVoiceUrl = (raw: string | undefined, production: boolean): string | null => {
    const url = parse(raw);
    if (!url || !(url.protocol === "wss:" || (!production && url.protocol === "ws:"))) {
        return null;
    }
    if (url.pathname === "/" || url.search || url.hash) {
        return null;
    }
    return url.toString();
};

/**
 * The backend origin as boards should get it, or null when it is not one. Only
 * an origin: the firmware appends /api/... to it, so a path would be dropped.
 */
export const parseBackendUrl = (raw: string | undefined, production: boolean): string | null => {
    const url = parse(raw);
    if (!url || !(url.protocol === "https:" || (!production && url.protocol === "http:"))) {
        return null;
    }
    if (url.pathname !== "/" || url.search || url.hash) {
        return null;
    }
    return url.origin;
};

const parse = (raw: string | undefined): URL | null => {
    const value = raw?.trim();
    if (!value) {
        return null;
    }
    try {
        const url = new URL(value);
        // A single-label host (a compose service name like `fastapi`, or
        // `localhost`) only resolves on this server, never on a board.
        return url.hostname.includes(".") && !url.username && !url.password ? url : null;
    } catch {
        return null;
    }
};

let cached: { voice?: string; backend?: string; urls: DeviceServerUrls } | null = null;

/** This deployment's URLs for boards, from the environment. */
export const deviceServerUrls = (): DeviceServerUrls => {
    const voice = process.env.DEVICE_VOICE_URL;
    const backend = process.env.DEVICE_BACKEND_URL;
    if (cached && cached.voice === voice && cached.backend === backend) {
        return cached.urls;
    }

    const production = process.env.NODE_ENV === "production";
    const urls = {
        voiceUrl: parseVoiceUrl(voice, production),
        backendUrl: parseBackendUrl(backend, production),
    };
    // Once per value, not once per boot of every board.
    if (voice?.trim() && !urls.voiceUrl) {
        console.error(`DEVICE_VOICE_URL is not a usable websocket URL, not sending it: ${voice}`);
    }
    if (backend?.trim() && !urls.backendUrl) {
        console.error(`DEVICE_BACKEND_URL is not a usable origin, not sending it: ${backend}`);
    }
    cached = { voice, backend, urls };
    return urls;
};
