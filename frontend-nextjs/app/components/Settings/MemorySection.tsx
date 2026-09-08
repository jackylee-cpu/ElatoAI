"use client";

import React from "react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/use-toast";
import { createClient } from "@/utils/supabase/client";
import { dbDeleteAllMemories, dbDeleteMemory, dbGetMemories } from "@/db/memories";
import { invalidateMemories } from "@/app/actions";
import { Trash2, Loader2 } from "lucide-react";
import {
    memorySectionTitle,
    memorySectionSubtitle,
    memorySectionEmpty,
} from "@/lib/data";

interface MemorySectionProps {
    selectedUser: IUser;
}

/**
 * What the toy remembers, and the way to take it back.
 *
 * Long-term memory is on by default, so this is not optional furniture: a
 * parent has to be able to see what a device has retained about their child and
 * remove any of it. Deleting here erases the memory for real -- a rebuild only
 * ever replays these rows.
 */
const MemorySection: React.FC<MemorySectionProps> = ({ selectedUser }) => {
    const supabase = createClient();
    const { toast } = useToast();
    const [memories, setMemories] = React.useState<IMemory[] | null>(null);
    const [busyId, setBusyId] = React.useState<string | null>(null);

    const load = React.useCallback(async () => {
        try {
            setMemories(await dbGetMemories(supabase));
        } catch {
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
            await dbDeleteAllMemories(supabase, selectedUser.user_id);
            await afterDelete("Your toy has forgotten everything.");
        } catch {
            toast({ description: "Could not clear memories.", variant: "destructive" });
        } finally {
            setBusyId(null);
        }
    };

    return (
        <div className="flex flex-col gap-3 max-w-screen-sm">
            <div className="flex flex-row items-start justify-between gap-4">
                <div className="flex flex-col gap-1">
                    <h2 className="text-xl font-normal">{memorySectionTitle}</h2>
                    <p className="text-sm text-muted-foreground">
                        {memorySectionSubtitle}
                    </p>
                </div>
                {memories && memories.length > 0 && (
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

            {memories === null && (
                <Loader2 className="animate-spin text-muted-foreground" size={16} />
            )}

            {memories !== null && memories.length === 0 && (
                <p className="text-sm text-muted-foreground">{memorySectionEmpty}</p>
            )}

            {memories !== null && memories.length > 0 && (
                <ul className="flex flex-col gap-2">
                    {memories.map((memory) => (
                        <li
                            key={memory.memory_id}
                            className="flex flex-row items-start justify-between gap-3 rounded-lg border p-3"
                        >
                            <div className="flex flex-col gap-1">
                                <span className="text-sm">{memory.content}</span>
                                <span className="text-xs text-muted-foreground">
                                    {new Date(memory.created_at).toLocaleDateString()}
                                    {memory.source_personality_key
                                        ? ` · with ${memory.source_personality_key}`
                                        : ""}
                                </span>
                            </div>
                            <Button
                                variant="ghost"
                                size="icon"
                                aria-label="Delete this memory"
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
            )}
        </div>
    );
};

export default MemorySection;
