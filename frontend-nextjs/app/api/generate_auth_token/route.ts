import { NextResponse } from "next/server";
import jwt from "jsonwebtoken";
import { createServiceClient } from "@/utils/supabase/service";

const ALGORITHM = "HS256";
const skipDeviceRegistration =
    process.env.NEXT_PUBLIC_SKIP_DEVICE_REGISTRATION === "True";

// No 0/O/1/I/L: these codes get read off a screen and typed by hand.
const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const CODE_LENGTH = 6;
const CODE_COLLISION_RETRIES = 5;

interface TokenPayload {
    [key: string]: any;
}

const createSupabaseToken = (
    jwtSecretKey: string,
    data: TokenPayload,
    // Set expiration to null for no expiration, or use a very large number like 10 years
    expireDays: number | null = 3650, // Default to 10 years
): string => {
    const toEncode = {
        aud: "authenticated",
        role: "authenticated",
        sub: data.user_id,
        email: data.email,
        // Only include exp if expireDays is not null
        ...(expireDays && {
            exp: Math.floor(Date.now() / 1000) + (expireDays * 86400),
        }),
        user_metadata: {
            ...data,
        },
    };

    const encodedJwt = jwt.sign(toEncode, jwtSecretKey, {
        algorithm: ALGORITHM,
    });
    return encodedJwt;
};

const generateUserCode = () => {
    const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
    return Array.from(bytes)
        .map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length])
        .join("");
};

/**
 * Find the device row for this MAC, creating it if this is the first time we
 * have heard from the board, and stamp `last_seen_at` either way.
 *
 * A freshly created row has a null `user_id`: the board is online but nobody
 * owns it yet, which is what puts it in the web app's claim list.
 */
const registerDevice = async (macAddress: string) => {
    const supabase = createServiceClient();
    const mac = macAddress.trim().toUpperCase();

    const { data: existing, error: selectError } = await supabase
        .from("devices")
        .select("device_id, user_code, user_id")
        .eq("mac_address", mac)
        .maybeSingle();

    if (selectError) {
        throw new Error(selectError.message);
    }

    if (existing) {
        // Best effort -- a failed heartbeat must not stop a claimed device from
        // getting its token.
        await supabase
            .from("devices")
            .update({ last_seen_at: new Date().toISOString() })
            .eq("device_id", existing.device_id);
        return existing;
    }

    // `user_code` is UNIQUE, so retry a few times on a collision rather than
    // trusting 32^6 to never repeat.
    for (let attempt = 0; attempt < CODE_COLLISION_RETRIES; attempt++) {
        const { data, error } = await supabase
            .from("devices")
            .insert({
                mac_address: mac,
                user_code: generateUserCode(),
                last_seen_at: new Date().toISOString(),
            })
            .select("device_id, user_code, user_id")
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
                .select("device_id, user_code, user_id")
                .eq("mac_address", mac)
                .maybeSingle();
            if (raced) {
                return raced;
            }
        }
    }

    throw new Error("Could not allocate a device code");
};

const getUserById = async (userId: string) => {
    const supabase = createServiceClient();
    const { data, error } = await supabase
        .from("users")
        .select("*")
        .eq("user_id", userId)
        .maybeSingle();
    if (error) {
        throw new Error(error.message);
    }
    return data;
};

// Service role: the board has no session, and anon can no longer read users.
const getDevUser = async () => {
    const supabase = createServiceClient();
    const { data, error } = await supabase.from("users").select("*").eq(
        "email",
        "admin@elatoai.com",
    ).single();
    if (error) {
        throw new Error(error.message);
    }
    return data;
};

export async function GET(req: Request) {
    try {
        const { searchParams } = new URL(req.url);
        const macAddress = searchParams.get("macAddress");

        if (!macAddress) {
            return NextResponse.json(
                { error: "MAC address is required" },
                { status: 400 },
            );
        }

        /**
         * If `NEXT_PUBLIC_SKIP_DEVICE_REGISTRATION` is true, we use the default dev user.
         * Otherwise the device is resolved from its own row, which it creates on
         * first contact. Until somebody claims that row in the web app the device
         * has no owner, and we say so with a 202 rather than an error -- the
         * firmware polls this endpoint and needs to tell "not yours yet" apart
         * from "the server is broken".
         */
        let user;
        if (skipDeviceRegistration) {
            user = await getDevUser();
        } else {
            const device = await registerDevice(macAddress);
            if (!device.user_id) {
                return NextResponse.json(
                    { status: "unclaimed", user_code: device.user_code },
                    { status: 202 },
                );
            }
            user = await getUserById(device.user_id);
        }

        if (!user) {
            return NextResponse.json(
                { error: "User not found" },
                { status: 400 },
            );
        }

        const payload = {
            email: user.email,
            user_id: user.user_id,
            created_time: new Date(),
        };

        const token = createSupabaseToken(
            process.env.JWT_SECRET_KEY!,
            payload,
            null,
        );

        return NextResponse.json({ token });
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
