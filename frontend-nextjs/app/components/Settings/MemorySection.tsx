"use client";

import React from "react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/use-toast";
import { createClient } from "@/utils/supabase/client";
import {
    dbDeleteAllMemories,
    dbDeleteAllMemoryFacts,
    dbDeleteAllMemorySegments,
    dbDeleteMemoryFact,
    dbGetMemoryFacts,
    dbGetMemorySegments,
} from "@/db/memories";
import { invalidateMemories } from "@/app/actions";
import { Trash2, Loader2 } from "lucide-react";
import {
    memorySectionTitle,
    memorySectionSubtitle,
    memorySectionEmpty,
    memoryFactsLabel,
    memoryFactsDescription,
    memoryNotesLabel,
} from "@/lib/data";

interface MemorySectionProps {
    selectedUser: IUser;
}

/**
 * What the toy remembers, and the way to take it back.
 *
 * Two layers, shown in the order a parent cares about them. The facts are who
 * the toy thinks the child is -- a name, a pet, a favourite thing -- and they
 * are in its mind for every conversation, so each one can be deleted on its
 * own. The notes underneath are what each conversation was about; the latest
 * couple are what the toy reads when it next says hello.
 *
 * The raw lines the old memory store kept (`memories`) are no longer shown:
 * nothing reads them since that store was removed, and "Clear all" still
 * wipes them.
 */
const MemorySection: React.FC<MemorySectionProps> = ({ selectedUser }) => {
    const supabase = createClient();
    const { toast } = useToast();
    const [segments, setSegments] = React.useState<IMemorySegment[] | null>(null);
    const [facts, setFacts] = React.useState<IMemoryFact[] | null>(null);
    const [busyId, setBusyId] = React.useState<string | null>(null);

    const load = React.useCallback(async () => {
        try {
            const [loadedFacts, loadedSegments] = await Promise.all([
                dbGetMemoryFacts(supabase),
                dbGetMemorySegments(supabase),
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
    }, [supabase, toast]);

    React.useEffect(() => {
        void load();
    }, [load]);

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
        setBusyId("all");
        try {
            // What the toy reads first. If a later call fails, a parent is left
            // with leftovers the toy never reads, which is merely untidy; the
            // other order leaves facts behind, which reads as "it still
            // remembers". `memories` is the old store's raw lines, cleared here
            // so "Clear all" means it.
            await dbDeleteAllMemoryFacts(supabase, selectedUser.user_id);
            await dbDeleteAllMemorySegments(supabase, selectedUser.user_id);
            await dbDeleteAllMemories(supabase, selectedUser.user_id);
            await afterDelete("Your toy has forgotten everything.");
        } catch {
            toast({ description: "Could not clear memories.", variant: "destructive" });
        } finally {
            setBusyId(null);
        }
    };

    const loading = facts === null || segments === null;
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

            {loading && (
                <Loader2 className="animate-spin text-muted-foreground" size={16} />
            )}

            {!loading && facts!.length === 0 && segments!.length === 0 && (
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
