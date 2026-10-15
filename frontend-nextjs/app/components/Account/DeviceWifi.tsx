"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
    ArrowRightLeft,
    CheckCircle2,
    Loader2,
    Lock,
    Plus,
    RefreshCw,
    Trash2,
    Wifi,
    WifiHigh,
    WifiLow,
    WifiOff,
    WifiZero,
} from "lucide-react";
import { deviceWifiAction } from "@/app/actions";
import type { DeviceWifiState, WifiSwitchResult } from "@/lib/deviceWifi";
import { useToast } from "@/components/ui/use-toast";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { BackIcon } from "../Playground/icons";
import { cn } from "@/lib/utils";

const cardClass =
    "rounded-[24px] bg-white/90 shadow-[0_8px_24px_rgba(80,120,180,0.08)] backdrop-blur-sm";

const rowClass =
    "flex items-center gap-3 border-b border-gray-100 px-5 py-4 text-base text-gray-800 last:border-b-0";

const sectionTitleClass = "mb-2 px-1 text-base font-semibold text-gray-800";

const fieldClass =
    "w-full rounded-[16px] border border-gray-200 bg-white px-4 py-3 text-base text-gray-900 outline-none placeholder:text-gray-300 focus-visible:ring-2 focus-visible:ring-[#4C74F6]/30";

// How often the page checks whether the board woke up or fell asleep. A
// "peek" reads only the server's cache; the board itself is asked nothing.
const POLL_MS = 5000;

const ERRORS: Record<string, string> = {
    offline: "AI Buddy is asleep. Wake it up and try again.",
    timeout: "AI Buddy didn't answer. Try again.",
    busy: "AI Buddy is busy with another change. Try again in a moment.",
    full: "AI Buddy can remember up to 8 Wi-Fi networks. Remove one first.",
    current: "That's the Wi-Fi AI Buddy is using now, so it can't be changed here.",
    unknown: "AI Buddy doesn't have that Wi-Fi saved.",
    invalid: "Check the name (up to 32 characters) and the password (8-63 characters, or empty for an open network).",
    scan: "Couldn't scan for nearby Wi-Fi. Try again.",
    forbidden: "This device isn't on your account.",
};

const errorText = (code?: string) =>
    (code && ERRORS[code]) || "Couldn't reach AI Buddy. Try again.";

// A move takes up to 20s on the new Wi-Fi and 15s getting back, plus the
// reconnect; past this the page stops waiting and says so.
const SWITCH_WAIT_MS = 90_000;

const switchFailure = (result: WifiSwitchResult) => {
    const name = `"${result.ssid}"`;
    const why =
        result.error === "not_found"
            ? `AI Buddy couldn't find ${name} nearby.`
            : result.error === "auth"
                ? `${name} didn't accept the saved password. Remove it and add it again.`
                : result.error === "no_internet"
                    ? `AI Buddy joined ${name} but couldn't reach the internet through it.`
                    : `AI Buddy couldn't connect to ${name} in time.`;
    return result.back
        ? `${why} It's back on "${result.back}".`
        : `${why} It's reconnecting to a saved Wi-Fi.`;
};

function SignalIcon({ rssi, className }: { rssi: number | null | undefined; className?: string }) {
    if (rssi == null) return <Wifi className={className} />;
    if (rssi >= -60) return <Wifi className={className} />;
    if (rssi >= -70) return <WifiHigh className={className} />;
    if (rssi >= -80) return <WifiLow className={className} />;
    return <WifiZero className={className} />;
}

