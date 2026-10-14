"use client";

import React, { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table";
import { toast } from "@/components/ui/use-toast";
import {
    forceUnbindDeviceAction,
    getDevicePresenceAction,
    resetDeviceSecretAction,
} from "@/app/admin/actions";
import type { DevicePresence, PresenceMap } from "@/lib/devicePresence";
import { DeviceUsage, deviceName, formatMoney, llmPriceMap, usageByDevice } from "@/lib/usageCost";
import { cn } from "@/lib/utils";

// Often enough that a toy switched on shows up well inside a minute.
const PRESENCE_POLL_MS = 15_000;

const ALL = "__all__";

type DeviceState = "online" | "offline" | "unbound" | "updateFailed";

const STATE_LABELS: Record<DeviceState, string> = {
    online: "Online",
    offline: "Offline",
    unbound: "Unbound",
    updateFailed: "Update failed",
};

const STATE_STYLES: Record<DeviceState, string> = {
    online: "bg-emerald-50 text-emerald-700 ring-emerald-200",
    offline: "bg-gray-100 text-gray-600 ring-gray-200",
    unbound: "bg-amber-50 text-amber-800 ring-amber-200",
    updateFailed: "bg-rose-50 text-rose-700 ring-rose-200",
};

const STATE_DOTS: Record<DeviceState, string> = {
    online: "bg-emerald-500",
    offline: "bg-gray-400",
    unbound: "bg-amber-500",
    updateFailed: "bg-rose-500",
};

interface DevicesTabProps {
    devices: IAdminDevice[];
    // Read when the page rendered; polled from here on.
    presence: PresenceMap;
    usage: {
        thisMonth: IUsageAggregate[];
        rates: IUsageRates;
        models: IOpenRouterModel[] | null;
    };
}

function macKey(device: IAdminDevice): string {
    return (device.mac_address ?? "").toUpperCase();
}

/**
 * The OTA rollback is still the story while the board runs something other
 * than the version it rolled back from. ota_failed_version is never cleared
 * (it stops the same release being offered again), so it alone is not enough.
 */
function updateFailed(device: IAdminDevice): boolean {
    return !!device.ota_failed_version && device.ota_failed_version !== device.firmware_version;
}

/** The one state a row is filed under; a board can be online and unbound. */
function stateOf(device: IAdminDevice, presence: DevicePresence | undefined): DeviceState {
    if (presence?.online) return "online";
    if (!device.owner_id) return "unbound";
    if (updateFailed(device)) return "updateFailed";
    return "offline";
}

function ago(iso: string | null, now: number): string {
    if (!iso) return "never";
    const seconds = Math.max(0, (now - new Date(iso).getTime()) / 1000);
    if (seconds < 60) return "just now";
    if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
    if (seconds < 86_400) return `${Math.floor(seconds / 3600)} h ago`;
    const days = Math.floor(seconds / 86_400);
    return days === 1 ? "yesterday" : `${days} days ago`;
}

function when(iso: string | null): string {
    if (!iso) return "—";
    return new Date(iso).toLocaleString("en-GB", {
        timeZone: "Asia/Hong_Kong",
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
    });
}

/**
 * Every toy, and the two things support does to one (P2-14). Super admins
 * only: the page does not render it for anyone else, and admin_list_devices()
 * refuses them. Conversations, memories and the child's details are not read
 * here at all (Q7).
 */
const DevicesTab: React.FC<DevicesTabProps> = ({ devices, presence: initialPresence, usage }) => {
    const [presence, setPresence] = useState<PresenceMap>(initialPresence);
    const [now, setNow] = useState(() => Date.now());
    const [query, setQuery] = useState("");
    const [state, setState] = useState<string>(ALL);
    const [firmware, setFirmware] = useState<string>(ALL);
    const [selected, setSelected] = useState<string | null>(devices[0]?.device_id ?? null);

    useEffect(() => setPresence(initialPresence), [initialPresence]);

    // Poll only while someone is looking: a background tab left open all day
    // should not keep asking.
    useEffect(() => {
        let cancelled = false;
        const tick = async () => {
            if (document.visibilityState !== "visible") return;
            const next = await getDevicePresenceAction();
            if (!cancelled) {
                setPresence(next);
                setNow(Date.now());
            }
        };
        const timer = window.setInterval(tick, PRESENCE_POLL_MS);
        document.addEventListener("visibilitychange", tick);
        return () => {
            cancelled = true;
            window.clearInterval(timer);
            document.removeEventListener("visibilitychange", tick);
        };
    }, []);

    const usageByMac = useMemo(() => {
        const rows = usageByDevice(usage.thisMonth, usage.rates, llmPriceMap(usage.models));
        return new Map(rows.filter((row) => row.device_id).map((row) => [row.device_id as string, row]));
    }, [usage]);

    const firmwares = useMemo(
        () =>
            Array.from(new Set(devices.map((device) => device.firmware_version ?? "")))
                .filter(Boolean)
                .sort((a, b) => b.localeCompare(a, undefined, { numeric: true })),
        [devices]
    );

    const rows = devices.map((device) => {
        const live = presence?.[macKey(device)];
        return { device, live, state: stateOf(device, live) };
    });

    const needle = query.trim().toLowerCase();
    const filtered = rows.filter(({ device, state: rowState }) => {
        if (state !== ALL && rowState !== state) return false;
        if (firmware !== ALL && device.firmware_version !== firmware) return false;
        if (!needle) return true;
        const mac = (device.mac_address ?? "").toLowerCase();
        return (
            mac.includes(needle) ||
            mac.replace(/:/g, "").includes(needle.replace(/[:\-\s]/g, "")) ||
            deviceName(device.mac_address).toLowerCase().includes(needle) ||
            (device.owner_email ?? "").toLowerCase().includes(needle)
        );
    });

    const current = filtered.find((row) => row.device.device_id === selected) ?? filtered[0] ?? null;
    const counts = rows.reduce(
        (sum, row) => ({ ...sum, [row.state]: (sum[row.state] ?? 0) + 1 }),
        {} as Partial<Record<DeviceState, number>>
    );

    return (
        <div className="flex flex-col gap-4">
            {presence === null && (
                <p className="rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-900 ring-1 ring-amber-200">
                    Could not reach the voice server, so no toy shows as online. Last seen still comes from the database.
                </p>
            )}

            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <Stat value={devices.length} label="Toys registered" />
                <Stat value={presence === null ? "—" : counts.online ?? 0} label="Online now" />
                <Stat value={counts.unbound ?? 0} label="Not bound to an account" />
                <Stat value={devices.filter(updateFailed).length} label="Rolled back an update" />
            </div>

            <div className="flex flex-wrap items-center gap-2">
                <Input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="MAC, toy name or parent email"
                    className="min-w-0 flex-1 basis-60 rounded-full"
                />
                <div className="flex w-full gap-2 sm:w-auto">
                    <Select value={state} onValueChange={setState}>
                        <SelectTrigger className="min-w-0 flex-1 rounded-full sm:w-[160px] sm:flex-none">
                            <SelectValue placeholder="All states" />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value={ALL}>All states</SelectItem>
                            {(Object.keys(STATE_LABELS) as DeviceState[]).map((key) => (
                                <SelectItem key={key} value={key}>
                                    {STATE_LABELS[key]}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                    <Select value={firmware} onValueChange={setFirmware}>
                        <SelectTrigger className="min-w-0 flex-1 rounded-full sm:w-[160px] sm:flex-none">
                            <SelectValue placeholder="All firmware" />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value={ALL}>All firmware</SelectItem>
                            {firmwares.map((version) => (
                                <SelectItem key={version} value={version}>
                                    {version}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>
            </div>

            <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
                <Card className="min-w-0 rounded-2xl border-0 bg-white/80 shadow-sm">
                    <CardContent className="pt-4">
                        {filtered.length === 0 ? (
                            <p className="text-sm text-muted-foreground">
                                {devices.length === 0
                                    ? "No toy has called in yet. A board appears here the first time it gets online."
                                    : "No toy matches."}
                            </p>
                        ) : (
                            <Table>
                                <TableHeader>
                                    <TableRow>
                                        <TableHead>State</TableHead>
                                        <TableHead>Toy</TableHead>
                                        <TableHead>Firmware</TableHead>
                                        <TableHead>Last seen</TableHead>
                                        <TableHead className="whitespace-nowrap text-right">Wi-Fi</TableHead>
                                        <TableHead>Account</TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {filtered.map(({ device, live, state: rowState }) => (
                                        <TableRow
                                            key={device.device_id}
                                            onClick={() => setSelected(device.device_id)}
                                            className={cn(
                                                "cursor-pointer",
                                                current?.device.device_id === device.device_id && "bg-sky-50"
                                            )}
                                        >
                                            <TableCell>
                                                <StatePill state={rowState} />
                                            </TableCell>
                                            <TableCell className="whitespace-nowrap">
                                                <div className="font-medium">{deviceName(device.mac_address)}</div>
                                                <div className="font-mono text-[11px] text-muted-foreground">
                                                    {device.mac_address ?? "—"}
                                                </div>
                                            </TableCell>
                                            <TableCell className="whitespace-nowrap font-mono text-xs">
                                                {device.firmware_version ?? "—"}
                                                {updateFailed(device) && (
                                                    <span className="ml-1.5 font-sans text-rose-600">
                                                        {device.ota_failed_version} failed
                                                    </span>
                                                )}
                                            </TableCell>
                                            <TableCell className="whitespace-nowrap text-sm" suppressHydrationWarning>
                                                {live?.online ? "now" : ago(device.last_seen_at, now)}
                                            </TableCell>
                                            <TableCell className="whitespace-nowrap text-right font-mono text-xs">
                                                {live?.online && live.status?.current?.rssi != null
                                                    ? `${live.status.current.rssi} dBm`
                                                    : "—"}
                                            </TableCell>
                                            <TableCell className="max-w-[200px] truncate text-sm">
                                                {device.owner_email ?? (
                                                    <span className="text-muted-foreground">—</span>
                                                )}
                                            </TableCell>
                                        </TableRow>
                                    ))}
                                </TableBody>
                            </Table>
                        )}
                        <p className="mt-2 text-xs text-muted-foreground">
                            Showing {filtered.length} of {devices.length}. Online is checked every{" "}
                            {PRESENCE_POLL_MS / 1000} s; a toy asleep or switched off both show as offline.
                        </p>
                    </CardContent>
                </Card>

                {current && (
                    <DeviceDetail
                        device={current.device}
                        live={current.live}
                        state={current.state}
                        usage={usageByMac.get(current.device.device_id) ?? null}
                        rates={usage.rates}
                        now={now}
                    />
                )}
            </div>
        </div>
    );
};

type PendingAction = "reset" | "unbind" | null;

function DeviceDetail({
    device,
    live,
    state,
    usage,
    rates,
    now,
}: {
    device: IAdminDevice;
    live: DevicePresence | undefined;
    state: DeviceState;
    usage: DeviceUsage | null;
    rates: IUsageRates;
    now: number;
}) {
    const [pending, setPending] = useState<PendingAction>(null);
    const name = deviceName(device.mac_address);
    const wifi = live?.status;

    return (
        <Card className="min-w-0 rounded-2xl border-0 bg-white/80 shadow-sm">
            <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-base">
                    {name} <StatePill state={state} />
                </CardTitle>
                <CardDescription>
                    {live?.online && live.connected_at
                        ? `Online since ${when(new Date(live.connected_at * 1000).toISOString())}`
                        : `Last called in ${when(device.last_seen_at)}`}
                </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
                <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
                    <dt className="text-muted-foreground">MAC</dt>
                    <dd className="break-all font-mono text-xs leading-5">{device.mac_address ?? "—"}</dd>

                    <dt className="text-muted-foreground">Board</dt>
                    <dd>{device.firmware_board ?? "—"}</dd>

                    <dt className="text-muted-foreground">IP</dt>
                    <dd className="text-muted-foreground">Not locked yet (arrives with factory registration, R-38)</dd>

                    <dt className="text-muted-foreground">Firmware</dt>
                    <dd>
                        {device.firmware_version ?? "—"}
                        {device.firmware_reported_at && (
                            <span className="text-muted-foreground"> · reported {when(device.firmware_reported_at)}</span>
                        )}
                    </dd>

                    <dt className="text-muted-foreground">OTA failed</dt>
                    <dd className={cn(updateFailed(device) && "text-rose-700")}>
                        {device.ota_failed_version
                            ? `${device.ota_failed_version}, rolled back ${when(device.ota_failed_at)}`
                            : "—"}
                    </dd>

                    <dt className="text-muted-foreground">Bound to</dt>
                    <dd className="break-words">
                        {device.owner_email ?? (device.owner_id ? device.owner_id.slice(0, 8) : "Nobody")}
                        {device.claimed_at && (
                            <span className="text-muted-foreground"> · since {when(device.claimed_at)}</span>
                        )}
                    </dd>

                    <dt className="text-muted-foreground">Device key</dt>
                    <dd>
                        {device.key_issued_at
                            ? `Issued ${when(device.key_issued_at)}`
                            : "None: the board's next call is issued one"}
                    </dd>

                    <dt className="text-muted-foreground">Wi-Fi</dt>
                    <dd className="break-words">
                        {wifi?.current
                            ? `${wifi.current.ssid}${wifi.current.rssi != null ? ` (${wifi.current.rssi} dBm)` : ""}`
                            : "—"}
                        {wifi && wifi.saved.length > 0 && (
                            <span className="text-muted-foreground">
                                {" "}
                                · saved: {wifi.saved.map((entry) => entry.ssid).join(", ")}
                            </span>
                        )}
                    </dd>

                    <dt className="text-muted-foreground">This month</dt>
                    <dd>
                        {usage
                            ? `${usage.turns} turns · ${formatMoney(usage.cost.total, rates)}${usage.cost.unpriced ? "*" : ""}`
                            : "No turns"}
                    </dd>

                    <dt className="text-muted-foreground">Registered</dt>
                    <dd suppressHydrationWarning>
                        {when(device.created_at)} <span className="text-muted-foreground">({ago(device.created_at, now)})</span>
                    </dd>
                </dl>

                <div className="flex flex-wrap gap-2 border-t border-gray-100 pt-4">
                    <Button
                        variant="outline"
                        size="sm"
                        className="rounded-full"
                        disabled={!device.key_issued_at}
                        onClick={() => setPending("reset")}
                    >
                        Reset device key
                    </Button>
                    <Button
                        variant="outline"
                        size="sm"
                        className="rounded-full border-rose-200 text-rose-700 hover:bg-rose-50 hover:text-rose-800"
                        disabled={!device.owner_id}
                        onClick={() => setPending("unbind")}
                    >
                        Force unbind
                    </Button>
                </div>
                <p className="rounded-xl bg-sky-50 px-3 py-2 text-xs text-sky-900">
                    Conversations, memories and the child&apos;s details are never shown here. Both actions ask for a
                    reason and go to the audit log.
                </p>
            </CardContent>

            <ReasonDialog
                key={`${device.device_id}-${pending}`}
                device={device}
                action={pending}
                onClose={() => setPending(null)}
            />
        </Card>
    );
}

const DIALOG_TEXT: Record<Exclude<PendingAction, null>, { title: string; body: string; confirm: string }> = {
    reset: {
        title: "Reset device key",
        body:
            "For a board that gets 401 on every boot because its NVS was wiped. Its key is deleted, and the next call from this MAC is issued a new one. Until it calls, whoever calls in with this MAC first gets that key, so do this when the board is about to be switched on.",
        confirm: "Reset key",
    },
    unbind: {
        title: "Force unbind",
        body:
            "Releases the toy from its account. If it is online it reconnects within seconds and goes back to pairing. What it remembers stays with the old account; whoever binds it next starts empty.",
        confirm: "Unbind",
    },
};

function ReasonDialog({
    device,
    action,
    onClose,
}: {
    device: IAdminDevice;
    action: PendingAction;
    onClose: () => void;
}) {
    const [reason, setReason] = useState("");
    const [busy, setBusy] = useState(false);
    const text = action ? DIALOG_TEXT[action] : null;

    const submit = async () => {
        if (!action) return;
        setBusy(true);
        const result =
            action === "reset"
                ? await resetDeviceSecretAction(device.device_id, reason)
                : await forceUnbindDeviceAction(device.device_id, reason);
        setBusy(false);
        if (!result.ok) {
            toast({ description: result.error, variant: "destructive" });
            return;
        }
        toast({
            description:
                action === "reset"
                    ? `${deviceName(device.mac_address)}: key reset`
                    : `${deviceName(device.mac_address)} unbound from ${device.owner_email ?? "its account"}`,
        });
        onClose();
    };

    return (
        <Dialog open={action !== null} onOpenChange={(open) => !open && !busy && onClose()}>
            {text && (
                <DialogContent className="max-w-md">
                    <DialogHeader>
                        <DialogTitle>
                            {text.title}: {deviceName(device.mac_address)}
                        </DialogTitle>
                        <DialogDescription>{text.body}</DialogDescription>
                    </DialogHeader>
                    <Textarea
                        value={reason}
                        onChange={(event) => setReason(event.target.value)}
                        placeholder="Reason (goes to the audit log)"
                        maxLength={500}
                        rows={3}
                        autoFocus
                    />
                    <DialogFooter className="gap-2">
                        <Button variant="outline" className="rounded-full" onClick={onClose} disabled={busy}>
                            Cancel
                        </Button>
                        <Button
                            variant={action === "unbind" ? "destructive" : "default"}
                            className="rounded-full"
                            onClick={submit}
                            disabled={busy || reason.trim() === ""}
                        >
                            {busy ? "Working…" : text.confirm}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            )}
        </Dialog>
    );
}

function StatePill({ state }: { state: DeviceState }) {
    return (
        <span
            className={cn(
                "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1",
                STATE_STYLES[state]
            )}
        >
            <span className={cn("h-1.5 w-1.5 rounded-full", STATE_DOTS[state])} />
            {STATE_LABELS[state]}
        </span>
    );
}

function Stat({ value, label }: { value: React.ReactNode; label: string }) {
    return (
        <div className="rounded-2xl bg-white/80 px-4 py-3 shadow-sm">
            <div className="font-fredoka text-2xl font-semibold text-gray-900">{value}</div>
            <div className="text-xs text-muted-foreground">{label}</div>
        </div>
    );
}

export default DevicesTab;
