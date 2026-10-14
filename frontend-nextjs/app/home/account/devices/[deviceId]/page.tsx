import { notFound } from "next/navigation";
import { Metadata } from "next";
import DeviceSettings from "@/app/components/Account/DeviceSettings";
import { getUserDevice } from "@/db/devices";
import { getUserById } from "@/db/users";
import { getOpenGraphMetadata } from "@/lib/utils";
import { createClient } from "@/utils/supabase/server";

export const metadata: Metadata = {
    title: "Device Settings",
    ...getOpenGraphMetadata("Device Settings"),
};

// device_id is a uuid; anything else would make Postgres throw instead of
// returning no row.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function DeviceSettingsPage({
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

    const [dbUser, device] = await Promise.all([
        getUserById(supabase, user.id),
        getUserDevice(supabase, user.id, params.deviceId),
    ]);
    if (!dbUser || !device) {
        notFound();
    }

    return <DeviceSettings currentUser={dbUser} device={device} />;
}
