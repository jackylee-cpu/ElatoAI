import { NextResponse } from "next/server";
import { createServiceClient } from "@/utils/supabase/service";
import {
    DEVICE_TOKEN_TTL_SECONDS,
    deviceSecretMatches,
    hashDeviceSecret,
    newDeviceSecret,
    signDeviceToken,
} from "@/lib/deviceAuth";
import { deviceServerUrls } from "@/lib/deviceServerUrls";
import { type OtaAnswer, parseFirmwareReport, recordReportAndDecide } from "@/lib/ota";

const skipDeviceRegistration =
    process.env.NEXT_PUBLIC_SKIP_DEVICE_REGISTRATION === "True";

// No 0/O/1/I/L: these codes get read off a screen and typed by hand.
const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const CODE_LENGTH = 6;
const CODE_COLLISION_RETRIES = 5;

type DeviceRow = {
    device_id: string;
    mac_address: string;
    user_code: string;
    user_id: string | null;
};
const DEVICE_COLUMNS = "device_id, mac_address, user_code, user_id";

const generateUserCode = () => {
    const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
    return Array.from(bytes)
        .map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length])
        .join("");
};

/**
 * Find the device row for this MAC, creating it if this is the first time we
 * have heard from the board.
 *
 * A freshly created row has a null `user_id`: the board is online but nobody
 * owns it yet.
 */
const findOrCreateDevice = async (mac: string): Promise<DeviceRow> => {
    const supabase = createServiceClient();

    const { data: existing, error: selectError } = await supabase
        .from("devices")
        .select(DEVICE_COLUMNS)
        .eq("mac_address", mac)
        .maybeSingle();

    if (selectError) {
        throw new Error(selectError.message);
    }
    if (existing) {
        return existing;
    }

    // `user_code` is UNIQUE, so retry a few times on a collision rather than
    // trusting 32^6 to never repeat.
    for (let attempt = 0; attempt < CODE_COLLISION_RETRIES; attempt++) {
        const { data, error } = await supabase
            .from("devices")
            .insert({ mac_address: mac, user_code: generateUserCode() })
            .select(DEVICE_COLUMNS)
            .single();

        if (!error) {
            return data;
        }

        // 23505 = unique_violation. On mac_address it means another request for
        // the same board raced us, so re-read instead of retrying the insert.
        if (error.code !== "23505") {
            throw new Error(error.message);
        }
        if (error.message.includes("mac_address")) {
            const { data: raced } = await supabase
                .from("devices")
                .select(DEVICE_COLUMNS)
                .eq("mac_address", mac)
                .maybeSingle();
            if (raced) {
                return raced;
            }
        }
    }

    throw new Error("Could not allocate a device code");
};

/**
 * Check the board's secret, or issue one if it has never had one.
 *
 * Returns the new secret when one was issued, null when the presented one
 * matched, and false when the board failed to prove itself. Issuing is trust
 * on first use: whoever asks first for a device without a secret gets it, and
 * the unique key on device_id means only one request can.
 */
const authenticateDevice = async (
    deviceId: string,
    presented: string | null,
): Promise<string | null | false> => {
    const supabase = createServiceClient();
    const { data: stored, error } = await supabase
        .from("device_secrets")
        .select("secret_hash")
        .eq("device_id", deviceId)
        .maybeSingle();
    if (error) {
        throw new Error(error.message);
    }

    if (stored) {
        return presented && deviceSecretMatches(presented, stored.secret_hash)
            ? null
            : false;
    }

    const secret = newDeviceSecret();
    const { error: insertError } = await supabase
        .from("device_secrets")
        .insert({ device_id: deviceId, secret_hash: hashDeviceSecret(secret) });
    if (insertError) {
        if (insertError.code === "23505") {
            return false; // another request got there first
        }
        throw new Error(insertError.message);
    }
    return secret;
};

/** Old firmware asked with just a MAC on the query string. That no longer gets anything. */
export async function GET() {
    return NextResponse.json(
        { error: "Update the firmware: POST the MAC address and device secret." },
        { status: 410 },
    );
}

/**
 * The board's only way in: POST { macAddress, deviceSecret?, firmware? }.
 *
 *   401  the board did not prove itself: a known device with a secret, and
 *        none or the wrong one presented
 *   202  { status: "unclaimed", user_code }  -- online, nobody owns it yet;
 *        the firmware polls this and needs to tell "not yours yet" apart from
 *        "the server is broken"
 *   200  { token, expires_in, ota? }  -- a device token for the voice websocket
 *
 * `firmware` is what the board runs ({ board, version, failed_version? }).
 * With it, a 200 also carries `ota`: whether to install the current release
 * for that board, and where to get it (lib/ota.ts). It rides on this request
 * so a boot costs the board one TLS handshake, not two -- about 1.3s of CPU
 * each on the C3.
 *
 * Either success also carries `device_secret` when one was just issued, which
 * the board must keep: it is never shown again.
 *
 * And where to find the servers (lib/deviceServerUrls.ts), when this
 * deployment sets them: `backend_url` on both, so an unclaimed board polling
 * here moves too, and `voice_url` on a 200, the only answer that opens the
 * voice websocket. Moving either server is then a config change, not a
 * firmware release (P2-22).
 *
 * With NEXT_PUBLIC_SKIP_DEVICE_REGISTRATION=True (local development) an
 * unclaimed board gets a token anyway and runs as the default character.
 */
export async function POST(req: Request) {
    try {
        const body = await req.json().catch(() => null);
        const mac = typeof body?.macAddress === "string"
            ? body.macAddress.trim().toUpperCase()
            : "";
        const presented = typeof body?.deviceSecret === "string" && body.deviceSecret
            ? body.deviceSecret
            : null;

        if (!mac) {
            return NextResponse.json(
                { error: "MAC address is required" },
                { status: 400 },
            );
        }

        const device = await findOrCreateDevice(mac);
        const issued = await authenticateDevice(device.device_id, presented);
        if (issued === false) {
            return NextResponse.json(
                { error: "Device secret missing or wrong" },
                { status: 401 },
            );
        }

        // Only a board that proved itself counts as seen: a stranger sending a
        // MAC must not put that board in anyone's claim list.
        await createServiceClient()
            .from("devices")
            .update({ last_seen_at: new Date().toISOString() })
            .eq("device_id", device.device_id);

        const secretField = issued ? { device_secret: issued } : {};
        const { voiceUrl, backendUrl } = deviceServerUrls();
        const backendField = backendUrl ? { backend_url: backendUrl } : {};

        if (!device.user_id && !skipDeviceRegistration) {
            return NextResponse.json(
                { status: "unclaimed", user_code: device.user_code, ...secretField, ...backendField },
                { status: 202 },
            );
        }

        // A broken release table must not keep a board from talking: without
        // `ota` the board just stays on what it runs.
        let ota: OtaAnswer | undefined;
        const report = parseFirmwareReport(body?.firmware);
        if (report) {
            try {
                ota = await recordReportAndDecide(createServiceClient(), device.device_id, report);
            } catch (otaError) {
                console.error("generate_auth_token: OTA check failed", otaError);
            }
        }

        return NextResponse.json({
            token: signDeviceToken(device),
            expires_in: DEVICE_TOKEN_TTL_SECONDS,
            ...secretField,
            ...(ota ? { ota } : {}),
            ...(voiceUrl ? { voice_url: voiceUrl } : {}),
            ...backendField,
        });
    } catch (error) {
        return NextResponse.json(
            {
                error: error instanceof Error
                    ? error.message
                    : "Internal server error",
            },
            { status: 500 },
        );
    }
}
