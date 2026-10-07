import { NextResponse } from "next/server";
import { createServiceClient } from "@/utils/supabase/service";
import { verifyDeviceToken } from "@/lib/deviceAuth";

/**
 * The board reports that it has finished a factory reset with its device token (lib/deviceAuth.ts).
 * The token names the device, so only that device's flag can be cleared.
 */
export async function POST(req: Request) {
    try {
        const body = await req.json().catch(() => null);
        const device = verifyDeviceToken(body?.authToken);
        if (!device) {
            return NextResponse.json(
                { error: "Invalid or expired device token" },
                { status: 401 },
            );
        }

        const { error } = await createServiceClient()
            .from("devices")
            .update({ is_reset: false })
            .eq("device_id", device.deviceId);
        if (error) {
            throw new Error(error.message);
        }

        return NextResponse.json({ success: true });
    } catch (error) {
        return NextResponse.json(
            { error: error instanceof Error ? error.message : "Internal server error" },
            { status: 500 },
        );
    }
}