export default function DeviceWifi({ deviceId }: { deviceId: string }) {
    const { toast } = useToast();
    const [state, setState] = useState<DeviceWifiState | null>(null);
    const [refreshing, setRefreshing] = useState(false);
    const [adding, setAdding] = useState(false);
    const [removing, setRemoving] = useState<string | null>(null);
    const [confirmSwitch, setConfirmSwitch] = useState<string | null>(null);
    // A move in progress. `since` is the last result's timestamp when it
    // started, so only a newer one ends it -- both on the voice server's clock.
    const [switching, setSwitching] = useState<{ ssid: string; since: number } | null>(null);
    const [busy, setBusy] = useState(false);
    const busyRef = useRef(false);

    const load = useCallback(async (op: "status" | "peek" = "status") => {
        const next = await deviceWifiAction(deviceId, op);
        // A status that failed for a passing reason keeps the last good list
        // on screen rather than blanking it.
        setState((prev) => (next.status || !prev ? next : { ...prev, online: next.online }));
        return next;
    }, [deviceId]);

    useEffect(() => {
        load();
    }, [load]);

    useEffect(() => {
        const timer = setInterval(() => {
            if (!busyRef.current) load("peek");
        }, POLL_MS);
        return () => clearInterval(timer);
    }, [load]);

    const run = async (work: () => Promise<DeviceWifiState>, success: string) => {
        setBusy(true);
        busyRef.current = true;
        try {
            const result = await work();
            setState((prev) => (result.status || !prev ? result : { ...prev, online: result.online }));
            if (result.ok) {
                toast({ description: success });
            } else {
                toast({ description: errorText(result.error), variant: "destructive" });
            }
            return result.ok;
        } finally {
            setBusy(false);
            busyRef.current = false;
        }
    };

    // The board reports how the move went once it is back online.
    useEffect(() => {
        const result = state?.last_switch;
        if (!switching || !result || result.at <= switching.since || result.ssid !== switching.ssid) {
            return;
        }
        setSwitching(null);
        if (result.ok) {
            toast({ description: `AI Buddy is now on "${result.ssid}".` });
        } else {
            toast({ description: switchFailure(result), variant: "destructive" });
        }
    }, [state?.last_switch, switching, toast]);

    useEffect(() => {
        if (!switching) return;
        const timer = setTimeout(() => {
            setSwitching(null);
            toast({
                description: `AI Buddy hasn't come back online yet. It may still be moving to "${switching.ssid}", or out of reach of every saved Wi-Fi.`,
                variant: "destructive",
            });
        }, SWITCH_WAIT_MS);
        return () => clearTimeout(timer);
    }, [switching, toast]);

    const startSwitch = async (ssid: string) => {
        const since = state?.last_switch?.at ?? 0;
        setBusy(true);
        busyRef.current = true;
        try {
            const result = await deviceWifiAction(deviceId, "switch", ssid);
            setState((prev) => (result.status || !prev ? result : { ...prev, online: result.online }));
            if (result.ok && result.switching) {
                setSwitching({ ssid, since });
            } else {
                toast({ description: errorText(result.error), variant: "destructive" });
            }
        } finally {
            setBusy(false);
            busyRef.current = false;
            setConfirmSwitch(null);
        }
    };

    const status = state?.status;
    const current = status?.current ?? null;
    const saved = status?.saved ?? [];
    const max = status?.max ?? 8;
    const online = !!state?.online;
    const full = saved.length >= max;

    return (
        <div className="relative z-10 mx-auto flex h-full w-full max-w-lg flex-col px-4 pt-[max(0.75rem,env(safe-area-inset-top))] md:max-w-xl md:px-8 md:pt-8">
            <header className="relative mb-3 flex h-14 shrink-0 items-center justify-center md:h-16">
                <Link
                    href={`/home/account/devices/${deviceId}`}
                    aria-label="Back to Device Settings"
                    className="absolute left-0 top-1/2 -translate-y-1/2 transition-transform hover:scale-105 active:scale-95"
                >
                    <BackIcon className="h-10 w-10" />
                </Link>
                <h1 className="font-fredoka text-[28px] font-semibold tracking-tight text-gray-900 md:text-[32px]">
                    Wi-Fi
                </h1>
                <button
                    type="button"
                    aria-label="Refresh"
                    disabled={refreshing || busy}
                    onClick={async () => {
                        setRefreshing(true);
                        await load();
                        setRefreshing(false);
                    }}
                    className="absolute right-0 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-white/80 text-gray-500 shadow-sm transition-transform hover:scale-105 active:scale-95 disabled:opacity-60"
                >
                    <RefreshCw className={cn("h-5 w-5", refreshing && "animate-spin")} />
                </button>
            </header>

            <div className="scrollbar-hide flex flex-1 flex-col gap-5 overflow-y-auto pb-[max(2rem,env(safe-area-inset-bottom))]">
                {state === null ? (
                    <div className="flex justify-center py-12">
                        <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
                    </div>
                ) : (
                    <>
                        <div
                            role="status"
                            className={cn(
                                "flex items-start gap-2 rounded-[16px] px-4 py-3 text-sm",
                                online || switching ? "bg-[#FFF6D6] text-gray-800" : "bg-white/80 text-gray-600"
                            )}
                        >
                            {switching ? (
                                <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-[#E9B21F]" />
                            ) : online ? (
                                <Wifi className="mt-0.5 h-4 w-4 shrink-0 text-[#E9B21F]" />
                            ) : (
                                <WifiOff className="mt-0.5 h-4 w-4 shrink-0 text-gray-400" />
                            )}
                            <span>
                                {switching
                                    ? `Moving to "${switching.ssid}"… AI Buddy goes offline for up to half a minute, then this page updates.`
                                    : online
                                    ? "AI Buddy is online."
                                    : "AI Buddy is asleep. Press its button to wake it, and this page will update. Changes can only be made while it is awake."}
                            </span>
                        </div>

                        {!status ? (
                            <p className="px-1 text-sm text-gray-500">
                                AI Buddy hasn&apos;t reported its Wi-Fi yet. It does each time it wakes up.
                            </p>
                        ) : (
                            <>
                                <section>
                                    <h2 className={sectionTitleClass}>
                                        {online ? "Current Wi-Fi" : "Last used Wi-Fi"}
                                    </h2>
                                    <div className={cardClass}>
                                        <div className={rowClass}>
                                            {current ? (
                                                <>
                                                    <CheckCircle2 className="h-5 w-5 shrink-0 fill-[#4FA8F0] text-white" />
                                                    <span className="min-w-0 flex-1 truncate">{current.ssid}</span>
                                                    <SignalIcon rssi={current.rssi} className="h-5 w-5 shrink-0 text-gray-500" />
                                                </>
                                            ) : (
                                                <span className="text-sm text-gray-400">
                                                    {online ? "Not connected" : "Unknown while asleep"}
                                                </span>
                                            )}
                                        </div>
                                    </div>
                                </section>

                                <section>
                                    <div className="mb-2 flex items-center justify-between px-1">
                                        <h2 className="text-base font-semibold text-gray-800">My Wi-Fi</h2>
                                        <span className="text-xs text-gray-400">
                                            {saved.length} / {max}
                                        </span>
                                    </div>
                                    <div className={cn(cardClass, "overflow-hidden")}>
                                        {saved.map((network) => {
                                            const inUse = current?.ssid === network.ssid;
                                            return (
                                                <div key={network.ssid} className={rowClass}>
                                                    <div className="min-w-0 flex-1">
                                                        <p className="truncate">{network.ssid}</p>
                                                        <p className="text-xs text-gray-400">
                                                            {inUse
                                                                ? online ? "In use" : "Last used"
                                                                : network.joined
                                                                    ? "Connected before"
                                                                    : "Not connected yet"}
                                                        </p>
                                                    </div>
                                                    {!inUse && (
                                                        <button
                                                            type="button"
                                                            aria-label={`Use ${network.ssid}`}
                                                            disabled={!online || busy || !!switching}
                                                            onClick={() => setConfirmSwitch(network.ssid)}
                                                            className="flex shrink-0 items-center gap-1 rounded-full px-3 py-1.5 text-sm font-medium text-[#4C74F6] hover:bg-[#EEF3FF] disabled:opacity-40"
                                                        >
                                                            <ArrowRightLeft className="h-4 w-4" />
                                                            Use
                                                        </button>
                                                    )}
                                                    {!inUse && (
                                                        <button
                                                            type="button"
                                                            aria-label={`Remove ${network.ssid}`}
                                                            disabled={!online || busy || !!switching}
                                                            onClick={() => setRemoving(network.ssid)}
                                                            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-gray-400 hover:bg-gray-100 hover:text-[#F25C5C] disabled:opacity-40"
                                                        >
                                                            <Trash2 className="h-4 w-4" />
                                                        </button>
                                                    )}
                                                </div>
                                            );
                                        })}
                                        <button
                                            type="button"
                                            disabled={!online || busy || full || !!switching}
                                            onClick={() => setAdding(true)}
                                            className={cn(rowClass, "w-full text-left hover:bg-gray-50 disabled:cursor-not-allowed disabled:text-gray-300 disabled:hover:bg-transparent")}
                                        >
                                            <Plus className="h-5 w-5 shrink-0" />
                                            {full ? "Wi-Fi list is full" : "Add Wi-Fi"}
                                        </button>
                                    </div>
                                    <p className="mt-2 px-1 text-xs text-gray-400">
                                        AI Buddy stays on its current Wi-Fi unless you tap Use. When
                                        that one is out of range, it joins the strongest saved Wi-Fi nearby.
                                    </p>
                                </section>
                            </>
                        )}
                    </>
                )}
            </div>

            <AddWifiDialog
                open={adding}
                onClose={() => setAdding(false)}
                deviceId={deviceId}
                busy={busy}
                onSave={async (ssid, password) => {
                    const ok = await run(
                        () => deviceWifiAction(deviceId, "add", ssid, password),
                        `Saved "${ssid}" on AI Buddy.`
                    );
                    if (ok) setAdding(false);
                }}
            />

            <Dialog open={confirmSwitch !== null} onOpenChange={(open) => !open && !busy && setConfirmSwitch(null)}>
                <DialogContent className="max-w-[calc(100vw-2rem)] rounded-[24px] sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle>Use &quot;{confirmSwitch}&quot;?</DialogTitle>
                        <DialogDescription>
                            AI Buddy goes offline for a few seconds while it moves, and stops
                            any chat in progress. If &quot;{confirmSwitch}&quot; doesn&apos;t work
                            within 20 seconds, it goes back to
                            {current ? ` "${current.ssid}"` : " its current Wi-Fi"}.
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter className="gap-2">
                        <Button variant="outline" disabled={busy} onClick={() => setConfirmSwitch(null)}>
                            Cancel
                        </Button>
                        <Button disabled={busy} onClick={() => startSwitch(confirmSwitch!)}>
                            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Switch"}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <Dialog open={removing !== null} onOpenChange={(open) => !open && !busy && setRemoving(null)}>
                <DialogContent className="max-w-[calc(100vw-2rem)] rounded-[24px] sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle>Remove &quot;{removing}&quot;?</DialogTitle>
                        <DialogDescription>
                            AI Buddy will forget this Wi-Fi and its password. You can add it again later.
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter className="gap-2">
                        <Button variant="outline" disabled={busy} onClick={() => setRemoving(null)}>
                            Cancel
                        </Button>
                        <Button
                            variant="destructive"
                            disabled={busy}
                            onClick={async () => {
                                const ssid = removing!;
                                await run(
                                    () => deviceWifiAction(deviceId, "delete", ssid),
                                    `Removed "${ssid}".`
                                );
                                setRemoving(null);
                            }}
                        >
                            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Remove"}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}

function AddWifiDialog({
    open,
    onClose,
    deviceId,
    busy,
    onSave,
}: {
    open: boolean;
    onClose: () => void;
    deviceId: string;
    busy: boolean;
    onSave: (ssid: string, password: string) => Promise<void>;
}) {
    const [ssid, setSsid] = useState("");
    const [password, setPassword] = useState("");
    const [scanning, setScanning] = useState(false);
    const [scanError, setScanError] = useState<string | null>(null);
    const [networks, setNetworks] = useState<NonNullable<DeviceWifiState["networks"]> | null>(null);

    // Start clean each time, and never keep a typed password around.
    useEffect(() => {
        if (!open) {
            setSsid("");
            setPassword("");
            setNetworks(null);
            setScanError(null);
        }
    }, [open]);

    const scan = async () => {
        setScanning(true);
        setScanError(null);
        const result = await deviceWifiAction(deviceId, "scan");
        setScanning(false);
        if (result.ok) {
            setNetworks(result.networks ?? []);
        } else {
            setScanError(errorText(result.error));
        }
    };

    const ssidBytes = new TextEncoder().encode(ssid).length;
    const passwordBytes = new TextEncoder().encode(password).length;
    const valid =
        ssidBytes >= 1 && ssidBytes <= 32 && (passwordBytes === 0 || (passwordBytes >= 8 && passwordBytes <= 63));

    return (
        <Dialog open={open} onOpenChange={(next) => !next && !busy && onClose()}>
            <DialogContent className="max-h-[90dvh] max-w-[calc(100vw-2rem)] overflow-y-auto rounded-[24px] sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>Add Wi-Fi</DialogTitle>
                    <DialogDescription>
                        AI Buddy saves it and keeps using its current Wi-Fi for now.
                    </DialogDescription>
                </DialogHeader>
                <form
                    className="flex flex-col gap-4"
                    onSubmit={(event) => {
                        event.preventDefault();
                        if (valid && !busy) onSave(ssid, password);
                    }}
                >
                    <div>
                        <div className="mb-2 flex items-center justify-between">
                            <span className="text-sm font-medium text-gray-600">Nearby Wi-Fi</span>
                            <button
                                type="button"
                                onClick={scan}
                                disabled={scanning || busy}
                                className="flex items-center gap-1 text-sm text-[#4C74F6] disabled:opacity-50"
                            >
                                {scanning ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                                {networks ? "Scan again" : "Scan"}
                            </button>
                        </div>
                        {scanError && <p className="text-xs text-[#D64545]">{scanError}</p>}
                        {networks && networks.length === 0 && (
                            <p className="text-xs text-gray-400">No Wi-Fi found nearby.</p>
                        )}
                        {networks && networks.length > 0 && (
                            <div className="max-h-48 overflow-y-auto rounded-[16px] border border-gray-100">
                                {networks.map((network) => (
                                    <button
                                        key={network.ssid}
                                        type="button"
                                        onClick={() => setSsid(network.ssid)}
                                        className={cn(
                                            "flex w-full items-center gap-2 border-b border-gray-100 px-4 py-2.5 text-left text-sm last:border-b-0 hover:bg-gray-50",
                                            ssid === network.ssid && "bg-[#EEF3FF]"
                                        )}
                                    >
                                        <span className="min-w-0 flex-1 truncate">{network.ssid}</span>
                                        {network.secure && <Lock className="h-3.5 w-3.5 shrink-0 text-gray-400" />}
                                        <SignalIcon rssi={network.rssi} className="h-4 w-4 shrink-0 text-gray-400" />
                                    </button>
                                ))}
                            </div>
                        )}
                        {!networks && !scanError && (
                            <p className="text-xs text-gray-400">
                                Scan to pick from the Wi-Fi AI Buddy can see, or type the name below.
                            </p>
                        )}
                    </div>

                    <label className="block">
                        <span className="mb-2 block text-sm font-medium text-gray-600">Wi-Fi name</span>
                        <input
                            value={ssid}
                            onChange={(e) => setSsid(e.target.value)}
                            autoCapitalize="none"
                            autoCorrect="off"
                            spellCheck={false}
                            placeholder="e.g. Home-WiFi"
                            className={fieldClass}
                        />
                    </label>
                    <label className="block">
                        <span className="mb-2 block text-sm font-medium text-gray-600">Password</span>
                        <input
                            type="password"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            autoComplete="off"
                            placeholder="Leave empty for an open network"
                            className={fieldClass}
                        />
                    </label>

                    <DialogFooter className="gap-2">
                        <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
                            Cancel
                        </Button>
                        <Button type="submit" disabled={!valid || busy}>
                            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save"}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
