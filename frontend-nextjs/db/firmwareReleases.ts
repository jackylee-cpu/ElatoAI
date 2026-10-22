import { SupabaseClient } from "@supabase/supabase-js";
import { FIRMWARE_BOARDS } from "@/lib/firmwareImage";
import { inRollout } from "@/lib/otaRollout";

const STAGES = [0, 10, 50, 100] as const;

/**
 * Every firmware release, for the admin OTA page (P2-21), with what its rollout
 * has done and how far each stage would reach.
 *
 * Read with the super admin's own key: firmware_releases and
 * firmware_rollout_devices have super admin SELECT policies. The MACs come from
 * `devices`, the list admin_list_devices() already gave the page. The reach is
 * worked out here with the token route's own hash (lib/otaRollout.ts), so the
 * page says exactly which boards a stage offers the release to.
 */
export const listFirmwareReleasesForAdmin = async (
    supabase: SupabaseClient,
    devices: IAdminDevice[],
): Promise<IAdminFirmwareRelease[]> => {
    const [{ data: releases, error }, { data: rollout, error: rolloutError }] = await Promise.all([
        supabase
            .from("firmware_releases")
            .select("release_id, board, version, size_bytes, sha256, notes, created_at, is_current, rollout_percent, rollout_macs, paused_at, paused_reason, paused_by, stage_changed_at")
            .order("created_at", { ascending: false }),
        supabase
            .from("firmware_rollout_devices")
            .select("release_id, device_id, first_offered_at, last_offered_at, offer_count, running_at, failed_at, failed_reason, failed_reset"),
    ]);
    if (error || rolloutError) {
        console.log("error listFirmwareReleasesForAdmin", error ?? rolloutError);
        return [];
    }

    const macOf = new Map(devices.map((device) => [device.device_id, device.mac_address]));
    return (releases ?? []).map((release) => {
        const boards = devices.filter((device) => device.firmware_board === release.board && device.mac_address);
        const spec = FIRMWARE_BOARDS[release.board];
        const reach = Object.fromEntries(
            STAGES.map((percent) => [
                percent,
                boards.filter((device) => inRollout({ ...release, rollout_percent: percent }, device.mac_address as string)).length,
            ]),
        ) as IAdminFirmwareRelease["reach"];
        return {
            ...release,
            board_label: spec?.label ?? release.board,
            app_slot: spec?.appSlot ?? null,
            legacy_app_slot: spec?.legacyAppSlot ?? null,
            reach,
            running: boards.filter((device) => device.firmware_version === release.version).length,
            rollout: (rollout ?? [])
                .filter((row) => row.release_id === release.release_id)
                .map(({ release_id: _, ...row }) => ({ ...row, mac_address: macOf.get(row.device_id) ?? null })),
        };
    });
};
