"use client";

import React from "react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/use-toast";
import { createClient } from "@/utils/supabase/client";
import {
    dbDeleteMemoryFact,
    dbGetMemoryFacts,
    dbGetMemorySegments,
} from "@/db/memories";
import { getUserDevices } from "@/db/devices";
import { clearDeviceMemoryAction, invalidateMemories } from "@/app/actions";
import { Trash2, Loader2 } from "lucide-react";
import {
    memorySectionTitle,
    memorySectionSubtitle,
    memorySectionEmpty,
    memoryFactsLabel,
    memoryFactsDescription,
    memoryNotesLabel,
    memoryNoDevice,
} from "@/lib/data";
import { cn } from "@/lib/utils";

interface MemorySectionProps {
    selectedUser: IUser;
    /** Bumped when a device is claimed or unbound, to re-list them. */
    devicesVersion?: number;
}

type Device = Awaited<ReturnType<typeof getUserDevices>>[number];

/**
 * What the toy remembers, and the way to take it back.
 *
 * Two layers, shown in the order a parent cares about them. The facts are who
 * the toy thinks the child is -- a name, a pet, a favourite thing -- and they
 * are in its mind for every conversation, so each one can be deleted on its
 * own. The notes underneath are what each conversation was about; the latest
 * couple are what the toy reads when it next says hello.
 *
 * Memory belongs to a device: each toy remembers its own child. With more
 * than one on the account, the parent picks which toy to look at.
 */
