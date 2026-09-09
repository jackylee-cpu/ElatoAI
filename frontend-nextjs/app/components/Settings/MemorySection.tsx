"use client";

import React from "react";
import { Button } from "@/components/ui/button";
import {
    Accordion,
    AccordionContent,
    AccordionItem,
    AccordionTrigger,
} from "@/components/ui/accordion";
import { useToast } from "@/components/ui/use-toast";
import { createClient } from "@/utils/supabase/client";
import {
    dbDeleteAllMemories,
    dbDeleteAllMemorySegments,
    dbDeleteMemory,
    dbGetMemories,
    dbGetMemorySegments,
} from "@/db/memories";
import { invalidateMemories } from "@/app/actions";
import { Trash2, Loader2 } from "lucide-react";
import {
    memorySectionTitle,
    memorySectionSubtitle,
    memorySectionEmpty,
    memoryLinesLabel,
    memoryLinesDescription,
} from "@/lib/data";

interface MemorySectionProps {
    selectedUser: IUser;
}

/**
 * What the toy remembers, and the way to take it back.
 *
 * Two layers, shown in the order a parent cares about them. The summaries are
 * what the toy actually reads when it next says hello, and they read like
 * something a person wrote. The utterances underneath are the raw material --
 * questions, corrections, half-sentences that only make sense in context -- and
 * showing those as the answer to "what does it remember" made the feature look
 * broken when it was working.
 *
 * Deleting stays on the raw layer, because that is the layer with teeth: a
 * rebuild only ever replays those rows, so removing one is the only deletion
 * the toy cannot undo. Summaries are derived, and go when the memory revision
 * moves.
 */
const MemorySection: React.FC<MemorySectionProps> = ({ selectedUser }) => {
    const supabase = createClient();
    const { toast } = useToast();
    const [memories, setMemories] = React.useState<IMemory[] | null>(null);
    const [segments, setSegments] = React.useState<IMemorySegment[] | null>(null);
    const [busyId, setBusyId] = React.useState<string | null>(null);

    const load = React.useCallback(async () => {
        try {
            const [loadedSegments, loadedMemories] = await Promise.all([
                dbGetMemorySegments(supabase),
                dbGetMemories(supabase),
            ]);
            setSegments(loadedSegments);
            setMemories(loadedMemories);
        } catch {
            setSegments([]);
            setMemories([]);
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
        // Bump the revision and drop the device session, or the toy keeps the
        // deleted memory in its own working copy until it next reconnects.
        await invalidateMemories();
        await load();
        toast({ description: message });
    };

    const onDelete = async (memoryId: string) => {
        setBusyId(memoryId);
        try {
            await dbDeleteMemory(supabase, memoryId);
            await afterDelete("Forgotten.");
        } catch {
            toast({ description: "Could not delete that memory.", variant: "destructive" });
        } finally {
            setBusyId(null);
        }
    };

    const onDeleteAll = async () => {
        setBusyId("all");
        try {
            // Summaries first. If the second call fails, a parent is left with
            // notes and no lines, which reads as "it still remembers"; the other
            // order leaves lines and no notes, which is merely untidy.
            await dbDeleteAllMemorySegments(supabase, selectedUser.user_id);
            await dbDeleteAllMemories(supabase, selectedUser.user_id);
            await afterDelete("Your toy has forgotten everything.");
        } catch {
            toast({ description: "Could not clear memories.", variant: "destructive" });
        } finally {
            setBusyId(null);
        }
    };

    const loading = segments === null || memories === null;
    const hasAnything =
        (segments?.length ?? 0) > 0 || (memories?.length ?? 0) > 0;

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

            {!loading && segments!.length === 0 && (
                <p className="text-sm text-muted-foreground">{memorySectionEmpty}</p>
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

            {!loading && memories!.length > 0 && (
                <Accordion type="single" collapsible>
                    <AccordionItem value="lines" className="border-b-0">
                        <AccordionTrigger className="text-sm hover:no-underline">
                            {memoryLinesLabel} ({memories!.length})
                        </AccordionTrigger>
                        <AccordionContent className="flex flex-col gap-2">
                            <p className="text-xs text-muted-foreground">
                                {memoryLinesDescription}
                            </p>
                            <ul className="flex flex-col gap-2">
                                {memories!.map((memory) => (
                                    <li
                                        key={memory.memory_id}
                                        className="flex flex-row items-start justify-between gap-3 rounded-lg border p-3"
                                    >
                                        <div className="flex flex-col gap-1">
                                            <span className="text-sm">{memory.content}</span>
                                            <span className="text-xs text-muted-foreground">
                                                {new Date(memory.created_at).toLocaleDateString()}
                                            </span>
                                        </div>
                                        <Button
                                            variant="ghost"
                                            size="icon"
                                            aria-label="Delete this line"
                                            onClick={() => onDelete(memory.memory_id)}
                                            disabled={busyId !== null}
                                        >
                                            {busyId === memory.memory_id ? (
                                                <Loader2 className="animate-spin" size={14} />
                                            ) : (
                                                <Trash2 size={14} />
                                            )}
                                        </Button>
                                    </li>
                                ))}
                            </ul>
                        </AccordionContent>
                    </AccordionItem>
                </Accordion>
            )}
        </div>
    );
};

export default MemorySection;
