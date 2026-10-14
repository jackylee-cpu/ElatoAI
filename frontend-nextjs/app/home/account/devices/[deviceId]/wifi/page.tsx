import { notFound } from "next/navigation";
import { Metadata } from "next";
import DeviceWifi from "@/app/components/Account/DeviceWifi";
import { getUserDevice } from "@/db/devices";
import { getOpenGraphMetadata } from "@/lib/utils";
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

    return <DeviceWifi deviceId={device.device_id} />;
}