const MemorySection: React.FC<MemorySectionProps> = ({ selectedUser, devicesVersion }) => {
    const supabase = createClient();
    const { toast } = useToast();
    const [devices, setDevices] = React.useState<Device[] | null>(null);
    const [deviceId, setDeviceId] = React.useState<string | null>(null);
    const [segments, setSegments] = React.useState<IMemorySegment[] | null>(null);
    const [facts, setFacts] = React.useState<IMemoryFact[] | null>(null);
    const [busyId, setBusyId] = React.useState<string | null>(null);

    React.useEffect(() => {
        let cancelled = false;
        getUserDevices(supabase, selectedUser.user_id)
            .then((loaded) => {
                if (cancelled) return;
                setDevices(loaded);
                // Keep the toy being looked at while it is still on the account.
                setDeviceId((current) =>
                    loaded.some((d) => d.device_id === current)
                        ? current
                        : loaded[0]?.device_id ?? null
                );
            })
            .catch(() => {
                if (!cancelled) setDevices([]);
            });
        return () => {
            cancelled = true;
        };
    }, [supabase, selectedUser.user_id, devicesVersion]);

    const load = React.useCallback(async () => {
        if (!deviceId) {
            setFacts([]);
            setSegments([]);
            return;
        }
        setFacts(null);
        setSegments(null);
        try {
            const [loadedFacts, loadedSegments] = await Promise.all([
                dbGetMemoryFacts(supabase, deviceId),
                dbGetMemorySegments(supabase, deviceId),
            ]);
            setFacts(loadedFacts);
            setSegments(loadedSegments);
        } catch {
            setFacts([]);
            setSegments([]);
            toast({
                description: "Could not load what your toy remembers.",
                variant: "destructive",
            });
        }
    }, [supabase, toast, deviceId]);

    React.useEffect(() => {
        if (devices !== null) void load();
    }, [load, devices]);

    const afterDelete = async (message: string) => {
        // The toy read its memory into the prompt when it connected. Dropping
        // the device session makes it read again now, without what was deleted.
        await invalidateMemories();
        await load();
        toast({ description: message });
    };

    const onDeleteFact = async (factId: string) => {
        setBusyId(factId);
        try {
            await dbDeleteMemoryFact(supabase, factId);
            await afterDelete("Forgotten.");
        } catch {
            toast({ description: "Could not delete that.", variant: "destructive" });
        } finally {
            setBusyId(null);
        }
    };

    const onDeleteAll = async () => {
        if (!deviceId) return;
        setBusyId("all");
        try {
            // One transaction on the server, transcript included, and the toy's
            // live session is dropped so it cannot write any of it back.
            if (!await clearDeviceMemoryAction(deviceId)) {
                throw new Error("clear failed");
            }
            await load();
            toast({ description: "This toy has forgotten everything." });
        } catch {
            toast({ description: "Could not clear memories.", variant: "destructive" });
        } finally {
            setBusyId(null);
        }
    };

    const loading = devices === null || facts === null || segments === null;
    const hasAnything = (facts?.length ?? 0) > 0 || (segments?.length ?? 0) > 0;

    return (
        <div className="flex flex-col gap-3 max-w-screen-sm">
            <div className="flex flex-row items-start justify-between gap-4">
                <div className="flex flex-col gap-1">
                    <h2 className="text-xl font-normal">{memorySectionTitle}</h2>
                    <p className="text-sm text-muted-foreground">
                        {memorySectionSubtitle}
                    </p>
                </div>
                {hasAnything && (
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={onDeleteAll}
                        disabled={busyId !== null}
                    >
                        {busyId === "all" ? (
                            <Loader2 className="animate-spin" size={14} />
                        ) : (
                            "Clear all"
                        )}
                    </Button>
                )}
            </div>

            {devices !== null && devices.length > 1 && (
                <div className="flex flex-row flex-wrap gap-2">
                    {devices.map((device) => (
                        <button
                            key={device.device_id}
                            type="button"
                            onClick={() => setDeviceId(device.device_id)}
                            disabled={busyId !== null}
                            className={cn(
                                "rounded-full border px-3 py-1 text-xs transition-colors",
                                device.device_id === deviceId
                                    ? "border-gray-900 bg-gray-900 text-white"
                                    : "border-gray-200 text-gray-600 hover:border-gray-400"
                            )}
                        >
                            Device {device.user_code}
                        </button>
                    ))}
                </div>
            )}

            {loading && (
                <Loader2 className="animate-spin text-muted-foreground" size={16} />
            )}

            {devices !== null && devices.length === 0 && (
                <p className="text-sm text-muted-foreground">{memoryNoDevice}</p>
            )}

            {!loading && deviceId && facts!.length === 0 && segments!.length === 0 && (
                <p className="text-sm text-muted-foreground">{memorySectionEmpty}</p>
            )}

            {!loading && facts!.length > 0 && (
                <div className="flex flex-col gap-2">
                    <div className="flex flex-col gap-0.5">
                        <h3 className="text-sm font-medium">{memoryFactsLabel}</h3>
                        <p className="text-xs text-muted-foreground">
                            {memoryFactsDescription}
                        </p>
                    </div>
                    <ul className="flex flex-col gap-2">
                        {facts!.map((fact) => (
                            <li
                                key={fact.fact_id}
                                className="flex flex-row items-start justify-between gap-3 rounded-lg border p-3"
                            >
                                <div className="flex flex-col gap-1">
                                    <span className="text-sm">{fact.content}</span>
                                    <span className="text-xs text-muted-foreground">
                                        {new Date(fact.created_at).toLocaleDateString()}
                                    </span>
                                </div>
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    aria-label="Forget this"
                                    onClick={() => onDeleteFact(fact.fact_id)}
                                    disabled={busyId !== null}
                                >
                                    {busyId === fact.fact_id ? (
                                        <Loader2 className="animate-spin" size={14} />
                                    ) : (
                                        <Trash2 size={14} />
                                    )}
                                </Button>
                            </li>
                        ))}
                    </ul>
                </div>
            )}

            {!loading && segments!.length > 0 && facts!.length > 0 && (
                <h3 className="text-sm font-medium pt-2">{memoryNotesLabel}</h3>
            )}

            {!loading && segments!.length > 0 && (
                <ul className="flex flex-col gap-2">
                    {segments!.map((segment) => (
                        <li
                            key={segment.segment_id}
                            className="flex flex-col gap-1 rounded-lg border p-3"
                        >
                            <span className="text-sm">{segment.summary}</span>
                            <span className="text-xs text-muted-foreground">
                                {new Date(segment.created_at).toLocaleDateString()}
                            </span>
                        </li>
                    ))}
                </ul>
            )}

        </div>
    );
};

export default MemorySection;
