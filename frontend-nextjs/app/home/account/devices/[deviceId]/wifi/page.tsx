import { notFound } from "next/navigation";
import { Metadata } from "next";
import DeviceWifi from "@/app/components/Account/DeviceWifi";
import { getUserDevice } from "@/db/devices";
import { getOpenGraphMetadata } from "@/lib/utils";
import { readRecordedWifi, relayDeviceWifi, withRecorded } from "@/lib/deviceWifiRelay";
import { createClient } from "@/utils/supabase/server";

export const metadata: Metadata = {
    title: "Wi-Fi",
    ...getOpenGraphMetadata("Wi-Fi"),
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function DeviceWifiPage({
    params,
}: {
    params: { deviceId: string };
}) {
    if (!UUID.test(params.deviceId)) {
        notFound();
    }
    const supabase = createClient();
    const {
        data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
        notFound();
    }
    const device = await getUserDevice(supabase, user.id, params.deviceId);
    if (!device) {
        notFound();
    }

    // The page opens with the board's last list on it and checks with the
    // board in the background. Whether it is online comes from the voice
    // server's memory (a peek never reaches the board, so it is only a local
    // round trip; if that is slow the page opens without it); the list comes
    // from there too, or else from the recorded row a sleeping board leaves.
    const [peek, recorded] = await Promise.all([
        device.mac_address
            ? relayDeviceWifi(device.mac_address, { op: "peek" }, 1500)
            : null,
        readRecordedWifi(supabase, device.device_id),
    ]);
    const initial = peek ? withRecorded(peek, recorded) : null;

    return (
        <DeviceWifi
            deviceId={device.device_id}
            initial={initial && (initial.ok || initial.status) ? initial : null}
            firmwareVersion={device.firmware_version}
        />
    );
}
